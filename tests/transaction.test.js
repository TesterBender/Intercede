/**
 * Transaction ownership and rollback safety (INV-02 … INV-06).
 *
 * These tests assert exact final chat state. A test that only checks "an error
 * was thrown" would pass against the destructive implementation, which is
 * precisely the failure mode being fixed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    assistantMessage,
    freshModules,
    installFakeSillyTavern,
    respondWith,
    runTransaction,
    uninstallFakeSillyTavern,
    userMessage,
} from './helpers/fake-context.js';

const ORIGINAL = 'Prefix sentence. Suffix sentence.';
const CUT_OFFSET = 17; // start of "Suffix sentence."

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

describe('happy path', () => {
    it('produces assistant / user / assistant with the generated continuation', async () => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.'));

        const result = await runTransaction(transaction, { ctx, offset: CUT_OFFSET });

        expect(result.ok).toBe(true);
        expect(ctx.chat).toHaveLength(4);
        expect(ctx.chat[1].mes).toBe('Prefix sentence.');
        expect(ctx.chat[1].is_user).toBe(false);
        expect(ctx.chat[2].is_user).toBe(true);
        expect(ctx.chat[2].mes).toBe('I cut in here.');
        expect(ctx.chat[3].is_user).toBe(false);
        expect(ctx.chat[3].mes).toBe('Revised continuation.');
    });

    it('records the transaction in chat metadata as committed', async () => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.'));

        const result = await runTransaction(transaction, { ctx, offset: CUT_OFFSET });

        const record = ctx.chatMetadata.intercede.transactions[result.transactionId];
        expect(record.state).toBe('committed');
        expect(record.suffixMessageId).toBe(3);
    });
});

describe('INV-03/INV-04 — proven ownership of the generated continuation', () => {
    it('does not adopt a foreign message appended after the continuation', async () => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.', {
            extraMessages: [assistantMessage('Unrelated extension output.')],
        }));

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        // The foreign message must never be tagged as this transaction's suffix.
        const foreign = ctx.chat.find(m => m.mes === 'Unrelated extension output.');
        expect(foreign?.extra?.intercede).toBeUndefined();
    });

    it('fails rather than committing when two assistant messages are received', async () => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            ctx.chat.push(assistantMessage('First.'));
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.length - 1);
            ctx.chat.push(assistantMessage('Second.'));
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.length - 1);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        const committed = ctx.chatMetadata?.intercede?.transactions ?? {};
        expect(Object.keys(committed)).toHaveLength(0);
    });

    it('captures the continuation when MESSAGE_RECEIVED fires after generate() resolves', async () => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            // Backend resolves first; the reply is appended on a later tick.
            setTimeout(async () => {
                ctx.chat.push(assistantMessage('Late continuation.'));
                await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.length - 1);
                await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
            }, 10);
        });

        const result = await runTransaction(transaction, { ctx, offset: CUT_OFFSET });

        expect(result.ok).toBe(true);
        expect(ctx.chat[3].mes).toBe('Late continuation.');
    });
});

describe('INV-05 — selective rollback', () => {
    it('preserves an unrelated message added during a failed generation', async () => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            ctx.chat.push(assistantMessage('Unrelated extension output.'));
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
            throw new Error('backend exploded');
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        expect(ctx.chat.some(m => m.mes === 'Unrelated extension output.')).toBe(true);
    });

    it('restores the original message text exactly on rollback', async () => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
            throw new Error('backend exploded');
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        expect(ctx.chat).toHaveLength(2);
        expect(ctx.chat[1].mes).toBe(ORIGINAL);
        expect(ctx.chat[1].extra?.intercede).toBeUndefined();
    });

    it('is idempotent when rollback runs twice', async () => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
            throw new Error('backend exploded');
        });

        const raw = String(ctx.chat[1].mes ?? '');
        const { createAnchor } = await import('../src/anchors.js');
        const tx = new transaction.IntercedeTransaction({
            targetIndex: 1,
            anchor: createAnchor(raw, CUT_OFFSET, 'sentence'),
            insertionText: 'I cut in here.',
            rewriteMode: 'adaptive',
        });

        await expect(tx.run()).rejects.toThrow();
        await tx.rollback(new Error('second call'));

        expect(ctx.chat).toHaveLength(2);
        expect(ctx.chat[1].mes).toBe(ORIGINAL);
    });
});

describe('INV-06 — metadata rollback', () => {
    it('restores a pre-existing transaction table when commit persistence fails', async () => {
        const { ctx, transaction } = await setup({
            chatMetadata: {
                intercede: {
                    version: 1,
                    transactions: { prior: { state: 'committed', targetMessageIndex: 0 } },
                },
            },
        });
        const before = structuredClone(ctx.chatMetadata.intercede);
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.'));
        ctx.saveChat = vi.fn(async () => { throw new Error('disk failure'); });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        expect(ctx.chatMetadata.intercede).toEqual(before);
    });

    it('leaves no intercede metadata behind when none existed before', async () => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.'));
        ctx.saveChat = vi.fn(async () => { throw new Error('disk failure'); });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        const transactions = ctx.chatMetadata?.intercede?.transactions ?? {};
        expect(Object.keys(transactions)).toHaveLength(0);
    });
});
