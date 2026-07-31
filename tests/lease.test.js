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

    it('zeroes the count on chat change', async () => {
        const { ctx, lease } = await setup();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'quiet', {}, false);
        expect(lease.isGenerationActive()).toBe(true);

        await ctx.eventSource.emit(ctx.eventTypes.CHAT_CHANGED, 'other-chat');
        expect(lease.isGenerationActive()).toBe(false);
    });
});
