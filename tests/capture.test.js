/**
 * Assistant capture: which `MESSAGE_RECEIVED` events may be set aside, and what
 * a refusal is able to say about itself.
 *
 * The filter here is the mirror image of the lease's end matching. Both read a
 * host argument that may or may not be a generation kind, and the failure the
 * old code could produce was silent: drop the only candidate, then report that
 * the host generated nothing. These tests pin the direction of every doubt —
 * an unclassifiable value must never be the thing that decides.
 *
 * @see docs/RATIONALE.md#CAP-06
 * @see docs/RATIONALE.md#CAP-07
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
const CUT_OFFSET = 17;

async function setup() {
    vi.resetModules();
    const harness = installFakeSillyTavern({ chat: [userMessage('Hello there.'), assistantMessage(ORIGINAL)] });
    const modules = await freshModules();
    modules.lease.initLease();
    return { ...harness, ...modules };
}

beforeEach(() => {
    uninstallFakeSillyTavern();
});

describe('CAP-06 — only a named kind may exclude a candidate', () => {
    it('captures a continuation announced with no type at all', async () => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.'));

        const result = await runTransaction(transaction, { ctx, offset: CUT_OFFSET });

        expect(result.ok).toBe(true);
        expect(ctx.chat[3].mes).toBe('Revised continuation.');
    });

    it('captures a continuation announced with the expected named kind', async () => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.', { receivedType: 'normal' }));

        const result = await runTransaction(transaction, { ctx, offset: CUT_OFFSET });

        expect(result.ok).toBe(true);
    });

    /**
     * The regression. A host that puts something unclassifiable in the second
     * argument used to have its message discarded, and the transaction then
     * reported that no continuation had been captured at all — describing an
     * empty generation when the message had in fact arrived.
     */
    it.each([
        ['an unrecognized string', 'continue_after_commands'],
        ['a number, as GENERATION_ENDED already does', 4],
        ['an object', { type: 'normal' }],
        ['a boolean', true],
    ])('captures a continuation announced with %s', async (_label, receivedType) => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.', { receivedType }));

        const result = await runTransaction(transaction, { ctx, offset: CUT_OFFSET });

        expect(result.ok).toBe(true);
        expect(ctx.chat[3].mes).toBe('Revised continuation.');
    });

    it('still sets aside a message the host names as another kind', async () => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(respondWith(ctx, 'Background summary.', { receivedType: 'quiet' }));

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET }))
            .rejects.toThrow(/no assistant continuation was captured/i);
    });

    /**
     * Admitting an opaque candidate cannot cause a false commit: it faces the
     * "exactly one" rule, so a foreign message that used to be filtered out of
     * sight now makes the transaction refuse instead.
     */
    it('refuses when an opaque foreign message arrives alongside ours', async () => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, undefined, {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_AFTER_COMMANDS, undefined, {}, false);

            const foreign = assistantMessage('Another extension wrote this.');
            ctx.chat.push(foreign);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.length - 1, 'who-knows');

            const ours = assistantMessage('Revised continuation.');
            ctx.chat.push(ours);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.length - 1);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, ctx.chat.length);
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET }))
            .rejects.toThrow(/observed 2/);

        const foreign = ctx.chat.find(m => m.mes === 'Another extension wrote this.');
        expect(foreign).toBeDefined();
        expect(foreign.extra?.intercede).toBeUndefined();
    });
});

describe('CAP-07 — a refusal reports what it saw', () => {
    async function capture(ctx) {
        const { beginAssistantCapture } = await import('../src/generation-capture.js');
        const { getCurrentChatId } = await import('../src/stcontext.js');
        return beginAssistantCapture(ctx, { chatId: getCurrentChatId(ctx) });
    }

    it('separates the reasons events were set aside', async () => {
        const { ctx } = await setup();
        const watcher = await capture(ctx);

        ctx.chat.push(userMessage('A user message.'));
        await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.length - 1);
        ctx.chat.push(assistantMessage('A quiet reply.'));
        await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.length - 1, 'quiet');
        await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, 900);

        expect(watcher.finish()).toEqual([]);
        expect(watcher.evidence()).toMatchObject({
            events: 3,
            candidates: 0,
            notAssistant: 1,
            namedOtherKind: 1,
            unresolvedIndex: 1,
            kinds: { normal: 2, quiet: 1 },
        });
    });

    it('labels an unclassifiable type as opaque rather than inventing a kind', async () => {
        const { ctx } = await setup();
        const watcher = await capture(ctx);

        ctx.chat.push(assistantMessage('A reply.'));
        await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.length - 1, 17);

        expect(watcher.finish()).toHaveLength(1);
        expect(watcher.evidence().kinds).toEqual({ opaque: 1 });
    });

    // @see docs/RATIONALE.md#LEASE-14 — counts and labels, never message text.
    it('carries no message text', async () => {
        const { ctx } = await setup();
        const watcher = await capture(ctx);

        ctx.chat.push(assistantMessage('A secret the report must not repeat.'));
        await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.length - 1);
        watcher.finish();

        expect(JSON.stringify(watcher.evidence())).not.toMatch(/secret/i);
    });
});
