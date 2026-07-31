/**
 * One-generation lease (§11.5, §17.3).
 *
 * @see docs/RATIONALE.md#LEASE-01 instruction cannot leak into another generation
 * @see docs/RATIONALE.md#LEASE-06 swipe / regenerate re-leasing
 * @see docs/RATIONALE.md#LEASE-07 clearing on every exit path
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
/** Monotonic generation-start counter. @see docs/RATIONALE.md#LEASE-03 */
let generationStartSequence = 0;
/** Generations begun but not yet ended. @see docs/RATIONALE.md#LEASE-04 */
let openGenerations = 0;

/**
 * What became of one transaction's lease. Outlives the lease itself.
 * @see docs/RATIONALE.md#LEASE-02 armed vs applied vs still-installed
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
    openGenerations = generationActive ? 1 : 0;
    currentLease = { transactionId, prompt, chatId, kinds: kindSet, armedAt: Date.now() };
    leaseAudit = {
        transactionId,
        chatId,
        kinds: kindSet,
        matchingStarts: 0,
        applied: false,
        appliedSequence: null,
        interferingStarts: [],
        promptIntegrityLost: false,
        closed: false,
    };
}

/**
 * What became of this transaction's lease.
 * @returns {{ applied: boolean, matchingStarts: number, appliedSequence: number|null,
 *   interferingStarts: Array<{ sequence: number, kind: string, chatMatches: boolean }>,
 *   promptIntegrityLost: boolean } | null}
 */
export function getLeaseReceipt(transactionId) {
    if (leaseAudit?.transactionId !== transactionId) return null;
    return {
        applied: leaseAudit.applied,
        matchingStarts: leaseAudit.matchingStarts,
        appliedSequence: leaseAudit.appliedSequence,
        interferingStarts: [...leaseAudit.interferingStarts],
        promptIntegrityLost: leaseAudit.promptIntegrityLost,
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

/** Transaction record when the chat tip is a committed revised suffix, else null. */
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
    if (dryRun) return; // @see docs/RATIONALE.md#LEASE-08 (deliberate exemption)
    generationActive = true;
    stoppedFlag = false;

    const kind = normalizeType(type);
    const ctx = getCtx();

    generationStartSequence += 1;
    openGenerations += 1;

    // @see docs/RATIONALE.md#LEASE-03 (matching) and #LEASE-05 (interfering)
    if (leaseAudit && !leaseAudit.closed) {
        const auditChatMatches = getCurrentChatId(ctx) === leaseAudit.chatId;
        if (auditChatMatches && leaseAudit.kinds.has(kind)) {
            leaseAudit.matchingStarts += 1;
        } else {
            leaseAudit.interferingStarts.push({
                sequence: generationStartSequence,
                kind,
                chatMatches: auditChatMatches,
            });
            if (leaseAudit.applied && generationStartSequence > leaseAudit.appliedSequence) {
                leaseAudit.promptIntegrityLost = true;
            }
        }
    }

    if (currentLease) {
        const fresh = Date.now() - currentLease.armedAt < LEASE_TTL_MS;
        const chatMatches = getCurrentChatId(ctx) === currentLease.chatId;
        if (fresh && chatMatches && currentLease.kinds.has(kind)) {
            setPrompt(currentLease.prompt);
            if (leaseAudit?.transactionId === currentLease.transactionId && !leaseAudit.closed) {
                leaseAudit.applied = true;
                leaseAudit.appliedSequence = generationStartSequence;
                // @see docs/RATIONALE.md#LEASE-04
                if (openGenerations > 1) leaseAudit.promptIntegrityLost = true;
            }
        } else {
            disarmLease();
        }
        return;
    }

    // @see docs/RATIONALE.md#LEASE-06
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
    openGenerations = Math.max(0, openGenerations - 1);
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
            openGenerations = 0;
            disarmLease();
        });
    }

    clearPrompt(); // @see docs/RATIONALE.md#LEASE-07
}
