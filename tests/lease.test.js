/**
 * Generation-lease state, tested directly rather than through a transaction.
 *
 * The transaction-level tests can only observe the lease through its receipt.
 * These pin the counter itself, because everything upstream of the receipt —
 * preflight eligibility, the settle wait, prompt-integrity detection — reads it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emitHostGenerationEnded, emitHostStart, emitHostStop, freshModules, installFakeSillyTavern, uninstallFakeSillyTavern } from './helpers/fake-context.js';

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

    // A stopped generation emits GENERATION_ENDED too, so only the end
    // decrements. This is the streaming path, where the end arrives *after* the
    // stop; @see docs/RATIONALE.md#LEASE-09 for why neither order may be assumed.
    it('counts a stopped generation down once, not twice', async () => {
        const { ctx, lease } = await setup();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'quiet', {}, false);

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STOPPED);
        await emitHostGenerationEnded(ctx);

        expect(lease.wasGenerationStopped()).toBe(true);
        expect(lease.isGenerationActive()).toBe(true);

        await emitHostGenerationEnded(ctx);
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

    // SillyTavern 1.18.0 never names a kind here, but the matching path is kept
    // for a host that does. @see docs/RATIONALE.md#LEASE-12
    it('closes the open record matching the ended kind, when the host names one', async () => {
        const { ctx, lease } = await setup();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'quiet', {}, false);
        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');

        const diagnostics = lease.getLeaseDiagnostics();
        expect(diagnostics.open.map(record => record.kind)).toEqual(['quiet']);
        expect(diagnostics.events.kindMismatchedEnds).toBe(0);
        expect(diagnostics.events.opaqueEnds).toBe(0);
    });

    it('tallies a named kind that matches no open record', async () => {
        const { ctx, lease } = await setup();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'quiet', {}, false);
        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'impersonate');

        const diagnostics = lease.getLeaseDiagnostics();
        expect(diagnostics.events.kindMismatchedEnds).toBe(1);
        expect(diagnostics.openCount).toBe(0);
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

/**
 * The events as SillyTavern 1.18.0 actually emits them.
 *
 * `GENERATION_ENDED` comes from `hideStopButton()` and carries `chat.length`,
 * and `stopGeneration()` emits it *before* `GENERATION_STOPPED`. These pin the
 * real payloads and the real ordering rather than the symmetry one would guess
 * from `GENERATION_STARTED`. @see docs/RATIONALE.md#LEASE-12
 */
describe('SillyTavern 1.18.0 lifecycle', () => {
    /** The text of the most recent setExtensionPrompt() call. */
    const lastPrompt = ctx => ctx.setExtensionPrompt.mock.calls.at(-1)?.[1];

    /** A normal send: the host passes no type at all, then clears slash commands. */
    const hostStart = ctx => emitHostStart(ctx);

    it('completes a leased generation whose end carries chat.length', async () => {
        const { ctx, lease } = await setup();

        lease.armLease({ transactionId: 'tx', prompt: 'REWRITE', chatId: 'chat-1' });
        await hostStart(ctx);

        expect(lease.getLeaseReceipt('tx').applied).toBe(true);
        expect(lastPrompt(ctx)).toBe('REWRITE');

        await emitHostGenerationEnded(ctx);

        const diagnostics = lease.getLeaseDiagnostics();
        expect(diagnostics.openCount).toBe(0);
        expect(diagnostics.leaseArmed).toBe(false);
        expect(diagnostics.events.opaqueEnds).toBe(1);
        // The whole point: a real completion is not a mismatch.
        expect(diagnostics.events.kindMismatchedEnds).toBe(0);
        expect(lastPrompt(ctx)).toBe('');
    });

    it('settles the stop sequence in host order — end, then stop', async () => {
        const { ctx, lease } = await setup();

        lease.armLease({ transactionId: 'tx', prompt: 'REWRITE', chatId: 'chat-1' });
        await hostStart(ctx);
        await emitHostStop(ctx);

        const diagnostics = lease.getLeaseDiagnostics();
        expect(diagnostics.openCount).toBe(0);
        expect(diagnostics.leaseArmed).toBe(false);
        expect(diagnostics.events.kindMismatchedEnds).toBe(0);
        expect(lease.wasGenerationStopped()).toBe(true);
        expect(lastPrompt(ctx)).toBe('');
        expect(lease.isGenerationActive()).toBe(false);
    });

    it('leaves the next generation unencumbered after a stop', async () => {
        const { ctx, lease } = await setup();

        lease.armLease({ transactionId: 'tx', prompt: 'REWRITE', chatId: 'chat-1' });
        await hostStart(ctx);
        await emitHostStop(ctx);

        await hostStart(ctx);

        // The lease was consumed by the stopped generation; nothing leaks into this one.
        expect(lease.isLeaseArmed()).toBe(false);
        expect(lastPrompt(ctx)).toBe('');
        expect(lease.wasGenerationStopped()).toBe(false);
        expect(lease.getLeaseDiagnostics().openCount).toBe(1);

        await emitHostGenerationEnded(ctx);
        expect(lease.getLeaseDiagnostics().openCount).toBe(0);
    });

    it('closes nested generations newest-first when ends carry no kind', async () => {
        const { ctx, lease } = await setup();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'quiet', {}, false);
        await hostStart(ctx);

        await emitHostGenerationEnded(ctx);

        let diagnostics = lease.getLeaseDiagnostics();
        expect(diagnostics.open.map(record => record.kind)).toEqual(['quiet']);
        expect(diagnostics.events.opaqueEnds).toBe(1);
        expect(diagnostics.events.kindMismatchedEnds).toBe(0);

        await emitHostGenerationEnded(ctx);

        diagnostics = lease.getLeaseDiagnostics();
        expect(diagnostics.openCount).toBe(0);
        expect(diagnostics.events.kindMismatchedEnds).toBe(0);
    });

    // An unknown string is as opaque as an integer: a future host naming a kind
    // we do not know must degrade to "close the newest", not to a mismatch.
    it('treats an unrecognised payload as opaque', async () => {
        const { ctx, lease } = await setup();

        for (const payload of [ctx.chat.length, 'telemetry_probe', null, { chatLength: 4 }]) {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, undefined, {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, payload);
        }

        const diagnostics = lease.getLeaseDiagnostics();
        expect(diagnostics.openCount).toBe(0);
        expect(diagnostics.events.opaqueEnds).toBe(4);
        expect(diagnostics.events.kindMismatchedEnds).toBe(0);
    });

    // hideStopButton() no-ops when the button is already hidden, so an
    // overlapping generation can finish without emitting anything. The record
    // is left open — wrong upward, never downward — and LEASE-10 clears it.
    it('leaks upward, not downward, when the host swallows an end', async () => {
        const { ctx, lease } = await setup();

        await hostStart(ctx);
        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'quiet', {}, false);

        // Only one end arrives for two starts.
        await emitHostGenerationEnded(ctx);
        expect(lease.getLeaseDiagnostics().openCount).toBe(1);
        expect(lease.isGenerationActive()).toBe(true);

        // The host settles the disagreement. @see docs/RATIONALE.md#LEASE-10
        ctx.isGenerating = false;
        expect(lease.isGenerationActive()).toBe(false);
        expect(lease.getLeaseDiagnostics().events.reconciledFromHostIdle).toBe(1);
    });
});
