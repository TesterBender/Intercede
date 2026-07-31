/**
 * Adversarial event-ordering sequences (P0 review).
 *
 * Every case here models another extension that participates in the *same*
 * event surface Intercede uses to identify its own work, rather than one that
 * merely appends to the array. That distinction is the whole point: an
 * extension that emits MESSAGE_RECEIVED or starts a matching generation can
 * reach Intercede's correlation logic, and a foreign message must survive it
 * both unmarked and undeleted.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    assistantMessage,
    freshModules,
    installFakeSillyTavern,
    runTransaction,
    uninstallFakeSillyTavern,
    userMessage,
} from './helpers/fake-context.js';
import { getIntercedeMarker } from '../src/ownership.js';

const ORIGINAL = 'Prefix sentence. Suffix sentence.';
const CUT_OFFSET = 17;

function baseChat() {
    return [userMessage('Hello there.'), assistantMessage(ORIGINAL)];
}

async function setup(options = {}) {
    vi.resetModules();
    const harness = installFakeSillyTavern({ chat: baseChat(), ...options });
    const modules = await freshModules();
    modules.lease.initLease();
    return { ...harness, ...modules };
}

beforeEach(() => {
    uninstallFakeSillyTavern();
});

describe('foreign assistant message emits the capture event first', () => {
    it('never marks a foreign assistant message with this transaction', async () => {
        const { ctx, transaction } = await setup();

        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);

            // Another extension's assistant message arrives first, on the very
            // event Intercede uses to recognise its own continuation.
            const foreign = assistantMessage('Foreign extension output.');
            ctx.chat.push(foreign);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.indexOf(foreign), 'normal');

            const real = assistantMessage('Actual Intercede continuation.');
            ctx.chat.push(real);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.indexOf(real), 'normal');

            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        const foreign = ctx.chat.find(m => m.mes === 'Foreign extension output.');
        expect(foreign).toBeDefined();
        expect(getIntercedeMarker(foreign)).toBeNull();
    });

    it('leaves the foreign message in the chat', async () => {
        const { ctx, transaction } = await setup();

        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            const foreign = assistantMessage('Foreign extension output.');
            ctx.chat.push(foreign);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.indexOf(foreign), 'normal');
            const real = assistantMessage('Actual Intercede continuation.');
            ctx.chat.push(real);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.indexOf(real), 'normal');
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        expect(ctx.chat.some(m => m.mes === 'Foreign extension output.')).toBe(true);
    });

    it('does not commit either candidate as the continuation', async () => {
        const { ctx, transaction } = await setup();

        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            const foreign = assistantMessage('Foreign extension output.');
            ctx.chat.push(foreign);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.indexOf(foreign), 'normal');
            const real = assistantMessage('Actual Intercede continuation.');
            ctx.chat.push(real);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.indexOf(real), 'normal');
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        expect(ctx.chat.some(m => getIntercedeMarker(m)?.role === 'suffix')).toBe(false);
        const transactions = ctx.chatMetadata?.intercede?.transactions ?? {};
        expect(Object.keys(transactions)).toHaveLength(0);
    });

    it('does not leave its own uncommitted continuation behind after rollback', async () => {
        const { ctx, transaction } = await setup();

        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            const real = assistantMessage('Actual Intercede continuation.');
            ctx.chat.push(real);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.indexOf(real), 'normal');
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
            throw new Error('backend exploded after the reply landed');
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        expect(ctx.chat).toHaveLength(2);
        expect(ctx.chat[1].mes).toBe(ORIGINAL);
    });
});

describe('unrelated normal generation consumes the lease first', () => {
    it('rejects rather than committing an uninstructed continuation', async () => {
        const { ctx, transaction } = await setup();

        ctx.generate = vi.fn(async () => {
            // An unrelated normal generation begins and satisfies every lease
            // predicate: same chat, same kind, still fresh.
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');

            // Intercede's own generation then runs with no instruction installed.
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            const real = assistantMessage('Uninstructed continuation.');
            ctx.chat.push(real);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.indexOf(real), 'normal');
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        expect(ctx.chat.some(m => getIntercedeMarker(m)?.role === 'suffix')).toBe(false);
        const transactions = ctx.chatMetadata?.intercede?.transactions ?? {};
        expect(Object.keys(transactions)).toHaveLength(0);
    });

    // Two matching generations mean the one message that arrived may belong to
    // either. It must not be claimed, and therefore must not be deleted.
    it('neither claims nor deletes a reply it cannot attribute', async () => {
        const { ctx, transaction } = await setup();

        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            const real = assistantMessage('Ambiguous continuation.');
            ctx.chat.push(real);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.indexOf(real), 'normal');
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        const message = ctx.chat.find(m => m.mes === 'Ambiguous continuation.');
        expect(message).toBeDefined();
        expect(getIntercedeMarker(message)).toBeNull();
        expect(transaction.isRecoveryRequired()).toBe(true);
    });

    it('rejects when two matching generations start while the lease is active', async () => {
        const { ctx, transaction } = await setup();

        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            const real = assistantMessage('Continuation.');
            ctx.chat.push(real);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.indexOf(real), 'normal');
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        expect(ctx.chat.some(m => getIntercedeMarker(m)?.role === 'suffix')).toBe(false);
    });
});
