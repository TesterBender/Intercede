/**
 * Intercede — post-generation conversational insertion for SillyTavern.
 *
 * Respond inside an already completed assistant message: pick a boundary, write
 * your reply, and the remainder is regenerated as a real Assistant → User →
 * Assistant exchange, with the original continuation kept as recoverable,
 * non-canonical editorial reference.
 *
 * Entry point: capability check, lease, UI, slash commands, crash recovery.
 */

import { INTERCEDE_EVENTS } from './src/constants.js';
import { getLeaseDiagnostics, getLifecycleLog, initLease, resetLeaseTallies } from './src/lease.js';
import { resolvePromptConfig } from './src/prompt-config.js';
import { getBoundaries, getProtectedRanges } from './src/segmentation.js';
import {
    checkCapabilities,
    getCtx,
    getCurrentChatId,
    getEventSource,
    getEventTypes,
    getSettings,
    saveSettings,
} from './src/stcontext.js';
import { checkRecovery, cleanupSnapshots, finalizeIntercession, undoIntercession } from './src/transaction.js';
import { showCompare } from './src/ui/compare.js';
import { initMessageButtons, refreshButtonVisibilityDebounced } from './src/ui/message-button.js';
import { showConfirm } from './src/ui/modal.js';
import { closeAllModes, openIntercede } from './src/ui/open.js';
import { initSettingsPanel } from './src/ui/settings.js';
import { notify, waitUntil } from './src/utils.js';
import { readJournal, vaultKeys } from './src/vault.js';

const VERSION = '0.7.0';

/**
 * What the *loaded* code actually does, probed rather than asserted.
 * @see docs/RATIONALE.md#LEASE-11 why a version string cannot answer this
 */
function probeParserBuild() {
    const has = (text, kind) => getProtectedRanges(text).some(range => range.kind === kind);
    try {
        return {
            referenceLinks: has('See [the map][map] here.', 'link'),
            linkDefinitions: has('[map]: http://example.test/a', 'link-definition'),
            // `\\*` is a literal backslash and a *live* delimiter (even parity).
            backslashParity: has('a \\\\*emphasis* b', 'emphasis'),
            intrawordEmphasis: has('foo*bar*baz', 'emphasis'),
            listContinuation: getProtectedRanges('- one\n\n  cont. more\n- two')
                .filter(range => range.kind === 'list').length === 1,
            blankLineParagraphs: getBoundaries('One line.\nTwo lines.', 'paragraph').length === 0,
        };
    } catch (error) {
        return { error: String(error?.message ?? error) };
    }
}

async function handleSlashCommand(action) {
    switch (String(action ?? '').trim().toLowerCase()) {
        case '':
            openIntercede();
            return '';
        case 'undo': {
            const result = await undoIntercession();
            if (!result.ok) notify('warning', result.reason);
            return '';
        }
        case 'compare':
            await showCompare();
            return '';
        case 'recover':
            await checkRecovery();
            return '';
        case 'finalize': {
            const confirmed = await showConfirm(
                'Finalize intercession?',
                'The undo snapshot for the intercession at the end of this chat will be deleted permanently. The messages stay exactly as they are, but Undo and Compare will no longer be available for it.',
                { confirmLabel: 'Delete snapshot', cancelLabel: 'Keep it' },
            );
            if (!confirmed) return '';
            const result = await finalizeIntercession();
            if (!result.ok) notify('warning', result.reason);
            refreshButtonVisibilityDebounced();
            return '';
        }
        case 'diagnostics': {
            const report = collectDiagnostics();
            console.info('[Intercede] diagnostics', report);
            notify('info', describeDiagnostics(report));
            return JSON.stringify(report, null, 2);
        }
        // Counters and the event log only. Nothing that decides safety.
        // @see docs/RATIONALE.md#LEASE-14
        case 'diagnostics reset':
        case 'reset': {
            const result = resetLeaseTallies();
            console.info('[Intercede] diagnostics counters reset', result);
            notify('info', `Diagnostic counters and event log cleared. ${result.openCount} open generation(s) and the lease state were left untouched.`);
            return '';
        }
        case 'cleanup': {
            const days = getSettings().snapshotTtlDays;
            const result = await cleanupSnapshots(days);
            if (!result.ok) {
                notify('warning', result.reason);
                return '';
            }
            const remaining = (await vaultKeys()).length;
            notify('info', days > 0
                ? `Removed ${result.removed} snapshot(s) older than ${days} day(s); ${remaining} remain.`
                : `Snapshot age limit is 0 (keep forever); ${remaining} snapshot(s) stored.`);
            return '';
        }
        default:
            notify('warning', `Unknown /intercede action "${action}". Use: undo, compare, recover, finalize, cleanup, diagnostics, reset.`);
            return '';
    }
}

/**
 * A snapshot of everything that decides eligibility, for bug reports.
 * @see docs/RATIONALE.md#LEASE-11
 */
function collectDiagnostics() {
    const ctx = getCtx();
    // One call, one reconciliation, one truth. `getLeaseDiagnostics()` settles the
    // host state and reports what is left afterwards; asking `isGenerationActive()`
    // separately used to reconcile *after* this object had already been built, so
    // every idle report described records that no longer existed.
    // @see docs/RATIONALE.md#LEASE-11
    const lease = getLeaseDiagnostics();
    return {
        version: VERSION,
        // @see docs/RATIONALE.md#LEASE-11 — capability, not a version string
        parserBuild: probeParserBuild(),
        capabilities: checkCapabilities(),
        eligibility: {
            generationActive: lease.generationActive,
            hostSays: lease.host,
            openGenerations: lease.openCount,
        },
        lease,
        // Exposure only; collection is unconditional. @see docs/RATIONALE.md#LEASE-14
        lifecycleLog: getSettings().debugLifecycle
            ? getLifecycleLog()
            : 'not included — Intercede.setDebugLifecycle(true), or read it now with Intercede.lifecycleLog()',
        journal: readJournal(),
        // Which instruction this install sends — never its text.
        // @see docs/RATIONALE.md#PROMPT-02
        prompt: (() => {
            const { presetId, customized, fallback } = resolvePromptConfig();
            return { preset: presetId, customized, fallback };
        })(),
        chat: {
            id: getCurrentChatId(ctx),
            length: Array.isArray(ctx?.chat) ? ctx.chat.length : null,
        },
    };
}

/**
 * The one line the user pastes into a bug report.
 * Everything else stays in the console. @see docs/RATIONALE.md#LEASE-11
 */
function describeDiagnostics(report) {
    const { hostSays, openGenerations, generationActive } = report.eligibility;
    const { unconfirmedOpen, reconciledNow } = report.lease;
    const { kindMismatchedEnds, unmatchedEnds } = report.lease.events;

    const notes = [];
    if (unconfirmedOpen) notes.push(`${unconfirmedOpen} unconfirmed`);
    if (reconciledNow) notes.push(`${reconciledNow} reconciled now`);
    // On a host that names no kind these must stay at zero.
    // @see docs/RATIONALE.md#LEASE-12
    if (kindMismatchedEnds) notes.push(`${kindMismatchedEnds} kind mismatches`);
    if (unmatchedEnds) notes.push(`${unmatchedEnds} unmatched ends`);
    if (report.journal) notes.push('journal present');

    return [
        `generation ${generationActive ? 'ACTIVE' : 'idle'}`,
        `host ${hostSays.state} (${hostSays.confidence}) via ${hostSays.source}`,
        `${openGenerations} open`,
        notes.length ? notes.join(', ') : 'clean',
        'full report in the browser console',
    ].join(' — ');
}

function registerSlashCommands(ctx) {
    try {
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx;
        if (SlashCommandParser?.addCommandObject && SlashCommand?.fromProps) {
            const unnamedArgumentList = [];
            if (SlashCommandArgument?.fromProps) {
                unnamedArgumentList.push(SlashCommandArgument.fromProps({
                    description: 'action: undo | compare | recover | finalize | cleanup | diagnostics | reset (empty opens boundary selection)',
                    typeList: ARGUMENT_TYPE ? [ARGUMENT_TYPE.STRING] : undefined,
                    isRequired: false,
                }));
            }
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: 'intercede',
                callback: (_namedArgs, value) => handleSlashCommand(value),
                unnamedArgumentList,
                helpString: 'Respond inside the latest completed assistant message. Actions: <code>undo</code>, <code>compare</code>, <code>recover</code>, <code>finalize</code>, <code>cleanup</code>, <code>diagnostics</code>, <code>reset</code> (diagnostic counters only).',
            }));
            return;
        }
        if (typeof ctx.registerSlashCommand === 'function') {
            ctx.registerSlashCommand(
                'intercede',
                (_namedArgs, value) => handleSlashCommand(value),
                [],
                '<span class="monospace">(undo | compare | recover | finalize | cleanup | diagnostics | reset)</span> – respond inside the latest assistant message',
                true,
                true,
            );
        }
    } catch (error) {
        console.warn('[Intercede] slash command registration failed', error);
    }
}

let initialized = false;

async function init() {
    if (initialized) return;
    const capabilities = checkCapabilities();
    if (!capabilities.ok) {
        console.error('[Intercede] required context capabilities are missing:', capabilities.missing.join(', '));
        notify('error', `Intercede cannot start — this SillyTavern build is missing: ${capabilities.missing.join(', ')}`);
        return;
    }
    if (capabilities.optionalMissing.length) {
        console.info('[Intercede] optional capabilities unavailable (fallbacks in use):', capabilities.optionalMissing.join(', '));
    }
    initialized = true;

    const ctx = getCtx();
    getSettings(ctx); // materialize defaults into extension settings

    initLease();
    initSettingsPanel();
    initMessageButtons();
    registerSlashCommands(ctx);

    const eventSource = getEventSource();
    const eventTypes = getEventTypes();
    if (eventTypes.CHAT_CHANGED) {
        eventSource?.on(eventTypes.CHAT_CHANGED, async () => {
            closeAllModes();
            refreshButtonVisibilityDebounced();
            await checkRecovery();
        });
    }
    if (eventTypes.GENERATION_STARTED) {
        // @see docs/RATIONALE.md#UI-10
        eventSource?.on(eventTypes.GENERATION_STARTED, (_type, _params, dryRun) => {
            if (!dryRun) closeAllModes();
        });
    }
    // The one signal timed to the commit rather than to the generation.
    // @see docs/RATIONALE.md#UI-08
    eventSource?.on(INTERCEDE_EVENTS.INVALIDATED, refreshButtonVisibilityDebounced);

    if (eventTypes.APP_READY) {
        eventSource?.on(eventTypes.APP_READY, async () => {
            refreshButtonVisibilityDebounced();
            await checkRecovery();
        });
    }

    // A chat may already be open by the time the extension loads.
    await checkRecovery();
    cleanupSnapshots(getSettings().snapshotTtlDays).catch(() => { /* best-effort */ });

    // Tiny public surface for other extensions and the console (§17.5).
    globalThis.Intercede = Object.freeze({
        version: VERSION,
        open: openIntercede,
        undo: undoIntercession,
        compare: showCompare,
        recover: checkRecovery,
        diagnostics: collectDiagnostics,
        // @see docs/RATIONALE.md#LEASE-14 — diagnostic only, no safety state
        lifecycleLog: getLifecycleLog,
        resetDiagnostics: resetLeaseTallies,
        /** Include the lifecycle log in `diagnostics()`. @see docs/RATIONALE.md#LEASE-14 */
        setDebugLifecycle: (on = true) => {
            getSettings().debugLifecycle = Boolean(on);
            saveSettings();
            return getSettings().debugLifecycle;
        },
        events: INTERCEDE_EVENTS,
    });

    console.info(`[Intercede] v${VERSION} ready`);
}

async function bootstrap() {
    const ready = await waitUntil(() => globalThis.SillyTavern?.getContext?.(), 20000, 250);
    if (!ready) {
        console.error('[Intercede] SillyTavern context never became available.');
        return;
    }
    await init();
}

if (globalThis.jQuery) {
    globalThis.jQuery(() => { bootstrap(); });
} else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { bootstrap(); });
} else {
    bootstrap();
}
