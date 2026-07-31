/**
 * Generation-lease state, tested directly rather than through a transaction.
 *
 * The transaction-level tests can only observe the lease through its receipt.
 * These pin the counter itself, because everything upstream of the receipt —
 * preflight eligibility, the settle wait, prompt-integrity detection — reads it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshModules, installFakeSillyTavern, uninstallFakeSillyTavern } from './helpers/fake-context.js';

async function setup() {
    vi.resetModules();
    const harness = installFakeSillyTavern();
    const modules = await freshModules();
    modules.lease.initLease();
    return { ...harness, ...modules };
}

beforeEach(() => {
    uninstallFakeSillyTavern();
});

describe('open-generation tracking', () => {
    it('remains active until every open generation ends', async () => {
        const { ctx, lease } = await setup();
        const start = kind => ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, kind, {}, false);
        const end = kind => ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, kind);

        expect(lease.isGenerationActive()).toBe(false);

        await start('quiet');
        await start('impersonate');
        await end('quiet');

        // @see docs/RATIONALE.md#LEASE-04 — a boolean cannot represent this state.
        expect(lease.isGenerationActive()).toBe(true);

        await end('impersonate');
        expect(lease.isGenerationActive()).toBe(false);
    });

    it('does not go negative on an unpaired end', async () => {
        const { ctx, lease } = await setup();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
        expect(lease.isGenerationActive()).toBe(false);

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
        expect(lease.isGenerationActive()).toBe(true);
    });

    // A dry run is a prompt-assembly probe. @see docs/RATIONALE.md#LEASE-08
    it('ignores dry runs', async () => {
        const { ctx, lease } = await setup();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, true);
        expect(lease.isGenerationActive()).toBe(false);
    });

    // GENERATION_STOPPED is followed by the aborted generation's own
    // GENERATION_ENDED, so only the end decrements. @see docs/RATIONALE.md#LEASE-09
    it('counts a stopped generation down once, not twice', async () => {
        const { ctx, lease } = await setup();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'quiet', {}, false);

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STOPPED);
        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');

        expect(lease.wasGenerationStopped()).toBe(true);
        expect(lease.isGenerationActive()).toBe(true);

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'quiet');
        expect(lease.isGenerationActive()).toBe(false);
    });

    // The reported field failure: a start with no matching end. Whatever
    // produces it, the extension must not be locked out until a reload.
    // @see docs/RATIONALE.md#LEASE-10
    it('recovers from a start whose end never arrives, once the host says idle', async () => {
        const { ctx, lease } = await setup();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
        // No GENERATION_ENDED. Events alone can never clear this.
        expect(lease.getLeaseDiagnostics().openCount).toBe(1);

        ctx.isGenerating = false;
        expect(lease.isGenerationActive()).toBe(false);
        expect(lease.getLeaseDiagnostics().events.reconciledFromHostIdle).toBe(1);
    });

    it('does not reconcile while a lease is armed', async () => {
        const { ctx, lease } = await setup();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'quiet', {}, false);
        lease.armLease({ transactionId: 'tx', prompt: 'p', chatId: 'chat-1' });

        ctx.isGenerating = false;
        lease.isGenerationActive();

        // The record survives, so the lease baseline still sees the overlap.
        expect(lease.getLeaseDiagnostics().openCount).toBe(1);
        expect(lease.getLeaseDiagnostics().events.reconciledFromHostIdle).toBe(0);
    });

    it('lets the host report busy even when no start was observed', async () => {
        const { ctx, lease } = await setup();

        expect(lease.isGenerationActive()).toBe(false);
        ctx.isGenerating = true;
        expect(lease.isGenerationActive()).toBe(true);
    });

    it('falls back to the records when the host cannot answer', async () => {
        const { ctx, lease } = await setup();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
        expect(lease.isGenerationActive()).toBe(true);
        expect(lease.getLeaseDiagnostics().host.state).toBe('unknown');
    });

    // A dry run emits no end, so counting one as real leaks a record that can
    // never be closed. @see docs/RATIONALE.md#LEASE-08
    it('recognises a dry run whichever argument carries the flag', async () => {
        const { ctx, lease } = await setup();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, true);
        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', true);
        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false, true);

        const diagnostics = lease.getLeaseDiagnostics();
        expect(diagnostics.openCount).toBe(0);
        expect(diagnostics.events.dryRuns).toBe(3);
        expect(lease.isGenerationActive()).toBe(false);
    });

    it('closes the open record matching the ended kind', async () => {
        const { ctx, lease } = await setup();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'quiet', {}, false);
        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');

        const diagnostics = lease.getLeaseDiagnostics();
        expect(diagnostics.open.map(record => record.kind)).toEqual(['quiet']);
        expect(diagnostics.events.kindMismatchedEnds).toBe(0);
    });

    it('tallies an end that matches nothing open', async () => {
        const { ctx, lease } = await setup();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
        expect(lease.getLeaseDiagnostics().events.unmatchedEnds).toBe(1);
    });

    it('zeroes the count on chat change', async () => {
        const { ctx, lease } = await setup();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'quiet', {}, false);
        expect(lease.isGenerationActive()).toBe(true);

        await ctx.eventSource.emit(ctx.eventTypes.CHAT_CHANGED, 'other-chat');
        expect(lease.isGenerationActive()).toBe(false);
    });
});
