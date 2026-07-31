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
import { getLeaseDiagnostics, initLease, isGenerationActive } from './src/lease.js';
import {
    checkCapabilities,
    getCtx,
    getCurrentChatId,
    getEventSource,
    getEventTypes,
    getSettings,
} from './src/stcontext.js';
import { checkRecovery, finalizeIntercession, undoIntercession } from './src/transaction.js';
import { showCompare } from './src/ui/compare.js';
import { initMessageButtons, refreshButtonVisibilityDebounced } from './src/ui/message-button.js';
import { showConfirm } from './src/ui/modal.js';
import { closeAllModes, openIntercede } from './src/ui/open.js';
import { initSettingsPanel } from './src/ui/settings.js';
import { notify, waitUntil } from './src/utils.js';
import { cleanupVault, readJournal, vaultKeys } from './src/vault.js';

const VERSION = '0.5.0';

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
        case 'cleanup': {
            const days = getSettings().snapshotTtlDays;
            const removed = days > 0 ? await cleanupVault(days) : 0;
            const remaining = (await vaultKeys()).length;
            notify('info', days > 0
                ? `Removed ${removed} snapshot(s) older than ${days} day(s); ${remaining} remain.`
                : `Snapshot age limit is 0 (keep forever); ${remaining} snapshot(s) stored.`);
            return '';
        }
        default:
            notify('warning', `Unknown /intercede action "${action}". Use: undo, compare, recover, finalize, cleanup, diagnostics.`);
            return '';
    }
}

/**
 * A snapshot of everything that decides eligibility, for bug reports.
 * @see docs/RATIONALE.md#LEASE-11
 */
function collectDiagnostics() {
    const ctx = getCtx();
    const lease = getLeaseDiagnostics();
    return {
        version: VERSION,
        capabilities: checkCapabilities(),
        eligibility: {
            generationActive: isGenerationActive(),
            hostSays: lease.host,
            openGenerations: lease.openCount,
        },
        lease,
        journal: readJournal(),
        chat: {
            id: getCurrentChatId(ctx),
            length: Array.isArray(ctx?.chat) ? ctx.chat.length : null,
        },
    };
}

function describeDiagnostics(report) {
    const { hostSays, openGenerations, generationActive } = report.eligibility;
    const { unmatchedEnds, dryRuns, starts, ends } = report.lease.events;
    return [
        `generation ${generationActive ? 'ACTIVE' : 'idle'}`,
        `host ${hostSays.state} via ${hostSays.source}`,
        `${openGenerations} open`,
        `${starts} starts / ${ends} ends / ${dryRuns} dry runs / ${unmatchedEnds} unmatched ends`,
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
                    description: 'action: undo | compare | recover | finalize | cleanup | diagnostics (empty opens boundary selection)',
                    typeList: ARGUMENT_TYPE ? [ARGUMENT_TYPE.STRING] : undefined,
                    isRequired: false,
                }));
            }
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: 'intercede',
                callback: (_namedArgs, value) => handleSlashCommand(value),
                unnamedArgumentList,
                helpString: 'Respond inside the latest completed assistant message. Actions: <code>undo</code>, <code>compare</code>, <code>recover</code>, <code>finalize</code>, <code>cleanup</code>, <code>diagnostics</code>.',
            }));
            return;
        }
        if (typeof ctx.registerSlashCommand === 'function') {
            ctx.registerSlashCommand(
                'intercede',
                (_namedArgs, value) => handleSlashCommand(value),
                [],
                '<span class="monospace">(undo | compare | recover | finalize | cleanup | diagnostics)</span> – respond inside the latest assistant message',
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
    if (eventTypes.APP_READY) {
        eventSource?.on(eventTypes.APP_READY, async () => {
            refreshButtonVisibilityDebounced();
            await checkRecovery();
        });
    }

    // A chat may already be open by the time the extension loads.
    await checkRecovery();
    cleanupVault(getSettings().snapshotTtlDays).catch(() => { /* best-effort */ });

    // Tiny public surface for other extensions and the console (§17.5).
    globalThis.Intercede = Object.freeze({
        version: VERSION,
        open: openIntercede,
        undo: undoIntercession,
        compare: showCompare,
        recover: checkRecovery,
        diagnostics: collectDiagnostics,
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
