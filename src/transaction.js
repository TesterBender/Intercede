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
import { emitIntercedeEvent } from './events.js';
import { armLease, disarmLease, isGenerationActive, resetStoppedFlag, wasGenerationStopped } from './lease.js';
import { buildRewritePrompt } from './prompt.js';
import { splitAtOffset } from './segmentation.js';
import {
    getChatMetadata,
    getCtx,
    getCurrentChatId,
    getEventSource,
    getEventTypes,
    isGroupChat,
    saveMetadata,
} from './stcontext.js';
import { hashText, normalizeForComparison, notify, uuid, waitUntil } from './utils.js';
import { showConfirm } from './ui/modal.js';
import { qualityWarnings, validateStructure } from './validator.js';
import {
    clearJournal,
    readJournal,
    updateJournal,
    vaultDelete,
    vaultGet,
    vaultKeyFor,
    vaultPut,
    writeJournal,
} from './vault.js';

/** @type {IntercedeTransaction | null} */
let activeTransaction = null;

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
 * Version-one eligibility: the latest, completed, non-system assistant message
 * in a non-group chat, while nothing is generating.
 * @returns {{ ok: boolean, reason?: string, targetIndex?: number, message?: object }}
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
    if (activeTransaction) return { ok: false, reason: 'Another intercession is already in progress.' };
    return { ok: true, targetIndex, message };
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
        this.result = { warnings: [], preservation: null };
        this._rollingBack = false;
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

    /** §12.4 / §19 — complete original message into the vault, journal armed. */
    async snapshot() {
        const ctx = getCtx();
        const original = ctx.chat[this.targetIndex];
        this.snapshotMessage = structuredClone(original);
        this.vaultKey = vaultKeyFor(this.chatId, this.transactionId);

        writeJournal({
            transactionId: this.transactionId,
            chatId: this.chatId,
            stage: JOURNAL_STAGE.ABOUT_TO_MUTATE,
            vaultKey: this.vaultKey,
            targetIndex: this.targetIndex,
            expectedTargetHash: hashText(String(original.mes ?? '')),
            startedAt: Date.now(),
        });

        await vaultPut(this.vaultKey, {
            transactionId: this.transactionId,
            chatId: this.chatId,
            targetIndex: this.targetIndex,
            completeOriginalMessage: this.snapshotMessage,
            discardedSuffix: this.suffix,
            prefix: this.prefix,
            insertion: this.insertion,
            rewriteMode: this.rewriteMode,
            anchor: this.anchor,
            createdAt: Date.now(),
        });

        updateJournal({ stage: JOURNAL_STAGE.SNAPSHOTTED });
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
        message.extra = { ...(message.extra ?? {}), [METADATA_KEY]: { transactionId: this.transactionId, role: 'prefix' } };

        try {
            ctx.updateMessageBlock(this.targetIndex, message);
        } catch (error) {
            console.warn('[Intercede] updateMessageBlock failed', error);
        }
        const eventTypes = getEventTypes(ctx);
        if (eventTypes.MESSAGE_UPDATED) {
            await getEventSource(ctx)?.emit(eventTypes.MESSAGE_UPDATED, this.targetIndex);
        }

        updateJournal({ stage: JOURNAL_STAGE.PREFIX_APPLIED });
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
        inserted.extra = { ...(inserted.extra ?? {}), [METADATA_KEY]: { transactionId: this.transactionId, role: 'insertion' } };

        updateJournal({ stage: JOURNAL_STAGE.USER_INSERTED });
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
        updateJournal({ stage: JOURNAL_STAGE.GENERATION_STARTED });

        try {
            const generation = ctx.generate();
            if (generation && typeof generation.then === 'function') {
                await withTimeout(generation, GENERATION_TIMEOUT_MS, 'Generation timed out.');
            }
            // Settle: some backends resolve slightly before the reply is appended.
            await waitUntil(() => !isGenerationActive(), 8000, 100);
        } finally {
            disarmLease();
        }

        updateJournal({ stage: JOURNAL_STAGE.GENERATION_RETURNED });
    }

    /** §12.6 — structural checks are fatal; quality checks warn. */
    async validate() {
        const ctx = getCtx();
        this.state = TX_STATE.VALIDATING;

        if (getCurrentChatId(ctx) !== this.chatId) {
            return { ok: false, fatal: ['The chat changed during generation.'], warnings: [] };
        }

        const structure = validateStructure({
            chat: ctx.chat,
            targetIndex: this.targetIndex,
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

        const tip = ctx.chat[ctx.chat.length - 1];
        const quality = qualityWarnings({
            prefix: this.prefix,
            insertion: this.insertion,
            suffix: this.suffix,
            generated: String(tip.mes ?? ''),
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
        const chat = ctx.chat;
        const suffixIndex = chat.length - 1;
        const tip = chat[suffixIndex];
        tip.extra = { ...(tip.extra ?? {}), [METADATA_KEY]: { transactionId: this.transactionId, role: 'suffix' } };

        await emitIntercedeEvent(INTERCEDE_EVENTS.BEFORE_COMMIT, {
            transactionId: this.transactionId,
            chatId: this.chatId,
            originalMessageIndex: this.targetIndex,
            originalHash: this.anchor.originalMessageHash,
            affectedMessageIds: [this.targetIndex, this.targetIndex + 1, suffixIndex],
            discardedSuffixHash: hashText(this.suffix),
            operation: 'commit',
        });

        const container = getMetaContainer(ctx);
        if (container) {
            container.transactions[this.transactionId] = {
                version: 1,
                state: 'committed',
                targetMessageIndex: this.targetIndex,
                prefixMessageId: this.targetIndex,
                insertionMessageId: this.targetIndex + 1,
                suffixMessageId: suffixIndex,
                cutOffset: this.anchor.rawOffset,
                originalHash: this.anchor.originalMessageHash,
                prefixHash: hashText(this.prefix),
                suffixHash: hashText(this.suffix),
                rewriteMode: this.rewriteMode,
                vaultKey: this.vaultKey,
                createdAt: Date.now(),
                committedAt: Date.now(),
            };
        }

        const vaultRecord = await vaultGet(this.vaultKey);
        if (vaultRecord) {
            await vaultPut(this.vaultKey, {
                ...vaultRecord,
                revisedSuffix: String(tip.mes ?? ''),
                preservation: this.result.preservation,
            });
        }

        updateJournal({ stage: JOURNAL_STAGE.COMMITTED });
        await ctx.saveChat();
        await saveMetadata(ctx);
        clearJournal();
        this.state = TX_STATE.COMMITTED;

        await emitIntercedeEvent(INTERCEDE_EVENTS.COMMITTED, {
            transactionId: this.transactionId,
            chatId: this.chatId,
            originalMessageIndex: this.targetIndex,
            originalHash: this.anchor.originalMessageHash,
            affectedMessageIds: [this.targetIndex, this.targetIndex + 1, suffixIndex],
            discardedSuffixHash: hashText(this.suffix),
            operation: 'commit',
        });
    }

    /** §12.8 — idempotent, exact restoration. */
    async rollback(reason) {
        if (this._rollingBack || this.state === TX_STATE.COMMITTED || this.state === TX_STATE.ROLLED_BACK) return;
        this._rollingBack = true;
        this.state = TX_STATE.ROLLING_BACK;
        console.warn('[Intercede] rolling back:', reason);

        const ctx = getCtx();
        try {
            if (isGenerationActive()) ctx?.stopGeneration?.();
        } catch { /* stop is best-effort */ }
        disarmLease();

        try {
            if (!this.snapshotMessage) {
                // Nothing was mutated yet.
                clearJournal();
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

            // Everything after the target index was created by this transaction.
            while (ctx.chat.length > this.targetIndex + 1) {
                const removedIndex = ctx.chat.length - 1;
                ctx.chat.pop();
                removeMessageNode(removedIndex);
            }
            ctx.chat[this.targetIndex] = structuredClone(this.snapshotMessage);
            reAddMessage(ctx, this.targetIndex, ctx.chat[this.targetIndex]);

            try {
                await ctx.saveChat();
            } catch (error) {
                notify('error', 'Rollback succeeded in memory but the chat could not be saved. Do not close this chat until it saves.', { timeOut: 0 });
                console.error('[Intercede] save after rollback failed', error);
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
 * §14.1/§14.2 — undo the committed intercession while it is still the chat tail.
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

    const chat = ctx.chat;
    const prefixIndex = chat.length - 3;
    for (let index = chat.length - 1; index > prefixIndex; index--) {
        chat.pop();
        removeMessageNode(index);
    }
    chat[prefixIndex] = structuredClone(vaultRecord.completeOriginalMessage);
    reAddMessage(ctx, prefixIndex, chat[prefixIndex]);

    const container = getMetaContainer(ctx);
    if (container?.transactions?.[record.transactionId]) {
        delete container.transactions[record.transactionId];
    }
    await ctx.saveChat();
    await saveMetadata(ctx);
    await vaultDelete(record.vaultKey);

    await emitIntercedeEvent(INTERCEDE_EVENTS.UNDONE, {
        transactionId: record.transactionId,
        chatId: getCurrentChatId(ctx),
        originalMessageIndex: prefixIndex,
        affectedMessageIds: [prefixIndex, prefixIndex + 1, prefixIndex + 2],
        operation: 'undo',
    });
    notify('success', 'Intercession undone — the original message was restored.');
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

async function checkRecoveryInner() {
    const journal = readJournal();
    if (!journal) return;
    if (journal.stage === JOURNAL_STAGE.COMMITTED || journal.stage === JOURNAL_STAGE.ROLLED_BACK) {
        clearJournal();
        return;
    }
    if (activeTransaction) return; // the live transaction owns the journal

    const ctx = getCtx();
    const chatId = getCurrentChatId(ctx);
    if (journal.chatId !== chatId) {
        notify('warning', `An unfinished intercession exists in another chat ("${journal.chatId}"). Open that chat to recover it.`, { timeOut: 10000 });
        return;
    }

    const vaultRecord = await vaultGet(journal.vaultKey);
    if (!vaultRecord?.completeOriginalMessage) {
        notify('error', 'An unfinished intercession was found, but its snapshot is missing. Please review the last messages manually.');
        clearJournal();
        return;
    }

    const restore = await showConfirm(
        'Recover interrupted intercession?',
        'An intercession in this chat did not finish (reload or crash). Restore the original assistant message exactly as it was?',
        { confirmLabel: 'Restore original', cancelLabel: 'Keep chat as it is' },
    );
    if (!restore) {
        clearJournal();
        return;
    }
    await restoreFromVaultRecord(ctx, journal, vaultRecord);
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
    while (chat.length > targetIndex + 1) {
        const index = chat.length - 1;
        const message = chat[index];
        const marker = message?.extra?.[METADATA_KEY];
        const belongs = marker?.transactionId === journal.transactionId
            || (index === targetIndex + 1 && message?.is_user
                && normalizeForComparison(message.mes) === normalizeForComparison(vaultRecord.insertion))
            || (index === targetIndex + 2 && !message?.is_user && !message?.is_system);
        if (!belongs) {
            notify('warning', 'Recovery stopped: later messages do not belong to the intercession. Restore manually if needed.', { timeOut: 10000 });
            return;
        }
        chat.pop();
        removeMessageNode(index);
    }

    chat[targetIndex] = structuredClone(vaultRecord.completeOriginalMessage);
    reAddMessage(ctx, targetIndex, chat[targetIndex]);
    try {
        await ctx.saveChat();
    } catch (error) {
        console.error('[Intercede] save after recovery failed', error);
    }
    clearJournal();
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
