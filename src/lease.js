/**
 * One-generation lease (§11.5, §17.3).
 *
 * The suffix-revision instruction is only ever installed from inside a
 * GENERATION_STARTED handler whose type, chat, and timing match an explicitly
 * armed lease — and it is cleared again on every generation end, stop, chat
 * change, and in the caller's `finally`. It therefore cannot leak into
 * summaries, quiet prompts, impersonation, or any later unrelated generation.
 *
 * The same mechanism re-arms automatically (from committed transaction records)
 * when the user swipes or regenerates a committed revised suffix, so every
 * native swipe is another adaptation of the same intercession.
 */

import { EXTENSION_PROMPT_KEY, LEASE_TTL_MS, METADATA_KEY } from './constants.js';
import { buildRewritePrompt } from './prompt.js';
import { getChatMetadata, getCtx, getCurrentChatId, getEventSource, getEventTypes, getPromptRoles, getPromptTypes } from './stcontext.js';
import { vaultGet, vaultGetCached } from './vault.js';

/** @type {{ transactionId: string, prompt: string, chatId: string, kinds: Set<string>, armedAt: number } | null} */
let currentLease = null;
let generationActive = false;
let stoppedFlag = false;
let initialized = false;
/**
 * Monotonic count of generation starts, used to correlate a lease application
 * with the specific `generate()` call the transaction made.
 */
let generationStartSequence = 0;

/**
 * Audit of what actually happened to one transaction's lease.
 *
 * Armed is not the same as applied, and applied is not the same as applied *to
 * our generation*. Two distinct failures hide here:
 *
 *   - A generation Intercede did not start arrives first and consumes the
 *     lease. Intercede's own generation then runs with no rewrite instruction
 *     and produces an ordinary continuation that looks perfectly valid.
 *   - Any second matching generation while the lease is open makes it
 *     impossible to say which one carried the instruction.
 *
 * Counting matching starts and recording the sequence number at which the
 * prompt was installed lets the transaction reject both instead of guessing.
 * The audit outlives the lease itself, which GENERATION_ENDED clears.
 */
let leaseAudit = null;

export function getGenerationStartSequence() {
    return generationStartSequence;
}

function normalizeType(type) {
    return (type === undefined || type === null || type === '') ? 'normal' : String(type);
}

function setPrompt(text) {
    const ctx = getCtx();
    if (!ctx?.setExtensionPrompt) return;
    const types = getPromptTypes(ctx);
    const roles = getPromptRoles(ctx);
    ctx.setExtensionPrompt(EXTENSION_PROMPT_KEY, text, types.IN_CHAT, 0, false, roles.SYSTEM);
}

export function clearPrompt() {
    setPrompt('');
}

/**
 * Arm the lease for the next matching generation.
 * @param {object} options
 * @param {string} options.transactionId
 * @param {string} options.prompt
 * @param {string} options.chatId
 * @param {string[]} [options.kinds] generation types the lease may attach to
 */
export function armLease({ transactionId, prompt, chatId, kinds = ['normal'] }) {
    const kindSet = new Set(kinds);
    currentLease = { transactionId, prompt, chatId, kinds: kindSet, armedAt: Date.now() };
    leaseAudit = {
        transactionId,
        chatId,
        kinds: kindSet,
        matchingStarts: 0,
        applied: false,
        appliedSequence: null,
        closed: false,
    };
}

/**
 * What became of this transaction's lease.
 * @returns {{ applied: boolean, matchingStarts: number, appliedSequence: number|null } | null}
 */
export function getLeaseReceipt(transactionId) {
    if (leaseAudit?.transactionId !== transactionId) return null;
    return {
        applied: leaseAudit.applied,
        matchingStarts: leaseAudit.matchingStarts,
        appliedSequence: leaseAudit.appliedSequence,
    };
}

/** Stop auditing; later generations belong to somebody else. */
export function closeLeaseAudit(transactionId) {
    if (leaseAudit?.transactionId === transactionId) leaseAudit.closed = true;
}

export function disarmLease() {
    currentLease = null;
    clearPrompt();
}

export function isLeaseArmed() {
    return currentLease !== null;
}

export function isGenerationActive() {
    return generationActive;
}

/** True when GENERATION_STOPPED fired since the flag was last reset. */
export function wasGenerationStopped() {
    return stoppedFlag;
}

export function resetStoppedFlag() {
    stoppedFlag = false;
}

/**
 * When the chat tip is the revised suffix of a committed intercession, return
 * its transaction record from chat metadata (used for swipe re-leasing).
 */
function getTipSuffixRecord(ctx) {
    const chat = ctx?.chat;
    if (!Array.isArray(chat) || !chat.length) return null;
    const tip = chat[chat.length - 1];
    const marker = tip?.extra?.[METADATA_KEY];
    if (!marker || marker.role !== 'suffix' || !marker.transactionId) return null;
    const meta = getChatMetadata(ctx);
    const record = meta?.[METADATA_KEY]?.transactions?.[marker.transactionId];
    if (!record || record.state !== 'committed') return null;
    return record;
}

async function onGenerationStarted(type, _params, dryRun) {
    if (dryRun) return;
    generationActive = true;
    stoppedFlag = false;

    const kind = normalizeType(type);
    const ctx = getCtx();

    generationStartSequence += 1;

    // Count every start that could plausibly be the one the transaction is
    // waiting for, whether or not the lease is still armed — the generation
    // that stole it has already cleared `currentLease` by the time the real one
    // begins, which is precisely the case this is here to catch.
    if (leaseAudit && !leaseAudit.closed
        && getCurrentChatId(ctx) === leaseAudit.chatId
        && leaseAudit.kinds.has(kind)) {
        leaseAudit.matchingStarts += 1;
    }

    if (currentLease) {
        const fresh = Date.now() - currentLease.armedAt < LEASE_TTL_MS;
        const chatMatches = getCurrentChatId(ctx) === currentLease.chatId;
        if (fresh && chatMatches && currentLease.kinds.has(kind)) {
            setPrompt(currentLease.prompt);
            if (leaseAudit?.transactionId === currentLease.transactionId && !leaseAudit.closed) {
                leaseAudit.applied = true;
                leaseAudit.appliedSequence = generationStartSequence;
            }
        } else {
            // A different generation arrived first — the lease must not touch it.
            disarmLease();
        }
        return;
    }

    // Swipe / regenerate on a committed revised suffix: re-install the same
    // editorial instruction so the new swipe is another adaptation.
    if (kind === 'swipe' || kind === 'regenerate') {
        const record = getTipSuffixRecord(ctx);
        if (!record?.vaultKey) return;
        const vaultRecord = vaultGetCached(record.vaultKey) ?? await vaultGet(record.vaultKey);
        if (vaultRecord?.discardedSuffix) {
            setPrompt(buildRewritePrompt({ suffix: vaultRecord.discardedSuffix, mode: record.rewriteMode }));
        }
    }
}

function onGenerationEnded() {
    generationActive = false;
    if (currentLease) currentLease = null;
    clearPrompt();
}

function onGenerationStopped() {
    stoppedFlag = true;
    onGenerationEnded();
}

export function initLease() {
    if (initialized) return;
    const eventSource = getEventSource();
    const eventTypes = getEventTypes();
    if (!eventSource) return;
    initialized = true;

    if (eventTypes.GENERATION_STARTED) eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);
    if (eventTypes.GENERATION_ENDED) eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded);
    if (eventTypes.GENERATION_STOPPED) eventSource.on(eventTypes.GENERATION_STOPPED, onGenerationStopped);
    if (eventTypes.CHAT_CHANGED) {
        eventSource.on(eventTypes.CHAT_CHANGED, () => {
            generationActive = false;
            disarmLease();
        });
    }

    // Never start a session with a stale instruction installed.
    clearPrompt();
}
