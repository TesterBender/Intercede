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
import { emitHostSlashCommand, installFakeSillyTavern, uninstallFakeSillyTavern } from './helpers/fake-context.js';

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

        expect(globalThis.Intercede.diagnostics().lifecycleLog).toBe('disabled');

        ctx.extensionSettings.intercede.debugLifecycle = true;
        expect(Array.isArray(globalThis.Intercede.diagnostics().lifecycleLog)).toBe(true);
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
