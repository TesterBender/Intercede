/**
 * `/intercede diagnostics` as the user actually invokes it.
 *
 * The lease tests pin the bookkeeping; these pin the *report*. A diagnostics
 * report that describes records the same call is about to discard is worse than
 * no report — it is what sent a release investigation after a phantom.
 *
 * @see docs/RATIONALE.md#LEASE-11
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    emitHostGenerationEnded,
    emitHostSlashCommand,
    emitHostStart,
    installFakeSillyTavern,
    uninstallFakeSillyTavern,
} from './helpers/fake-context.js';

/** Boot the real entry point against the fake host. */
async function bootExtension() {
    vi.resetModules();
    const harness = installFakeSillyTavern();
    document.body.innerHTML = '<div id="extensions_settings2"></div><div id="chat"></div><div id="extensionsMenu"></div>';

    await import('../index.js');
    await vi.waitFor(() => expect(globalThis.Intercede).toBeDefined(), { timeout: 3000 });

    return harness;
}

beforeEach(() => {
    uninstallFakeSillyTavern();
    delete globalThis.Intercede;
    document.body.innerHTML = '';
});

describe('diagnostics reporting', () => {
    it('reports zero open at rest', async () => {
        const { ctx } = await bootExtension();
        ctx.isGenerating = false;

        const report = globalThis.Intercede.diagnostics();

        expect(report.eligibility).toMatchObject({ generationActive: false, openGenerations: 0 });
        expect(report.lease.openCount).toBe(0);
        expect(report.journal).toBeNull();
        expect(report.version).toBe('0.6.0');
    });

    /**
     * The reported bug, end to end: each `/intercede diagnostics` typed into the
     * composer leaks its own `Generate()` start, and the report used to be taken
     * *before* reconciliation cleared it — so the count appeared to climb with
     * every invocation.
     */
    it('does not climb across repeated invocations', async () => {
        const { ctx } = await bootExtension();
        ctx.isGenerating = false;

        const counts = [];
        for (let i = 0; i < 3; i++) {
            await emitHostSlashCommand(ctx, () => {
                counts.push(globalThis.Intercede.diagnostics().eligibility.openGenerations);
            });
        }

        expect(counts).toEqual([0, 0, 0]);
    });

    it('reports the post-reconciliation state, not the pre-reconciliation one', async () => {
        const { ctx } = await bootExtension();
        ctx.isGenerating = false;

        await emitHostSlashCommand(ctx, () => {
            const report = globalThis.Intercede.diagnostics();

            // The record existed when the call began and is gone by the time it
            // returns. The report must describe the second state.
            expect(report.eligibility.openGenerations).toBe(0);
            expect(report.lease.reconciledNow).toBe(1);
            expect(report.lease.reconcileReason).toBe('host-idle-reconciled');
            expect(report.eligibility.generationActive).toBe(false);
        });
    });

    it('still reports a genuinely running generation as open', async () => {
        const { ctx } = await bootExtension();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, undefined, {}, false);
        ctx.isGenerating = true;

        const report = globalThis.Intercede.diagnostics();

        expect(report.eligibility.generationActive).toBe(true);
        expect(report.eligibility.openGenerations).toBe(1);
        expect(report.lease.reconciledNow).toBe(0);
        expect(report.lease.reconcileReason).toBe('host-busy');
    });

    it('keeps the lifecycle log out of the report unless debug is enabled', async () => {
        const { ctx } = await bootExtension();
        ctx.isGenerating = false;

        expect(globalThis.Intercede.diagnostics().lifecycleLog).toMatch(/^not included/);

        ctx.extensionSettings.intercede.debugLifecycle = true;
        expect(Array.isArray(globalThis.Intercede.diagnostics().lifecycleLog)).toBe(true);
    });

    // The setting gates exposure, not collection: a buffer you must switch on
    // before the bug is a buffer that is empty when it matters.
    it('collects the lifecycle log even while the report hides it', async () => {
        const { ctx } = await bootExtension();
        ctx.isGenerating = false;

        await emitHostStart(ctx);
        await emitHostGenerationEnded(ctx);

        expect(globalThis.Intercede.diagnostics().lifecycleLog).toMatch(/^not included/);
        expect(globalThis.Intercede.lifecycleLog().length).toBeGreaterThan(0);
    });

    /**
     * The report is meant to be pasted into a bug tracker, so it is the one
     * place where a leak would be published rather than merely logged.
     * @see docs/RATIONALE.md#LEASE-14
     */
    it('carries neither prompt nor roleplay text, log included', async () => {
        const { ctx } = await bootExtension();
        const lease = await import('../src/lease.js');

        ctx.chat.push({ name: 'Them', is_user: false, is_system: false, mes: 'ROLEPLAY-CANARY in the chat.', extra: {} });
        lease.armLease({
            transactionId: 'tx-canary',
            chatId: ctx.getCurrentChatId(),
            prompt: 'PROMPT-CANARY — rewrite everything after this point.',
            kinds: ['normal'],
        });
        await emitHostStart(ctx);
        ctx.extensionSettings.intercede.debugLifecycle = true;

        const report = JSON.stringify(globalThis.Intercede.diagnostics());

        expect(report).not.toMatch(/PROMPT-CANARY/);
        expect(report).not.toMatch(/ROLEPLAY-CANARY/);
        lease.disarmLease();
    });

    it('resets counters without touching safety state', async () => {
        const { ctx } = await bootExtension();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, undefined, {}, false);
        ctx.isGenerating = true;

        globalThis.Intercede.resetDiagnostics();
        const report = globalThis.Intercede.diagnostics();

        expect(report.lease.events.starts).toBe(0);
        // The open record is safety state and survives the reset.
        expect(report.eligibility.openGenerations).toBe(1);
    });
});
