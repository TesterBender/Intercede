/**
 * The atomic chat-history transaction (§12, §17.1).
 *
 *   Original assistant message  →  Assistant prefix / User insertion / Assistant revised suffix
 *
 * @see docs/RATIONALE.md#TX-01 the transaction contract
 * @see docs/RATIONALE.md#TX-05 attribution before ownership is claimed
 * @see docs/RATIONALE.md#TX-08 selective rollback
 * @see docs/RATIONALE.md#TX-11 the recovery-required latch
 */

import { resolveAnchor } from './anchors.js';
import {
    GENERATION_TIMEOUT_MS,
    INTERCEDE_EVENTS,
    JOURNAL_STAGE,
    METADATA_KEY,
    REWRITE_MODES,
    TERMINAL_JOURNAL_STAGES,
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
    cleanupVault,
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

/** Blocks new intercessions once ownership was unprovable. @see docs/RATIONALE.md#TX-11 */
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

/**
 * Announce that derived state (summaries, vectors, timelines) computed from
 * these messages no longer describes what is in the chat.
 *
 * Every operation that rewrites canonical history emits its own specific event
 * *and* this one, so a listener that only cares "did the text under me change?"
 * has a single subscription instead of four.
 * @see docs/RATIONALE.md#CFG-02
 */
async function emitInvalidated({ transactionId, chatId, affectedMessageIds, operation }) {
    const ids = (affectedMessageIds ?? []).filter(id => Number.isInteger(id));
    await emitIntercedeEvent(INTERCEDE_EVENTS.INVALIDATED, {
        transactionId,
        chatId,
        affectedMessageIds: ids,
        // Everything from here on may have shifted position, not just changed text.
        fromIndex: ids.length ? Math.min(...ids) : null,
        operation,
    });
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
 * @see docs/RATIONALE.md#TX-12 — must not materialize the container
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
 * @see docs/RATIONALE.md#TX-04
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
 * The committed records a transaction is built on, oldest first.
 * @see docs/RATIONALE.md#TX-04
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
 * Version-one eligibility.
 * @see docs/RATIONALE.md#TX-03 the full precondition list
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
 * @see docs/RATIONALE.md#TX-08 the two proofs, and why a missing ref is fine
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
        /** Canonical state actually changed. @see docs/RATIONALE.md#TX-02 */
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
     * @see docs/RATIONALE.md#VAULT-01 and #JRN-01 — nothing here may fail quietly
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
        // @see docs/RATIONALE.md#TX-04, #OWN-02
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

        // @see docs/RATIONALE.md#CAP-01
        const capture = beginAssistantCapture(ctx, { chatId: this.chatId });
        const sequenceBeforeCall = getGenerationStartSequence();

        let candidates = [];
        let generationError = null;
        try {
            const generation = ctx.generate();
            if (generation && typeof generation.then === 'function') {
                await withTimeout(generation, GENERATION_TIMEOUT_MS, 'Generation timed out.');
            }
            // @see docs/RATIONALE.md#TX-17
            await waitUntil(() => !isGenerationActive(), 8000, 100);
        } catch (error) {
            generationError = error;
        } finally {
            // Finalized here so an owned reply is always removable. @see docs/RATIONALE.md#TX-06
            candidates = capture.finish();
            closeLeaseAudit(this.transactionId);
            disarmLease();
        }

        // Can the reply be attributed to *this* call at all?
        // @see docs/RATIONALE.md#TX-05
        const receipt = getLeaseReceipt(this.transactionId);
        const attributable = receipt?.matchingStarts === 1
            && (receipt.appliedSequence === null || receipt.appliedSequence > sequenceBeforeCall);

        this.ownership.suffixIndex = null;
        this.ownership.suffixRef = null;
        let proofError = null;

        if (attributable) {
            // @see docs/RATIONALE.md#TX-06 claim even when generation failed after
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

        // @see docs/RATIONALE.md#LEASE-05 — `applied` says nothing about this
        if (receipt.promptIntegrityLost) {
            const kinds = [...new Set(receipt.interferingStarts.map(start => start.kind))];
            const detail = kinds.length ? ` (${kinds.join(', ')})` : ' that was already running';
            throw new Error(
                `Another generation${detail} overlapped this intercession and removed the rewrite instruction before it could be used, so the continuation was written without it. Nothing was committed.`,
            );
        }

        // Ours, but uninstructed. @see docs/RATIONALE.md#LEASE-03, #LEASE-05
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

        // @see docs/RATIONALE.md#TX-16
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

        // @see docs/RATIONALE.md#TX-07 — listeners may mutate history
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
        await emitInvalidated(eventPayload);
    }

    /**
     * §12.8 — idempotent, exact restoration.
     * @see docs/RATIONALE.md#TX-08 and #TX-09
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
                // @see docs/RATIONALE.md#TX-02, #JRN-02
                if (readJournal()?.transactionId === this.transactionId) clearJournal();
                if (this.vaultKey) await vaultDelete(this.vaultKey);
                this.state = TX_STATE.ROLLED_BACK;
                return;
            }

            if (!ctx || getCurrentChatId(ctx) !== this.chatId) {
                // @see docs/RATIONALE.md#TX-10
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
                // @see docs/RATIONALE.md#TX-09
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

            const rollbackPayload = {
                transactionId: this.transactionId,
                chatId: this.chatId,
                originalMessageIndex: this.targetIndex,
                affectedMessageIds: [this.targetIndex],
                operation: 'rollback',
            };
            await emitIntercedeEvent(INTERCEDE_EVENTS.ROLLED_BACK, rollbackPayload);
            await emitInvalidated(rollbackPayload);
        } finally {
            this._rollingBack = false;
        }
    }

    /**
     * Ownership is ambiguous — stop and hand the decision to the user (§5.7).
     * @see docs/RATIONALE.md#TX-11
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
 * @see docs/RATIONALE.md#TX-15
 */
export async function canUndoTip(ctx = getCtx()) {
    const record = getCommittedTipRecord(ctx);
    if (!record?.vaultKey || record.finalizedAt) return false;
    return vaultRecordExists(record.vaultKey);
}

/**
 * Vault keys something still points at, so age alone must not reap them.
 *
 * A record's own `state` cannot answer this: an in-flight snapshot has no state
 * yet, and a committed one written by an earlier version may have none either.
 * @see docs/RATIONALE.md#VAULT-02
 * @returns {Set<string>}
 */
export function liveVaultKeys(ctx = getCtx()) {
    const keys = new Set();

    if (activeTransaction?.vaultKey) keys.add(activeTransaction.vaultKey);

    const journal = readJournal();
    if (journal?.vaultKey && !TERMINAL_JOURNAL_STAGES.includes(journal.stage)) {
        keys.add(journal.vaultKey);
    }

    for (const record of Object.values(readTransactions(ctx) ?? {})) {
        if (record?.vaultKey && !record.finalizedAt) keys.add(record.vaultKey);
    }

    return keys;
}

/**
 * Age-based snapshot cleanup that knows what the extension is currently doing.
 * @see docs/RATIONALE.md#VAULT-02
 * @returns {Promise<{ ok: boolean, removed: number, reason?: string }>}
 */
export async function cleanupSnapshots(ttlDays, ctx = getCtx()) {
    if (activeTransaction) {
        return { ok: false, removed: 0, reason: 'An intercession is in progress.' };
    }
    return { ok: true, removed: await cleanupVault(ttlDays, liveVaultKeys(ctx)) };
}

/**
 * Give up undo for the committed intercession at the tail, irreversibly.
 *
 * The step order is the whole safety argument: each failure point must leave
 * undo either still working or correctly reported as gone, never gone while
 * still advertised.
 * @see docs/RATIONALE.md#TX-14
 */
export async function finalizeIntercession() {
    const ctx = getCtx();
    if (!ctx) return { ok: false, reason: 'SillyTavern context unavailable.' };
    if (activeTransaction) return { ok: false, reason: 'An intercession is in progress.' };
    if (recoveryRequired) {
        return { ok: false, reason: 'An interrupted intercession still needs review — run /intercede recover first.' };
    }

    const journal = readJournal();
    if (journal && !TERMINAL_JOURNAL_STAGES.includes(journal.stage)) {
        return {
            ok: false,
            reason: `An unfinished intercession (${journal.stage}) is still journaled, and deleting a snapshot now could remove the only copy of the original. Recover it first.`,
        };
    }

    const record = getCommittedTipRecord(ctx);
    if (!record) {
        return { ok: false, reason: 'The chat tail is not a completed intercession.' };
    }
    if (record.finalizedAt) {
        return { ok: false, reason: 'This intercession has already been finalized.' };
    }

    const container = getMetaContainer(ctx);
    const stored = container?.transactions?.[record.transactionId];
    if (!stored) {
        return { ok: false, reason: 'The transaction record disappeared before it could be finalized.' };
    }

    const finalizedAt = Date.now();

    // 1. Mark the snapshot finalized first. Cleanup protects committed records
    //    that are not finalized, so an unreferenced record would otherwise be
    //    kept forever if step 3 never ran.
    if (record.vaultKey) {
        const snapshot = await vaultGet(record.vaultKey);
        if (snapshot) await vaultPutStrict(record.vaultKey, { ...snapshot, finalizedAt });
    }

    // 2. Record the decision durably, while the snapshot still exists.
    stored.finalizedAt = finalizedAt;
    delete stored.vaultKey;
    await persistChatAndMetadata(ctx);

    // 3. Only now is the snapshot expendable.
    if (record.vaultKey) {
        await vaultDeleteStrict(record.vaultKey);
    }

    notify('success', 'Intercession finalized — the undo snapshot was deleted. The messages are unchanged.');
    return { ok: true, transactionId: record.transactionId };
}

/**
 * §14.1/§14.2 — undo the committed intercession while it is still the chat tail.
 * @see docs/RATIONALE.md#TX-13 how chains unwind
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

    // @see docs/RATIONALE.md#TX-13 — the tip record already proved all three
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
        // @see docs/RATIONALE.md#TX-13 — the snapshot deliberately stays
        console.error('[Intercede] save after undo failed', error);
        notify('error', 'The original message was restored in memory but the chat could not be saved. Do not close this chat.', { timeOut: 0 });
        return { ok: false, reason: 'The undo could not be saved.' };
    }

    await vaultDelete(record.vaultKey);

    const undonePayload = {
        transactionId: record.transactionId,
        chatId: getCurrentChatId(ctx),
        originalMessageIndex: prefixIndex,
        affectedMessageIds: [prefixIndex, prefixIndex + 1, prefixIndex + 2],
        operation: 'undo',
    };
    await emitIntercedeEvent(INTERCEDE_EVENTS.UNDONE, undonePayload);
    await emitInvalidated(undonePayload);
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
 * @see docs/RATIONALE.md#REC-01 the stage table
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
        // @see docs/RATIONALE.md#REC-05
        notify('warning', `An unfinished intercession exists in another chat ("${journal.chatId}"). Open that chat to recover it.`, { timeOut: 10000 });
        return;
    }

    if (journal.stage === JOURNAL_STAGE.RECOVERY_REQUIRED) {
        recoveryRequired = true;
        const why = journal.error ? `: ${journal.error}` : '.';
        const snapshot = await vaultGet(journal.vaultKey);

        // @see docs/RATIONALE.md#TX-09 — a save-failed rollback lands here
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

        // @see docs/RATIONALE.md#REC-02
        notify(
            'error',
            `Intercede stopped without deleting anything${why} Its snapshot is missing, so the interruption is being kept on record. Please review the last few messages yourself.`,
            { timeOut: 0 },
        );
        return;
    }

    // @see docs/RATIONALE.md#REC-01
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
        // @see docs/RATIONALE.md#REC-02
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
 * Resolve an interrupted transaction by accepting the chat as it stands (P0-03).
 * @see docs/RATIONALE.md#REC-03 why the snapshot and markers are handled this way
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

    // @see docs/RATIONALE.md#REC-03, #VAULT-02 — the snapshot is kept on purpose
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

    // @see docs/RATIONALE.md#REC-04 what counts as proof here
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
        // @see docs/RATIONALE.md#REC-02 — journal and snapshot stay for a retry
        console.error('[Intercede] save after recovery failed', error);
        notify('error', 'The original message was restored in memory but the chat could not be saved. Do not close this chat.', { timeOut: 0 });
        return;
    }

    clearJournal();
    recoveryRequired = false;
    await vaultDelete(journal.vaultKey);

    const recoveryPayload = {
        transactionId: journal.transactionId,
        chatId: journal.chatId,
        originalMessageIndex: targetIndex,
        affectedMessageIds: [targetIndex],
        operation: 'recovery',
    };
    await emitIntercedeEvent(INTERCEDE_EVENTS.ROLLED_BACK, recoveryPayload);
    await emitInvalidated(recoveryPayload);
    notify('success', 'Original message restored from the recovery snapshot.');
}
