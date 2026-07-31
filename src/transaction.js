/**
 * The atomic chat-history transaction (§12, §17.1).
 *
 *   Original assistant message  →  Assistant prefix / User insertion / Assistant revised suffix
 *
 * Every step is journaled; any failure restores the complete original message,
 * swipes, and metadata from the snapshot. Rollback is idempotent and refuses to
 * touch messages it cannot prove belong to the transaction.
 */

import { resolveAnchor } from './anchors.js';
import {
    GENERATION_TIMEOUT_MS,
    INTERCEDE_EVENTS,
    JOURNAL_STAGE,
    METADATA_KEY,
    REWRITE_MODES,
    TX_STATE,
} from './constants.js';
import { PreflightError, RecoveryRequiredError } from './errors.js';
import { emitIntercedeEvent } from './events.js';
import { beginAssistantCapture, proveGeneratedSuffix } from './generation-capture.js';
import {
    armLease,
    closeLeaseAudit,
    disarmLease,
    getGenerationStartSequence,
    getLeaseReceipt,
    isGenerationActive,
    resetStoppedFlag,
    wasGenerationStopped,
} from './lease.js';
import {
    clearOwnedMarker,
    createOwnership,
    getIntercedeMarker,
    hasKnownRole,
    isOwnedMessage,
    markOwnedMessage,
    OWNED_ROLE,
} from './ownership.js';
import { buildRewritePrompt } from './prompt.js';
import { splitAtOffset } from './segmentation.js';
import {
    deleteMessageAt,
    getChatMetadata,
    getCtx,
    getCurrentChatId,
    getEventSource,
    getEventTypes,
    isGroupChat,
    persistChatAndMetadata,
} from './stcontext.js';
import { hashText, normalizeForComparison, notify, uuid, waitUntil } from './utils.js';
import { showConfirm } from './ui/modal.js';
import { qualityWarnings, validateOwnedStructure } from './validator.js';
import {
    clearJournal,
    clearJournalStrict,
    readJournal,
    updateJournal,
    updateJournalStrict,
    vaultDelete,
    vaultDeleteStrict,
    vaultGet,
    vaultKeyFor,
    vaultPut,
    vaultPutStrict,
    vaultRecordExists,
    writeJournalStrict,
} from './vault.js';

/** @type {IntercedeTransaction | null} */
let activeTransaction = null;

/**
 * Set when a transaction could not prove ownership of its own messages. New
 * intercessions are blocked until the user resolves it, because starting
 * another one on top of an ambiguous chat compounds the problem (§5.7).
 */
let recoveryRequired = false;

export function isRecoveryRequired() {
    return recoveryRequired;
}

export function clearRecoveryRequired() {
    recoveryRequired = false;
}

export function hasActiveTransaction() {
    return activeTransaction !== null;
}

export function getActiveTransaction() {
    return activeTransaction;
}

/** Compact per-chat metadata container (chatMetadata.intercede). */
export function getMetaContainer(ctx = getCtx()) {
    const meta = getChatMetadata(ctx);
    if (!meta) return null;
    if (!meta[METADATA_KEY] || typeof meta[METADATA_KEY] !== 'object') {
        meta[METADATA_KEY] = { version: 1, transactions: {} };
    }
    if (!meta[METADATA_KEY].transactions) meta[METADATA_KEY].transactions = {};
    return meta[METADATA_KEY];
}

/** The Intercede marker a message carries, or null. */
function readMarker(message) {
    const marker = message?.extra?.[METADATA_KEY];
    return (marker && typeof marker === 'object' && marker.transactionId) ? marker : null;
}

/** Read the transaction table without materializing the container. */
function readTransactions(ctx) {
    return getChatMetadata(ctx)?.[METADATA_KEY]?.transactions ?? null;
}

/**
 * Capture chatMetadata.intercede exactly as it is before the transaction
 * touches it (§6.2, INV-06).
 *
 * This deliberately does not go through getMetaContainer(), which materializes
 * the container as a side effect of reading. Whether the property existed at
 * all is part of the state being preserved: a chat that had no Intercede
 * metadata must still have none after a rollback.
 */
function snapshotIntercedeMetadata(ctx) {
    const metadata = getChatMetadata(ctx);
    const existed = Boolean(metadata) && Object.prototype.hasOwnProperty.call(metadata, METADATA_KEY);
    return {
        existed,
        value: existed ? structuredClone(metadata[METADATA_KEY]) : null,
    };
}

function restoreIntercedeMetadata(ctx, snapshot) {
    const metadata = getChatMetadata(ctx);
    if (!metadata || !snapshot) return;

    if (!snapshot.existed) {
        delete metadata[METADATA_KEY];
    } else {
        metadata[METADATA_KEY] = structuredClone(snapshot.value);
    }
}

/**
 * §12.9 — where a prospective target sits in an intercession chain.
 *
 * Interceding the revised continuation of an earlier intercession is a normal
 * operation: the continuation is an ordinary assistant message that happens to
 * carry a `suffix` marker, and cutting it starts a new transaction whose prefix
 * is that continuation. `depth` counts how many intercessions deep the new one
 * would be (0 = interceding a message no intercession produced).
 *
 * @returns {{ parentTransactionId: string | null, depth: number }}
 */
export function getChainPosition(ctx = getCtx(), index = undefined) {
    const chat = ctx?.chat;
    if (!Array.isArray(chat) || !chat.length) return { parentTransactionId: null, depth: 0 };
    const targetIndex = index ?? chat.length - 1;
    const marker = readMarker(chat[targetIndex]);
    if (!marker || marker.role !== 'suffix') return { parentTransactionId: null, depth: 0 };
    const record = readTransactions(ctx)?.[marker.transactionId];
    if (!record || record.state !== 'committed') return { parentTransactionId: null, depth: 0 };
    return { parentTransactionId: marker.transactionId, depth: (record.chainDepth ?? 0) + 1 };
}

/**
 * The committed records a transaction is built on, oldest first — the chain
 * that produced the message it cut. Walks the `parentTransactionId` links and
 * stops on a missing or repeated link rather than looping.
 */
export function getChainAncestry(ctx = getCtx(), transactionId) {
    const transactions = readTransactions(ctx);
    const ancestry = [];
    const seen = new Set();
    let id = transactions?.[transactionId]?.parentTransactionId ?? null;
    while (id && transactions?.[id] && !seen.has(id)) {
        seen.add(id);
        ancestry.unshift({ transactionId: id, ...transactions[id] });
        id = transactions[id].parentTransactionId ?? null;
    }
    return ancestry;
}

/**
 * Version-one eligibility: the latest, completed, non-system assistant message
 * in a non-group chat, while nothing is generating. A revised continuation left
 * by an earlier intercession qualifies like any other assistant message.
 * @returns {{ ok: boolean, reason?: string, targetIndex?: number, message?: object, chain?: { parentTransactionId: string | null, depth: number } }}
 */
export function isEligibleTarget(ctx = getCtx(), index = undefined) {
    if (!ctx || !Array.isArray(ctx.chat) || ctx.chat.length === 0) {
        return { ok: false, reason: 'No chat is open.' };
    }
    const targetIndex = index ?? ctx.chat.length - 1;
    if (targetIndex !== ctx.chat.length - 1) {
        return { ok: false, reason: 'Only the latest message can be interceded in this version.' };
    }
    const message = ctx.chat[targetIndex];
    if (!message) return { ok: false, reason: 'Message not found.' };
    if (message.is_user) return { ok: false, reason: 'The latest message is yours — intercede targets the character\'s message.' };
    if (message.is_system) return { ok: false, reason: 'System messages cannot be interceded.' };
    if (isGroupChat(ctx)) return { ok: false, reason: 'Group chats are not supported yet.' };
    if (!String(message.mes ?? '').trim()) return { ok: false, reason: 'The message is empty.' };
    if (isGenerationActive()) return { ok: false, reason: 'Wait for the current generation to finish.' };
    if (recoveryRequired) return { ok: false, reason: 'An earlier intercession needs review. Run /intercede recover first.' };
    if (activeTransaction) return { ok: false, reason: 'Another intercession is already in progress.' };
    return { ok: true, targetIndex, message, chain: getChainPosition(ctx, targetIndex) };
}

function removeMessageNode(index) {
    document.querySelector(`#chat .mes[mesid="${index}"]`)?.remove();
}

/** Fully re-render a restored message (text, swipe counters, timestamps). */
function reAddMessage(ctx, index, message) {
    removeMessageNode(index);
    try {
        ctx.addOneMessage(message, { forceId: index, scroll: true });
    } catch (error) {
        console.warn('[Intercede] addOneMessage failed, falling back to updateMessageBlock', error);
        try {
            ctx.updateMessageBlock?.(index, message);
        } catch { /* rendering is best-effort; canonical state is already correct */ }
    }
}

function messageTimestamp() {
    const moment = globalThis.moment;
    if (moment) {
        try {
            return moment().format('MMMM D, YYYY h:mma');
        } catch { /* fall through */ }
    }
    return new Date().toLocaleString();
}

/**
 * Delete the messages a transaction created, and nothing else (§5.6, INV-05).
 *
 * Each candidate must satisfy two independent proofs: the object reference
 * captured when the transaction created it is still present in the chat, and
 * that object still carries this transaction's marker in an expected role. A
 * reference that has already gone is fine — that is what makes repeated
 * rollbacks idempotent. A reference that is present but no longer marked is
 * not fine, and stops the rollback rather than removing a message somebody else
 * may now own.
 */
async function removeOwnedMessages(ctx, ownership) {
    const candidates = [
        { ref: ownership.suffixRef, roles: [OWNED_ROLE.SUFFIX_PENDING, OWNED_ROLE.SUFFIX] },
        { ref: ownership.insertionRef, roles: [OWNED_ROLE.INSERTION] },
    ];

    const indexes = new Set();
    for (const { ref, roles } of candidates) {
        if (!ref) continue;
        const index = ctx.chat.indexOf(ref);
        if (index < 0) continue;

        const marker = getIntercedeMarker(ref);
        if (marker?.transactionId !== ownership.transactionId || !roles.includes(marker.role)) {
            throw new RecoveryRequiredError(
                'A message this intercession created no longer carries its ownership marker.',
                { transactionId: ownership.transactionId, index },
            );
        }
        indexes.add(index);
    }

    for (const index of [...indexes].sort((a, b) => b - a)) {
        await deleteMessageAt(ctx, index);
    }
}

function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); },
        );
    });
}

export class IntercedeTransaction {
    /**
     * @param {object} options
     * @param {number} options.targetIndex
     * @param {import('./anchors.js').SourceAnchor} options.anchor
     * @param {string} options.insertionText
     * @param {string} [options.rewriteMode]
     */
    constructor({ targetIndex, anchor, insertionText, rewriteMode }) {
        this.transactionId = uuid();
        this.state = TX_STATE.ARMED;
        this.targetIndex = targetIndex;
        this.anchor = anchor;
        this.insertion = String(insertionText ?? '').trim();
        this.rewriteMode = rewriteMode ?? REWRITE_MODES.ADAPTIVE;
        this.chatId = null;
        this.prefix = null;
        this.suffix = null;
        this.snapshotMessage = null;
        this.vaultKey = null;
        /** Proof of which messages this transaction created (§5.2). */
        this.ownership = null;
        /** chatMetadata.intercede as it was before this transaction ran. */
        this.metadataSnapshot = null;
        /** Filled in by preflight; non-zero when the target is itself a revised continuation. */
        this.chain = { parentTransactionId: null, depth: 0 };
        this.result = { warnings: [], preservation: null };
        this._rollingBack = false;
        /**
         * True once canonical chat state has actually been changed. Rollback
         * keys off this rather than off the snapshot, so a transaction that
         * aborted while arming its own journal never clears or restores state
         * that belongs to somebody else.
         */
        this._mutated = false;
    }

    /**
     * Execute the full transaction. Resolves with a summary on commit; rolls back
     * and rethrows on any failure.
     */
    async run() {
        if (activeTransaction) throw new Error('Another intercession is already in progress.');
        activeTransaction = this;
        try {
            this.preflight();
            await this.snapshot();
            await this.applyPrefix();
            await this.insertUserMessage();
            await this.generateSuffix();
            const validation = await this.validate();
            if (!validation.ok) {
                throw new Error(validation.fatal.join(' ') || 'Validation failed.');
            }
            await this.commit();
            return {
                ok: true,
                transactionId: this.transactionId,
                warnings: this.result.warnings,
                preservation: this.result.preservation,
            };
        } catch (error) {
            await this.rollback(error);
            throw error;
        } finally {
            disarmLease();
            activeTransaction = null;
        }
    }

    /** §12.3 — every precondition, checked immediately before mutation. */
    preflight() {
        const ctx = getCtx();
        const eligible = isEligibleTarget(ctx, this.targetIndex);
        if (!eligible.ok && eligible.reason !== 'Another intercession is already in progress.') {
            throw new Error(eligible.reason);
        }
        if (!this.insertion) throw new Error('The response text is empty.');
        if (document.getElementById('curEditTextarea')) {
            throw new Error('Close the open message editor first.');
        }
        this.chatId = getCurrentChatId(ctx);
        if (this.chatId === null || this.chatId === undefined) throw new Error('No active chat.');
        this.chain = getChainPosition(ctx, this.targetIndex);

        const raw = String(ctx.chat[this.targetIndex].mes ?? '');
        const resolved = resolveAnchor(raw, this.anchor);
        if (!resolved.ok) throw new Error(resolved.reason);
        if (resolved.rebased) {
            notify('info', 'The message changed after selection — the cut was rebased to the same context.');
        }
        const { prefix, suffix } = splitAtOffset(raw, resolved.offset);
        if (!prefix.trim() || !suffix.trim()) {
            throw new Error('The selected boundary no longer splits the message into two parts.');
        }
        this.prefix = prefix;
        this.suffix = suffix;
    }

    /**
     * §12.4 / §19 — complete original message into the vault, journal armed.
     *
     * Nothing below may fail quietly. If the journal or the vault cannot be
     * proven durable, the transaction aborts here, with the chat untouched —
     * that is strictly better than mutating a message whose only backup might
     * not survive a reload (INV-07).
     */
    async snapshot() {
        const ctx = getCtx();
        const original = ctx.chat[this.targetIndex];

        this.metadataSnapshot = snapshotIntercedeMetadata(ctx);
        try {
            this.snapshotMessage = structuredClone(original);
        } catch (error) {
            throw new PreflightError(
                `The message could not be snapshotted (another extension may have attached non-cloneable data): ${error?.message ?? error}`,
            );
        }
        this.vaultKey = vaultKeyFor(this.chatId, this.transactionId);
        this.originalChatLength = ctx.chat.length;
        this.ownership = createOwnership(this.transactionId, this.targetIndex, this.originalChatLength);
        this.ownership.prefixRef = original;

        writeJournalStrict({
            transactionId: this.transactionId,
            chatId: this.chatId,
            stage: JOURNAL_STAGE.ABOUT_TO_MUTATE,
            vaultKey: this.vaultKey,
            targetIndex: this.targetIndex,
            expectedTargetHash: hashText(String(original.mes ?? '')),
            originalChatLength: this.originalChatLength,
            startedAt: Date.now(),
        });

        await vaultPutStrict(this.vaultKey, {
            state: 'snapshotted',
            transactionId: this.transactionId,
            chatId: this.chatId,
            targetIndex: this.targetIndex,
            originalChatLength: this.originalChatLength,
            completeOriginalMessage: this.snapshotMessage,
            metadataSnapshot: this.metadataSnapshot,
            discardedSuffix: this.suffix,
            prefix: this.prefix,
            insertion: this.insertion,
            rewriteMode: this.rewriteMode,
            anchor: this.anchor,
            parentTransactionId: this.chain.parentTransactionId,
            chainDepth: this.chain.depth,
            createdAt: Date.now(),
        });

        updateJournalStrict({ stage: JOURNAL_STAGE.SNAPSHOTTED });
        this.state = TX_STATE.SNAPSHOTTED;
    }

    /** §12.5 steps 1–3 — the original message becomes the preserved prefix. */
    async applyPrefix() {
        const ctx = getCtx();
        const message = ctx.chat[this.targetIndex];
        message.mes = this.prefix;
        if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id) && message.swipes[message.swipe_id] !== undefined) {
            message.swipes[message.swipe_id] = this.prefix;
        }
        // A chained target already carries its own marker (it is some earlier
        // transaction's revised continuation). markOwnedMessage keeps that
        // provenance beside the new one so the earlier transaction stays
        // identifiable from the message itself, not only from the snapshot that
        // undo restores.
        markOwnedMessage(message, this.transactionId, OWNED_ROLE.PREFIX);
        this._mutated = true;

        try {
            ctx.updateMessageBlock(this.targetIndex, message);
        } catch (error) {
            console.warn('[Intercede] updateMessageBlock failed', error);
        }
        const eventTypes = getEventTypes(ctx);
        if (eventTypes.MESSAGE_UPDATED) {
            await getEventSource(ctx)?.emit(eventTypes.MESSAGE_UPDATED, this.targetIndex);
        }

        updateJournalStrict({ stage: JOURNAL_STAGE.PREFIX_APPLIED });
        this.state = TX_STATE.MUTATED;
    }

    /** §12.5 step 4 — a genuine user-role message, via the most native path available. */
    async insertUserMessage() {
        const ctx = getCtx();
        const before = ctx.chat.length;

        if (typeof ctx.sendMessageAsUser === 'function') {
            await ctx.sendMessageAsUser(this.insertion, '');
        } else {
            const message = {
                name: ctx.name1 ?? 'You',
                is_user: true,
                is_system: false,
                send_date: messageTimestamp(),
                mes: this.insertion,
                extra: {},
            };
            ctx.chat.push(message);
            const eventTypes = getEventTypes(ctx);
            const eventSource = getEventSource(ctx);
            if (eventTypes.MESSAGE_SENT) await eventSource?.emit(eventTypes.MESSAGE_SENT, ctx.chat.length - 1);
            ctx.addOneMessage(message);
            if (eventTypes.USER_MESSAGE_RENDERED) await eventSource?.emit(eventTypes.USER_MESSAGE_RENDERED, ctx.chat.length - 1);
        }

        if (ctx.chat.length !== before + 1 || !ctx.chat[before]?.is_user) {
            throw new Error('Failed to insert the user message.');
        }
        const inserted = ctx.chat[before];
        markOwnedMessage(inserted, this.transactionId, OWNED_ROLE.INSERTION);
        this.ownership.insertionRef = inserted;

        updateJournalStrict({ stage: JOURNAL_STAGE.USER_INSERTED });
    }

    /** §11 — normal SillyTavern generation under a one-generation lease. */
    async generateSuffix() {
        const ctx = getCtx();
        this.state = TX_STATE.GENERATING;
        resetStoppedFlag();

        armLease({
            transactionId: this.transactionId,
            chatId: this.chatId,
            kinds: ['normal'],
            prompt: buildRewritePrompt({ suffix: this.suffix, mode: this.rewriteMode }),
        });
        updateJournalStrict({ stage: JOURNAL_STAGE.GENERATION_STARTED });

        // Identify the continuation by the event that announces it, not by its
        // position afterwards: the tail may belong to another extension by the
        // time generation ends (INV-03).
        const capture = beginAssistantCapture(ctx, { chatId: this.chatId });
        const sequenceBeforeCall = getGenerationStartSequence();

        let candidates = [];
        let generationError = null;
        try {
            const generation = ctx.generate();
            if (generation && typeof generation.then === 'function') {
                await withTimeout(generation, GENERATION_TIMEOUT_MS, 'Generation timed out.');
            }
            // Settle: some backends resolve slightly before the reply is appended.
            await waitUntil(() => !isGenerationActive(), 8000, 100);
        } catch (error) {
            generationError = error;
        } finally {
            candidates = capture.finish();
            closeLeaseAudit(this.transactionId);
            disarmLease();
        }

        // Can the reply be attributed to *this* call at all?
        //
        // Structural position is not enough when more than one matching
        // generation ran: the single message that arrived at the expected index
        // may well be the other one's. Attribution is therefore settled before
        // anything is marked, so an unattributable message is never claimed and
        // never deleted.
        const receipt = getLeaseReceipt(this.transactionId);
        const attributable = receipt?.matchingStarts === 1
            && (receipt.appliedSequence === null || receipt.appliedSequence > sequenceBeforeCall);

        this.ownership.suffixIndex = null;
        this.ownership.suffixRef = null;
        let proofError = null;

        if (attributable) {
            // Claim whenever ownership is provable — including when generation
            // failed afterwards. A message this transaction created must be
            // removable by its own rollback, or it is stranded in the chat.
            try {
                const proven = proveGeneratedSuffix({ candidates, chat: ctx.chat, ownership: this.ownership });
                this.ownership.suffixIndex = proven.index;
                this.ownership.suffixRef = proven.message;
            } catch (error) {
                proofError = error;
            }
        }

        if (generationError) throw generationError;

        if (!attributable) {
            const detail = !receipt
                ? 'the generation lease left no record'
                : `${receipt.matchingStarts} matching generations ran while this intercession was waiting`;
            throw new RecoveryRequiredError(
                `The reply cannot be attributed to this intercession (${detail}), so nothing was claimed, changed further, or deleted.`,
                { transactionId: this.transactionId },
            );
        }
        if (proofError) throw proofError;

        // The instruction was installed for this generation and then removed
        // again before SillyTavern assembled the prompt, because a generation
        // Intercede did not start began in between. `applied` is true and says
        // nothing about it. The reply is ours and provably so — hence a plain
        // error and a clean selective rollback rather than recovery-required.
        if (receipt.promptIntegrityLost) {
            // An already-running generation leaves no interfering start to name.
            const kinds = [...new Set(receipt.interferingStarts.map(start => start.kind))];
            const detail = kinds.length ? ` (${kinds.join(', ')})` : ' that was already running';
            throw new Error(
                `Another generation${detail} overlapped this intercession and removed the rewrite instruction before it could be used, so the continuation was written without it. Nothing was committed.`,
            );
        }

        // Exactly one matching generation ran and it is ours, but the rewrite
        // instruction never reached it — the reply is an ordinary continuation
        // that would otherwise commit silently. Ownership *is* proven here, so
        // a clean selective rollback is the right outcome.
        if (!receipt.applied) {
            throw new Error(
                'The rewrite instruction was never applied to this generation, so the continuation was written without it. Nothing was committed.',
            );
        }

        updateJournalStrict({ stage: JOURNAL_STAGE.GENERATION_RETURNED });
    }

    /** §12.6 — structural checks are fatal; quality checks warn. */
    async validate() {
        const ctx = getCtx();
        this.state = TX_STATE.VALIDATING;

        if (getCurrentChatId(ctx) !== this.chatId) {
            return { ok: false, fatal: ['The chat changed during generation.'], warnings: [] };
        }

        const structure = validateOwnedStructure({
            chat: ctx.chat,
            ownership: this.ownership,
            prefix: this.prefix,
            insertion: this.insertion,
        });
        if (!structure.ok) return structure;

        if (wasGenerationStopped()) {
            const keep = await showConfirm(
                'Generation stopped early',
                'The continuation was stopped before it finished. Keep the partial continuation, or roll everything back to the original message?',
                { confirmLabel: 'Keep partial', cancelLabel: 'Roll back' },
            );
            if (!keep) return { ok: false, fatal: ['Generation was cancelled.'], warnings: [] };
        }

        // Measure the message we proved we generated, never the chat tail.
        const quality = qualityWarnings({
            prefix: this.prefix,
            insertion: this.insertion,
            suffix: this.suffix,
            generated: String(structure.suffixMessage.mes ?? ''),
            mode: this.rewriteMode,
        });
        this.result = {
            warnings: [...structure.warnings, ...quality.warnings],
            preservation: quality.preservation,
        };
        return { ok: true, fatal: [], warnings: this.result.warnings };
    }

    /** §12.7 — tag messages, record metadata, enrich the vault, save, announce. */
    async commit() {
        const ctx = getCtx();
        this.state = TX_STATE.COMMITTING;

        const suffixIndex = this.ownership.suffixIndex;
        const affectedMessageIds = [
            this.ownership.prefixIndex,
            this.ownership.insertionIndex,
            suffixIndex,
        ];
        const eventPayload = {
            transactionId: this.transactionId,
            chatId: this.chatId,
            originalMessageIndex: this.targetIndex,
            originalHash: this.anchor.originalMessageHash,
            affectedMessageIds,
            discardedSuffixHash: hashText(this.suffix),
            parentTransactionId: this.chain.parentTransactionId,
            chainDepth: this.chain.depth,
            operation: 'commit',
        };

        // Listeners of this event can mutate history, so nothing may be trusted
        // across it. Emit first, then prove ownership again before writing any
        // record that says the commit happened (§5.5).
        await emitIntercedeEvent(INTERCEDE_EVENTS.BEFORE_COMMIT, eventPayload);

        const recheck = validateOwnedStructure({
            chat: ctx.chat,
            ownership: this.ownership,
            prefix: this.prefix,
            insertion: this.insertion,
        });
        if (!recheck.ok) {
            throw new RecoveryRequiredError(
                `The chat changed while committing: ${recheck.fatal.join(' ')}`,
                { transactionId: this.transactionId },
            );
        }

        const suffixMessage = recheck.suffixMessage;
        markOwnedMessage(suffixMessage, this.transactionId, OWNED_ROLE.SUFFIX);

        const container = getMetaContainer(ctx);
        if (!container) {
            throw new Error('Chat metadata is unavailable, so the intercession could not be recorded.');
        }
        container.transactions[this.transactionId] = {
            version: 1,
            state: 'committed',
            targetMessageIndex: this.targetIndex,
            prefixMessageId: this.ownership.prefixIndex,
            insertionMessageId: this.ownership.insertionIndex,
            suffixMessageId: suffixIndex,
            cutOffset: this.anchor.rawOffset,
            originalHash: this.anchor.originalMessageHash,
            prefixHash: hashText(this.prefix),
            suffixHash: hashText(this.suffix),
            rewriteMode: this.rewriteMode,
            vaultKey: this.vaultKey,
            parentTransactionId: this.chain.parentTransactionId,
            chainDepth: this.chain.depth,
            createdAt: Date.now(),
            committedAt: Date.now(),
        };

        const vaultRecord = await vaultGet(this.vaultKey);
        if (!vaultRecord) {
            throw new Error('The snapshot vault record disappeared before the intercession could be committed.');
        }
        await vaultPutStrict(this.vaultKey, {
            ...vaultRecord,
            state: 'committed',
            revisedSuffix: String(suffixMessage.mes ?? ''),
            preservation: this.result.preservation,
            committedAt: Date.now(),
        });

        updateJournalStrict({ stage: JOURNAL_STAGE.COMMITTING });
        await persistChatAndMetadata(ctx);

        updateJournalStrict({ stage: JOURNAL_STAGE.COMMITTED });
        clearJournalStrict();
        this.state = TX_STATE.COMMITTED;

        await emitIntercedeEvent(INTERCEDE_EVENTS.COMMITTED, eventPayload);
    }

    /**
     * §12.8 — idempotent, exact restoration.
     *
     * Only messages this transaction can prove it created are removed. Anything
     * unprovable stops the rollback and escalates to recovery-required with the
     * journal and vault intact, because guessing here is how unrelated messages
     * get destroyed (INV-05).
     */
    async rollback(reason) {
        if (this._rollingBack
            || this.state === TX_STATE.COMMITTED
            || this.state === TX_STATE.ROLLED_BACK
            || this.state === TX_STATE.RECOVERY_REQUIRED) return;
        this._rollingBack = true;
        this.state = TX_STATE.ROLLING_BACK;
        console.warn('[Intercede] rolling back:', reason);

        const ctx = getCtx();
        try {
            if (isGenerationActive()) ctx?.stopGeneration?.();
        } catch { /* stop is best-effort */ }
        disarmLease();

        try {
            if (!this._mutated) {
                // Nothing canonical was changed. Clear the journal only if it is
                // still ours — a failure while arming may mean it belongs to an
                // earlier, unrecovered transaction.
                if (readJournal()?.transactionId === this.transactionId) clearJournal();
                if (this.vaultKey) await vaultDelete(this.vaultKey);
                this.state = TX_STATE.ROLLED_BACK;
                return;
            }

            if (!ctx || getCurrentChatId(ctx) !== this.chatId) {
                // The user switched chats mid-transaction. Never touch the active
                // chat; the journal stays behind so recovery runs when the
                // original chat is reopened.
                notify('warning', 'The chat changed during an intercession. Reopen that chat to restore the original message.', { timeOut: 10000 });
                return;
            }

            if (reason instanceof RecoveryRequiredError) {
                await this.enterRecoveryRequired(reason);
                return;
            }

            try {
                await removeOwnedMessages(ctx, this.ownership);
            } catch (error) {
                await this.enterRecoveryRequired(error);
                return;
            }

            const prefixIndex = ctx.chat.indexOf(this.ownership.prefixRef);
            if (prefixIndex < 0 || !isOwnedMessage(this.ownership.prefixRef, this.transactionId, OWNED_ROLE.PREFIX)) {
                await this.enterRecoveryRequired(new RecoveryRequiredError(
                    'The message this intercession cut can no longer be proven to belong to it.',
                ));
                return;
            }

            ctx.chat[prefixIndex] = structuredClone(this.snapshotMessage);
            reAddMessage(ctx, prefixIndex, ctx.chat[prefixIndex]);
            restoreIntercedeMetadata(ctx, this.metadataSnapshot);

            try {
                await persistChatAndMetadata(ctx);
            } catch (error) {
                // Correct in memory but not on disk. The journal and vault must
                // survive so the next load can finish the job (INV-12).
                console.error('[Intercede] save after rollback failed', error);
                await this.enterRecoveryRequired(new RecoveryRequiredError(
                    'The original message was restored in memory but the chat could not be saved. Do not close this chat.',
                ));
                return;
            }

            updateJournal({ stage: JOURNAL_STAGE.ROLLED_BACK });
            clearJournal();
            if (this.vaultKey) await vaultDelete(this.vaultKey);
            this.state = TX_STATE.ROLLED_BACK;

            await emitIntercedeEvent(INTERCEDE_EVENTS.ROLLED_BACK, {
                transactionId: this.transactionId,
                chatId: this.chatId,
                originalMessageIndex: this.targetIndex,
                affectedMessageIds: [this.targetIndex],
                operation: 'rollback',
            });
        } finally {
            this._rollingBack = false;
        }
    }

    /**
     * Ownership is ambiguous. Stop, keep every message, keep the evidence, and
     * hand the decision to the user (§5.7).
     */
    async enterRecoveryRequired(error) {
        this.state = TX_STATE.RECOVERY_REQUIRED;
        recoveryRequired = true;

        const detail = String(error?.message ?? error);
        try {
            updateJournal({ stage: JOURNAL_STAGE.RECOVERY_REQUIRED, error: detail });
        } catch { /* the notice below is the real signal */ }

        console.error('[Intercede] recovery required:', detail);
        notify(
            'error',
            `Intercede stopped without changing anything further: ${detail} No messages were deleted. Run /intercede recover to review.`,
            { timeOut: 0 },
        );
    }
}

/**
 * The committed transaction whose three messages are still the chat tail, or null.
 */
export function getCommittedTipRecord(ctx = getCtx()) {
    const chat = ctx?.chat;
    if (!Array.isArray(chat) || chat.length < 3) return null;
    const tip = chat[chat.length - 1];
    const marker = tip?.extra?.[METADATA_KEY];
    if (!marker || marker.role !== 'suffix' || !marker.transactionId) return null;
    const container = getMetaContainer(ctx);
    const record = container?.transactions?.[marker.transactionId];
    if (!record || record.state !== 'committed') return null;
    const insertionMarker = chat[chat.length - 2]?.extra?.[METADATA_KEY];
    const prefixMarker = chat[chat.length - 3]?.extra?.[METADATA_KEY];
    if (insertionMarker?.transactionId !== marker.transactionId || insertionMarker.role !== 'insertion') return null;
    if (prefixMarker?.transactionId !== marker.transactionId || prefixMarker.role !== 'prefix') return null;
    return { transactionId: marker.transactionId, ...record };
}

/**
 * Whether Undo and Compare can actually deliver (INV-10).
 *
 * The metadata record alone is not enough: it names a vault key, and the
 * snapshot behind that key is what makes an exact undo possible. Offering the
 * controls without checking means the user learns the snapshot is gone only
 * after clicking.
 */
export async function canUndoTip(ctx = getCtx()) {
    const record = getCommittedTipRecord(ctx);
    if (!record?.vaultKey || record.finalizedAt) return false;
    return vaultRecordExists(record.vaultKey);
}

/**
 * Give up undo for the committed intercession at the tail, deliberately and
 * irreversibly. The canonical messages are left exactly as they are; only the
 * ability to restore the pre-intercession original is discarded.
 */
export async function finalizeIntercession() {
    const ctx = getCtx();
    if (!ctx) return { ok: false, reason: 'SillyTavern context unavailable.' };
    if (activeTransaction) return { ok: false, reason: 'An intercession is in progress.' };

    const record = getCommittedTipRecord(ctx);
    if (!record) {
        return { ok: false, reason: 'The chat tail is not a completed intercession.' };
    }
    if (record.finalizedAt) {
        return { ok: false, reason: 'This intercession has already been finalized.' };
    }

    if (record.vaultKey) {
        await vaultDeleteStrict(record.vaultKey);
    }

    const container = getMetaContainer(ctx);
    const stored = container?.transactions?.[record.transactionId];
    if (stored) {
        stored.finalizedAt = Date.now();
        delete stored.vaultKey;
    }
    await persistChatAndMetadata(ctx);

    notify('success', 'Intercession finalized — the undo snapshot was deleted. The messages are unchanged.');
    return { ok: true };
}

/**
 * §14.1/§14.2 — undo the committed intercession while it is still the chat tail.
 *
 * Chains unwind newest-first: restoring the snapshot puts back the message the
 * cut was made in, marker and all, so if that message was an earlier
 * intercession's revised continuation the tail becomes that intercession again
 * and undo can be run once more.
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function undoIntercession() {
    const ctx = getCtx();
    if (!ctx) return { ok: false, reason: 'SillyTavern context unavailable.' };
    if (isGenerationActive()) return { ok: false, reason: 'Wait for the current generation to finish.' };
    if (activeTransaction) return { ok: false, reason: 'An intercession is in progress.' };

    const record = getCommittedTipRecord(ctx);
    if (!record) {
        return { ok: false, reason: 'The chat tail is not a completed intercession — undo only works before the conversation moves on.' };
    }

    const vaultRecord = await vaultGet(record.vaultKey);
    if (!vaultRecord?.completeOriginalMessage) {
        return { ok: false, reason: 'The original snapshot is no longer in the vault, so an exact undo is not possible.' };
    }

    // getCommittedTipRecord already proved all three tail messages carry this
    // transaction's markers, so the two above the prefix are provably ours.
    const chat = ctx.chat;
    const prefixIndex = chat.length - 3;
    await deleteMessageAt(ctx, prefixIndex + 2);
    await deleteMessageAt(ctx, prefixIndex + 1);

    chat[prefixIndex] = structuredClone(vaultRecord.completeOriginalMessage);
    reAddMessage(ctx, prefixIndex, chat[prefixIndex]);

    const container = getMetaContainer(ctx);
    if (container?.transactions?.[record.transactionId]) {
        delete container.transactions[record.transactionId];
    }

    try {
        await persistChatAndMetadata(ctx);
    } catch (error) {
        // The snapshot stays in the vault: the chat on disk still describes the
        // intercession, so undo must remain possible after a reload.
        console.error('[Intercede] save after undo failed', error);
        notify('error', 'The original message was restored in memory but the chat could not be saved. Do not close this chat.', { timeOut: 0 });
        return { ok: false, reason: 'The undo could not be saved.' };
    }

    await vaultDelete(record.vaultKey);

    await emitIntercedeEvent(INTERCEDE_EVENTS.UNDONE, {
        transactionId: record.transactionId,
        chatId: getCurrentChatId(ctx),
        originalMessageIndex: prefixIndex,
        affectedMessageIds: [prefixIndex, prefixIndex + 1, prefixIndex + 2],
        operation: 'undo',
    });
    notify('success', record.chainDepth
        ? 'Intercession undone — the continuation it was cut from is back, and can be undone in turn.'
        : 'Intercession undone — the original message was restored.');
    return { ok: true };
}

let recoveryInProgress = false;

/**
 * §19 — startup / chat-change recovery from the journal. Interactive when possible.
 */
export async function checkRecovery() {
    if (recoveryInProgress) return;
    recoveryInProgress = true;
    try {
        await checkRecoveryInner();
    } finally {
        recoveryInProgress = false;
    }
}

/**
 * How much the journal stage lets us assume, per §7.5.
 *
 * The distinction that matters: before the prefix was applied, nothing canonical
 * had changed, so a leftover journal is just litter. From `prefix-applied`
 * onward the chat was modified and the snapshot is the only way back. At
 * `committing` the commit may or may not have reached disk, and at
 * `recovery-required` a previous run already determined that ownership is
 * ambiguous — which means no automatic destructive action is permitted.
 */
const STAGES_BEFORE_MUTATION = [
    JOURNAL_STAGE.ABOUT_TO_MUTATE,
    JOURNAL_STAGE.SNAPSHOTTED,
];

async function checkRecoveryInner() {
    const journal = readJournal();
    if (!journal) return;
    if (activeTransaction) return; // the live transaction owns the journal

    if (journal.stage === JOURNAL_STAGE.COMMITTED || journal.stage === JOURNAL_STAGE.ROLLED_BACK) {
        clearJournal();
        return;
    }

    const ctx = getCtx();
    const chatId = getCurrentChatId(ctx);
    if (journal.chatId !== chatId) {
        notify('warning', `An unfinished intercession exists in another chat ("${journal.chatId}"). Open that chat to recover it.`, { timeOut: 10000 });
        return;
    }

    if (journal.stage === JOURNAL_STAGE.RECOVERY_REQUIRED) {
        recoveryRequired = true;
        const why = journal.error ? `: ${journal.error}` : '.';
        const snapshot = await vaultGet(journal.vaultKey);

        // Offer the snapshot when there still is one — a rollback that was
        // correct in memory but failed to save lands here, and the original is
        // still recoverable.
        if (snapshot?.completeOriginalMessage) {
            const restore = await showConfirm(
                'An intercession needs your review',
                `Intercede stopped without deleting anything${why} Restore the original message from its snapshot, or keep the chat exactly as it stands now?`,
                { confirmLabel: 'Restore original', cancelLabel: 'Keep chat as it is' },
            );
            if (restore) {
                await restoreFromVaultRecord(ctx, journal, snapshot);
                return;
            }
            if (!await abandonInterruptedTransaction(ctx, journal, snapshot)) {
                notify('warning', 'Some messages still carry markers from the interrupted intercession, so it stays open for review.', { timeOut: 10000 });
            }
            return;
        }

        // No snapshot: nothing can be restored, and clearing the journal here
        // would erase the only record that a canonical mutation was interrupted.
        notify(
            'error',
            `Intercede stopped without deleting anything${why} Its snapshot is missing, so the interruption is being kept on record. Please review the last few messages yourself.`,
            { timeOut: 0 },
        );
        return;
    }

    // Nothing canonical was mutated at these stages; the target is untouched.
    if (STAGES_BEFORE_MUTATION.includes(journal.stage)) {
        const target = ctx?.chat?.[journal.targetIndex];
        if (target && hashText(String(target.mes ?? '')) === journal.expectedTargetHash) {
            clearJournal();
            if (journal.vaultKey) await vaultDelete(journal.vaultKey);
            return;
        }
    }

    const vaultRecord = await vaultGet(journal.vaultKey);
    if (!vaultRecord?.completeOriginalMessage) {
        // The journal is the only durable evidence that canonical history was
        // mid-change. Losing the snapshot makes automatic restoration
        // impossible, not the interruption imaginary — so keep the record and
        // stop, rather than declaring the transaction resolved (P0-04).
        recoveryRequired = true;
        try {
            updateJournal({ stage: JOURNAL_STAGE.RECOVERY_REQUIRED, error: 'snapshot-missing' });
        } catch { /* the notice below is the real signal */ }
        notify(
            'error',
            'An unfinished intercession was found, but its recovery snapshot is missing. No history was changed automatically — please review the last few messages.',
            { timeOut: 0 },
        );
        return;
    }

    const committing = journal.stage === JOURNAL_STAGE.COMMITTING;
    const restore = await showConfirm(
        'Recover interrupted intercession?',
        committing
            ? 'An intercession in this chat was interrupted while being saved. Restore the original assistant message exactly as it was, or keep the chat as it currently stands?'
            : 'An intercession in this chat did not finish (reload or crash). Restore the original assistant message exactly as it was?',
        { confirmLabel: 'Restore original', cancelLabel: 'Keep chat as it is' },
    );
    if (!restore) {
        if (!await abandonInterruptedTransaction(ctx, journal, vaultRecord)) {
            recoveryRequired = true;
            notify('warning', 'Some messages still carry markers from the interrupted intercession, so it stays open for review.', { timeOut: 10000 });
        }
        return;
    }
    await restoreFromVaultRecord(ctx, journal, vaultRecord);
}

/**
 * Resolve an interrupted transaction by accepting the chat as it currently
 * stands (P0-03).
 *
 * "Keep chat as it is" cannot mean "delete the journal and walk away": that
 * leaves messages still marked as belonging to a transaction that never
 * finished, and a vault snapshot nothing references. Worse, when the target is
 * half-applied the snapshot holds the *only* copy of the original text, so
 * discarding it destroys the very thing recovery exists to protect.
 *
 * So the markers are cleared, an `abandoned` record keeps the snapshot
 * referenced and findable, and the snapshot itself is retained. If any marker
 * cannot be accounted for, nothing is touched and the transaction stays in
 * recovery-required.
 *
 * @returns {Promise<boolean>} false when the state could not be resolved safely
 */
async function abandonInterruptedTransaction(ctx, journal, vaultRecord) {
    const transactionId = journal.transactionId;
    const marked = ctx.chat.filter(
        message => getIntercedeMarker(message)?.transactionId === transactionId,
    );

    if (!marked.every(message => hasKnownRole(message, transactionId))) {
        return false;
    }

    for (const message of marked) {
        clearOwnedMarker(message, transactionId);
    }

    const container = getMetaContainer(ctx);
    if (container) {
        container.transactions[transactionId] = {
            version: 1,
            state: 'abandoned',
            abandonedAt: Date.now(),
            targetMessageIndex: journal.targetIndex,
            originalHash: journal.expectedTargetHash,
            vaultKey: journal.vaultKey,
            reason: 'The chat was kept as it stood when recovery ran.',
        };
    }

    try {
        await persistChatAndMetadata(ctx);
    } catch (error) {
        console.error('[Intercede] save while abandoning a transaction failed', error);
        return false;
    }

    // Deliberately keeps the snapshot: it is still the only copy of the
    // pre-intercession text, and cleanupVault protects abandoned records.
    if (vaultRecord && journal.vaultKey) {
        try {
            await vaultPut(journal.vaultKey, { ...vaultRecord, state: 'abandoned', abandonedAt: Date.now() });
        } catch { /* the metadata record already preserves the reference */ }
    }

    clearJournal();
    recoveryRequired = false;
    return true;
}

async function restoreFromVaultRecord(ctx, journal, vaultRecord) {
    const chat = ctx.chat;
    const targetIndex = journal.targetIndex;
    if (!Number.isInteger(targetIndex) || targetIndex >= chat.length) {
        notify('error', 'Recovery aborted: the chat is shorter than the snapshot expects.');
        return;
    }

    const target = chat[targetIndex];
    const targetText = String(target?.mes ?? '');
    const matchesTransaction = target?.extra?.[METADATA_KEY]?.transactionId === journal.transactionId;
    const matchesPrefix = hashText(targetText) === hashText(vaultRecord.prefix);
    const matchesOriginal = hashText(targetText) === journal.expectedTargetHash;
    if (!matchesTransaction && !matchesPrefix && !matchesOriginal) {
        notify('error', 'Recovery aborted: the target message no longer matches the snapshot. Nothing was changed.');
        return;
    }

    // Only remove messages that can be proven to belong to the interrupted
    // transaction; stop the moment anything else is found.
    //
    // Proof is either the transaction's own marker, or — for the inserted user
    // message, which may have been added before the marker was written — an
    // exact text match against the snapshot. Position alone is never proof: an
    // unmarked assistant message sitting where the continuation would have gone
    // may equally be another extension's, so recovery stops and asks.
    while (chat.length > targetIndex + 1) {
        const index = chat.length - 1;
        const message = chat[index];
        const marker = message?.extra?.[METADATA_KEY];
        const belongs = marker?.transactionId === journal.transactionId
            || (index === targetIndex + 1 && message?.is_user
                && normalizeForComparison(message.mes) === normalizeForComparison(vaultRecord.insertion));
        if (!belongs) {
            notify('warning', 'Recovery stopped: later messages could not be proven to belong to the intercession. Nothing was deleted.', { timeOut: 10000 });
            return;
        }
        await deleteMessageAt(ctx, index);
    }

    chat[targetIndex] = structuredClone(vaultRecord.completeOriginalMessage);
    reAddMessage(ctx, targetIndex, chat[targetIndex]);
    if (vaultRecord.metadataSnapshot) {
        restoreIntercedeMetadata(ctx, vaultRecord.metadataSnapshot);
    }

    try {
        await persistChatAndMetadata(ctx);
    } catch (error) {
        // Leave the journal and snapshot in place so the next load can retry.
        console.error('[Intercede] save after recovery failed', error);
        notify('error', 'The original message was restored in memory but the chat could not be saved. Do not close this chat.', { timeOut: 0 });
        return;
    }

    clearJournal();
    recoveryRequired = false;
    await vaultDelete(journal.vaultKey);

    await emitIntercedeEvent(INTERCEDE_EVENTS.ROLLED_BACK, {
        transactionId: journal.transactionId,
        chatId: journal.chatId,
        originalMessageIndex: targetIndex,
        affectedMessageIds: [targetIndex],
        operation: 'recovery',
    });
    notify('success', 'Original message restored from the recovery snapshot.');
}
