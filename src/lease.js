/**
 * One-generation lease (§11.5, §17.3).
 *
 * @see docs/RATIONALE.md#LEASE-01 instruction cannot leak into another generation
 * @see docs/RATIONALE.md#LEASE-06 swipe / regenerate re-leasing
 * @see docs/RATIONALE.md#LEASE-07 clearing on every exit path
 */

import { EXTENSION_PROMPT_KEY, LEASE_TTL_MS, METADATA_KEY } from './constants.js';
import { buildRewritePrompt } from './prompt.js';
import { getChatMetadata, getCtx, getCurrentChatId, getEventSource, getEventTypes, getPromptRoles, getPromptTypes, probeHostGeneration } from './stcontext.js';
import { vaultGet, vaultGetCached } from './vault.js';

/** @type {{ transactionId: string, prompt: string, chatId: string, kinds: Set<string>, armedAt: number } | null} */
let currentLease = null;
let stoppedFlag = false;
let initialized = false;
/** Monotonic generation-start counter. @see docs/RATIONALE.md#LEASE-03 */
let generationStartSequence = 0;
/**
 * Generations begun but not yet ended, oldest first.
 * @type {Array<{ sequence: number, kind: string, startedAt: number }>}
 * @see docs/RATIONALE.md#LEASE-04
 */
let openGenerations = [];

/** Event-hygiene tallies, surfaced by getLeaseDiagnostics(). @see docs/RATIONALE.md#LEASE-10 */
const tallies = {
    starts: 0,
    namedStarts: 0,
    defaultedStarts: 0,
    opaqueStarts: 0,
    dryRuns: 0,
    confirmedStarts: 0,
    unmatchedConfirmations: 0,
    ends: 0,
    unmatchedEnds: 0,
    kindMismatchedEnds: 0,
    opaqueEnds: 0,
    reconciledFromHostIdle: 0,
    reconciledUnconfirmed: 0,
    stops: 0,
};

/**
 * Generation types SillyTavern's `Generate()` dispatches on.
 * `GENERATION_STARTED` carries one of these (or nothing, meaning `normal`).
 * @see docs/RATIONALE.md#LEASE-12
 */
const GENERATION_KINDS = new Set([
    'normal',
    'quiet',
    'impersonate',
    'continue',
    'swipe',
    'regenerate',
]);

/**
 * Does this payload actually name a generation type?
 *
 * On SillyTavern 1.18.0 `GENERATION_ENDED` never does — it carries `chat.length`.
 * Only a payload that is demonstrably a known kind may steer record selection.
 * @see docs/RATIONALE.md#LEASE-12
 */
function isRecognizedGenerationKind(payload) {
    return typeof payload === 'string' && GENERATION_KINDS.has(payload);
}

/**
 * Classify a generation-type argument carried by a host event.
 *
 * `Generate(type)` leaves `type` undefined for an ordinary send, so an absent
 * value is `normal` *by the host's own contract* — that is `defaulted`, not a
 * guess. A recognized string is `named`. Anything else is `opaque`: it is not
 * called a kind, because nothing proves it is one.
 *
 * Exported because `MESSAGE_RECEIVED` carries the same argument.
 * @see docs/RATIONALE.md#LEASE-13
 * @see docs/RATIONALE.md#CAP-06
 */
export function classifyGenerationKind(type) {
    if (type === undefined || type === null || type === '') {
        return { kind: 'normal', source: 'defaulted' };
    }
    if (isRecognizedGenerationKind(type)) return { kind: type, source: 'named' };
    return { kind: 'unknown', source: 'opaque' };
}

/* ------------------------------------------------------------------------- *
 * Lifecycle event log — bounded, metadata only.
 * @see docs/RATIONALE.md#LEASE-14
 * ------------------------------------------------------------------------- */

const EVENT_LOG_LIMIT = 64;
/** @type {Array<object>} */
let eventLog = [];

/**
 * Describe one event argument without ever copying content out of it.
 *
 * Strings are reproduced only when they are identifier-shaped and short — a
 * generation kind survives, a prompt or a line of roleplay cannot. Objects
 * contribute their key names only; `quiet_prompt` is a key, its value is text.
 * @see docs/RATIONALE.md#LEASE-14
 */
function describeArg(value) {
    if (value === null) return { type: 'null' };
    if (Array.isArray(value)) return { type: 'array', length: value.length };
    switch (typeof value) {
        case 'undefined': return { type: 'undefined' };
        case 'number': return { type: 'number', value };
        case 'boolean': return { type: 'boolean', value };
        case 'string':
            return value.length <= 24 && /^[\w-]+$/.test(value)
                ? { type: 'string', value }
                : { type: 'string', length: value.length };
        case 'object': return { type: 'object', keys: Object.keys(value).slice(0, 12) };
        default: return { type: typeof value };
    }
}

function logLifecycleEvent(event, args, extra = {}) {
    eventLog.push({
        event,
        at: Date.now(),
        args: args.map(describeArg),
        chatId: getCurrentChatId(getCtx()) ?? null,
        host: probeHostGeneration().state,
        leaseArmed: currentLease !== null,
        transactionId: currentLease?.transactionId ?? leaseAudit?.transactionId ?? null,
        generationStartSequence,
        ...extra,
    });
    if (eventLog.length > EVENT_LOG_LIMIT) eventLog = eventLog.slice(-EVENT_LOG_LIMIT);
}

/** The bounded lifecycle log. Metadata only. @see docs/RATIONALE.md#LEASE-14 */
export function getLifecycleLog() {
    return eventLog.map(entry => ({ ...entry, ageMs: Date.now() - entry.at }));
}

/**
 * Clear counters and the event log. Diagnostic only.
 *
 * Deliberately touches **no** safety state: open records, the lease, the audit,
 * the stop flag and the start sequence all survive, because a transaction in
 * flight reads every one of them. @see docs/RATIONALE.md#LEASE-14
 */
export function resetLeaseTallies() {
    const cleared = { ...tallies };
    for (const key of Object.keys(tallies)) tallies[key] = 0;
    eventLog = [];
    return { cleared, openCount: openCount(), leaseArmed: currentLease !== null };
}

function openCount() {
    return openGenerations.length;
}

/**
 * A dry run is announced by a boolean `true` among the event arguments.
 * @see docs/RATIONALE.md#LEASE-08 why the position is not assumed
 */
function isDryRunSignal(args) {
    return args.some(arg => arg === true);
}

function snapshotRecords() {
    const now = Date.now();
    return openGenerations.map(record => ({ ...record, ageMs: now - record.startedAt }));
}

/**
 * Probe the host, reconcile, and report — in one indivisible step.
 *
 * Eligibility, the diagnostics report and the lease baseline used to probe
 * independently, so each observed a different DOM moment and the report could
 * describe a state that reconciliation had already discarded.
 *
 * The host is read **twice**. A signal that disagrees with itself is not
 * evidence, so an unstable probe reconciles nothing and says so.
 *
 * @param {object} [options]
 * @param {boolean} [options.reconcile] false to observe without ever dropping records
 * @returns {{ host: object, active: boolean, openBefore: object[], openAfter: object[],
 *   reconciledNow: number, reason: string }}
 * @see docs/RATIONALE.md#LEASE-10
 */
export function getGenerationSnapshot({ reconcile = true } = {}) {
    const first = probeHostGeneration();
    const second = probeHostGeneration();
    const stable = first.state === second.state;
    const host = { ...second, stable, previousState: first.state };

    const openBefore = snapshotRecords();
    let reconciledNow = 0;
    let reason;

    if (host.state === 'busy') {
        reason = 'host-busy';
    } else if (host.state === 'unknown') {
        reason = 'host-cannot-answer-records-decide';
    } else if (!stable) {
        // @see docs/RATIONALE.md#LEASE-10 — a flickering probe may not destroy records
        reason = 'probe-unstable';
    } else if (!reconcile) {
        reason = 'observation-only';
    } else if (currentLease) {
        // @see docs/RATIONALE.md#LEASE-10 — never while a transaction depends on the baseline
        reason = 'lease-armed-records-kept';
    } else if (openBefore.length) {
        reconciledNow = openBefore.length;
        tallies.reconciledFromHostIdle += reconciledNow;
        tallies.reconciledUnconfirmed += openBefore.filter(record => !record.confirmed).length;
        openGenerations = [];
        reason = 'host-idle-reconciled';
    } else {
        reason = 'host-idle-nothing-open';
    }

    const openAfter = snapshotRecords();
    let active;
    if (host.state === 'busy') active = true;
    else if (host.state === 'idle' && stable) active = false;
    else active = openAfter.length > 0;

    return { host, active, openBefore, openAfter, reconciledNow, reason };
}

/**
 * What became of one transaction's lease. Outlives the lease itself.
 * @see docs/RATIONALE.md#LEASE-02 armed vs applied vs still-installed
 */
let leaseAudit = null;

export function getGenerationStartSequence() {
    return generationStartSequence;
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
    // Reconcile *before* the baseline is taken, while no lease is armed and the
    // drop is still safe. A record the host has already disowned — a composer
    // slash command's aborted start, say — would otherwise be baselined as a
    // real overlap and reject a perfectly good intercession.
    // @see docs/RATIONALE.md#LEASE-15
    const settled = getGenerationSnapshot();

    const kindSet = new Set(kinds);
    currentLease = { transactionId, prompt, chatId, kinds: kindSet, armedAt: Date.now() };
    leaseAudit = {
        transactionId,
        chatId,
        kinds: kindSet,
        // @see docs/RATIONALE.md#LEASE-04 — recorded, never reset
        baselineOpenGenerations: openCount(),
        baselineReconciled: settled.reconciledNow,
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
 *   promptIntegrityLost: boolean, baselineOpenGenerations: number } | null}
 */
export function getLeaseReceipt(transactionId) {
    if (leaseAudit?.transactionId !== transactionId) return null;
    return {
        applied: leaseAudit.applied,
        matchingStarts: leaseAudit.matchingStarts,
        appliedSequence: leaseAudit.appliedSequence,
        interferingStarts: [...leaseAudit.interferingStarts],
        promptIntegrityLost: leaseAudit.promptIntegrityLost,
        baselineOpenGenerations: leaseAudit.baselineOpenGenerations,
        baselineReconciled: leaseAudit.baselineReconciled,
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

/**
 * Is a generation running right now?
 * @see docs/RATIONALE.md#LEASE-10 the host answers first; the count is the fallback
 */
export function isGenerationActive() {
    return getGenerationSnapshot().active;
}

/**
 * Everything the lease knows about generation lifecycle events on this build.
 *
 * Reconciles first and reports what is true **after** it, because a report that
 * describes records the very same call is about to discard is worse than no
 * report — it sent a release investigation after a phantom.
 * @see docs/RATIONALE.md#LEASE-11 — what to look at first when it misbehaves
 */
export function getLeaseDiagnostics() {
    const settled = getGenerationSnapshot();
    return {
        host: settled.host,
        generationActive: settled.active,
        open: settled.openAfter,
        openCount: settled.openAfter.length,
        unconfirmedOpen: settled.openAfter.filter(record => !record.confirmed).length,
        reconciledNow: settled.reconciledNow,
        reconcileReason: settled.reason,
        generationStartSequence,
        stoppedFlag,
        leaseArmed: currentLease !== null,
        auditTransactionId: leaseAudit?.transactionId ?? null,
        auditClosed: leaseAudit?.closed ?? null,
        events: { ...tallies },
    };
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

async function onGenerationStarted(type, ...rest) {
    const openBefore = openCount();
    // @see docs/RATIONALE.md#LEASE-08 (deliberate exemption)
    if (isDryRunSignal(rest)) {
        tallies.dryRuns += 1;
        logLifecycleEvent('GENERATION_STARTED', [type, ...rest], {
            dryRun: true, openBefore, openAfter: openBefore,
        });
        return;
    }
    stoppedFlag = false;

    const { kind, source } = classifyGenerationKind(type);
    const ctx = getCtx();

    generationStartSequence += 1;
    tallies.starts += 1;
    if (source === 'named') tallies.namedStarts += 1;
    else if (source === 'defaulted') tallies.defaultedStarts += 1;
    else tallies.opaqueStarts += 1;

    openGenerations.push({
        sequence: generationStartSequence,
        kind,
        kindSource: source,
        startedAt: Date.now(),
        // Set by GENERATION_AFTER_COMMANDS. @see docs/RATIONALE.md#LEASE-15
        confirmed: false,
    });
    logLifecycleEvent('GENERATION_STARTED', [type, ...rest], {
        kind, kindSource: source, sequence: generationStartSequence,
        openBefore, openAfter: openCount(),
    });

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
                if (openCount() > 1) leaseAudit.promptIntegrityLost = true;
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

/**
 * Mark a start as having survived slash-command processing.
 *
 * `Generate()` emits `GENERATION_STARTED` unconditionally — its own comment says
 * "even if the generation is aborted due to slash commands execution" — and then
 * emits `GENERATION_AFTER_COMMANDS` only on the path that continues. A record
 * that never gets confirmed is a generation that never happened.
 *
 * This does not close anything. It labels, so the leak is nameable in
 * diagnostics instead of looking like a lost end event.
 * @see docs/RATIONALE.md#LEASE-15
 */
function onGenerationAfterCommands(type, ...rest) {
    if (isDryRunSignal(rest)) return;

    const { kind } = classifyGenerationKind(type);
    for (let i = openGenerations.length - 1; i >= 0; i--) {
        if (!openGenerations[i].confirmed && openGenerations[i].kind === kind) {
            openGenerations[i].confirmed = true;
            tallies.confirmedStarts += 1;
            logLifecycleEvent('GENERATION_AFTER_COMMANDS', [type, ...rest], {
                kind, sequence: openGenerations[i].sequence,
            });
            return;
        }
    }
    tallies.unmatchedConfirmations += 1;
    logLifecycleEvent('GENERATION_AFTER_COMMANDS', [type, ...rest], { kind, unmatched: true });
}

/**
 * Close the open record this end most plausibly belongs to.
 *
 * The payload is treated as opaque unless it is demonstrably a generation kind
 * ([LEASE-12](docs/RATIONALE.md#LEASE-12)); on SillyTavern 1.18.0 it is `chat.length`.
 * Either way exactly one record closes, so the count can only ever be wrong
 * upward — the direction [LEASE-04](docs/RATIONALE.md#LEASE-04) requires.
 *
 * @see docs/RATIONALE.md#LEASE-04 — the event never names an identity
 */
function closeOpenGeneration(payload) {
    tallies.ends += 1;
    if (!openGenerations.length) {
        tallies.unmatchedEnds += 1;
        return;
    }

    let index = -1;
    if (isRecognizedGenerationKind(payload)) {
        for (let i = openGenerations.length - 1; i >= 0; i--) {
            if (openGenerations[i].kind === payload) { index = i; break; }
        }
        // A named kind that matches nothing open is a real inconsistency.
        if (index === -1) tallies.kindMismatchedEnds += 1;
    } else {
        // The host said "a generation finished" without saying which.
        tallies.opaqueEnds += 1;
    }

    if (index === -1) index = openGenerations.length - 1;
    openGenerations.splice(index, 1);
}

function onGenerationEnded(payload) {
    const openBefore = openCount();
    closeOpenGeneration(payload);
    logLifecycleEvent('GENERATION_ENDED', [payload], {
        opaque: !isRecognizedGenerationKind(payload),
        openBefore, openAfter: openCount(),
    });
    if (currentLease) currentLease = null;
    clearPrompt();
}

/** @see docs/RATIONALE.md#LEASE-09 — a stop does not close a record; the end does */
function onGenerationStopped() {
    tallies.stops += 1;
    stoppedFlag = true;
    logLifecycleEvent('GENERATION_STOPPED', [], { openBefore: openCount(), openAfter: openCount() });
    if (currentLease) currentLease = null;
    clearPrompt();
}

export function initLease() {
    if (initialized) return;
    const eventSource = getEventSource();
    const eventTypes = getEventTypes();
    if (!eventSource) return;
    initialized = true;

    if (eventTypes.GENERATION_STARTED) eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);
    // Optional: absent on hosts that do not emit it, in which case records simply
    // stay unconfirmed and nothing else changes. @see docs/RATIONALE.md#LEASE-15
    if (eventTypes.GENERATION_AFTER_COMMANDS) {
        eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
    }
    if (eventTypes.GENERATION_ENDED) eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded);
    if (eventTypes.GENERATION_STOPPED) eventSource.on(eventTypes.GENERATION_STOPPED, onGenerationStopped);
    if (eventTypes.CHAT_CHANGED) {
        // @see docs/RATIONALE.md#LEASE-09 — the one place the records are dropped wholesale
        eventSource.on(eventTypes.CHAT_CHANGED, () => {
            openGenerations = [];
            disarmLease();
        });
    }

    clearPrompt(); // @see docs/RATIONALE.md#LEASE-07
}
