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
            // One end per start: the settle wait counts them.
            // @see docs/RATIONALE.md#LEASE-04, #TX-17
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        expect(ctx.chat.some(m => getIntercedeMarker(m)?.role === 'suffix')).toBe(false);
    });
});

/**
 * A generation that begins *after* the rewrite instruction was installed, but
 * before SillyTavern has assembled the prompt for the generation it was
 * installed for.
 *
 * SillyTavern awaits GENERATION_STARTED and runs its listeners sequentially,
 * and extension prompts are only collected substantially later in prompt
 * preparation. A listener that calls generateQuietPrompt() therefore runs a
 * whole nested generation *inside* the start event of ours. Intercede correctly
 * refuses to let its instruction enter that foreign request — but clearing the
 * prompt is exactly what strips it from our own pending generation, and the
 * lease audit would otherwise still report a clean `applied: true`.
 *
 * The reply is genuinely ours in these cases, so the right outcome is a clean
 * selective rollback rather than recovery-required.
 */
describe('non-matching generation interleaves after the instruction is installed', () => {
    /**
     * @param {string} nestedKind generation type of the interfering generation
     */
    function nestedGeneration(ctx, nestedKind) {
        let launched = false;

        // Registered after initLease(), so it runs after Intercede's own
        // GENERATION_STARTED listener has installed the prompt.
        ctx.eventSource.on(ctx.eventTypes.GENERATION_STARTED, async (type, _params, dryRun) => {
            if (dryRun || launched) return;
            if ((type ?? 'normal') !== 'normal') return;
            launched = true;
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, nestedKind, {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, nestedKind);
        });

        return async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);

            const real = assistantMessage('Continuation produced after prompt loss.');
            ctx.chat.push(real);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.indexOf(real), 'normal');
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
        };
    }

    for (const kind of ['quiet', 'impersonate', 'continue']) {
        it(`rolls back when a nested ${kind} generation strips the instruction`, async () => {
            const { ctx, transaction } = await setup();
            ctx.generate = vi.fn(nestedGeneration(ctx, kind));

            await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET }))
                .rejects.toThrow(/overlap/i);

            // Clean rollback: the target is whole again and our own reply is gone.
            expect(ctx.chat).toHaveLength(2);
            expect(ctx.chat[1].mes).toBe(ORIGINAL);
            expect(ctx.chat.some(m => getIntercedeMarker(m))).toBe(false);
            expect(Object.keys(ctx.chatMetadata?.intercede?.transactions ?? {})).toHaveLength(0);
            expect(transaction.isRecoveryRequired()).toBe(false);
        });
    }

    // A dry run is a prompt-assembly probe, not a generation: the handler
    // returns before it counts anything. Asserting that keeps the exemption
    // deliberate rather than incidental.
    it('ignores a nested dry run', async () => {
        const { ctx, transaction } = await setup();

        let launched = false;
        ctx.eventSource.on(ctx.eventTypes.GENERATION_STARTED, async (type, _params, dryRun) => {
            if (dryRun || launched) return;
            if ((type ?? 'normal') !== 'normal') return;
            launched = true;
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'quiet', {}, true);
        });

        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            const real = assistantMessage('Revised continuation. Second sentence.');
            ctx.chat.push(real);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.indexOf(real), 'normal');
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
        });

        const result = await runTransaction(transaction, { ctx, offset: CUT_OFFSET });
        expect(result.ok).toBe(true);
    });

    // The instruction can also be lost without any interfering *start* to
    // observe: a generation already running when it is installed clears the
    // prompt at its own GENERATION_ENDED, and that event names no owner. Here
    // another extension reacts to the inserted user message by starting one.
    it('rolls back when a generation was already running as the instruction was installed', async () => {
        const { ctx, transaction } = await setup();

        ctx.eventSource.on(ctx.eventTypes.USER_MESSAGE_RENDERED, async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'quiet', {}, false);
        });

        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);

            const real = assistantMessage('Continuation produced after prompt loss.');
            ctx.chat.push(real);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.indexOf(real), 'normal');

            // The foreign generation finishes during ours and clears the prompt.
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'quiet');
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET }))
            .rejects.toThrow(/overlap/i);

        expect(ctx.chat).toHaveLength(2);
        expect(ctx.chat[1].mes).toBe(ORIGINAL);
        expect(ctx.chat.some(m => getIntercedeMarker(m))).toBe(false);
        expect(transaction.isRecoveryRequired()).toBe(false);
    });

    // Two foreign generations overlap and one of them ends. Anything that
    // tracks "is a generation running" as a boolean now reads false while the
    // other is still open — and a count rebuilt from that boolean loses the
    // second one entirely. @see docs/RATIONALE.md#LEASE-04
    it('detects a foreign generation left open after another ends', async () => {
        const { ctx, transaction } = await setup();

        ctx.eventSource.on(ctx.eventTypes.USER_MESSAGE_RENDERED, async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'quiet', {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'impersonate', {}, false);
            // One finishes. The other is still running.
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'quiet');
        });

        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);

            const real = assistantMessage('Continuation produced after prompt loss.');
            ctx.chat.push(real);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.indexOf(real), 'normal');

            // The survivor ends during ours and clears the instruction.
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'impersonate');
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET }))
            .rejects.toThrow(/overlap/i);

        expect(ctx.chat).toHaveLength(2);
        expect(ctx.chat[1].mes).toBe(ORIGINAL);
        expect(ctx.chat.some(m => getIntercedeMarker(m))).toBe(false);
        expect(transaction.isRecoveryRequired()).toBe(false);
    });

    // Ordering matters: a non-matching generation that arrives *before* the
    // instruction is installed disarms the lease instead, so the failure is the
    // already-covered "never applied" one rather than integrity loss. Both roll
    // back cleanly; this pins which diagnosis the user is given.
    it('reports never-applied, not overlap, when the quiet generation comes first', async () => {
        const { ctx, transaction } = await setup();

        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'quiet', {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'quiet');

            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            const real = assistantMessage('Uninstructed continuation.');
            ctx.chat.push(real);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.indexOf(real), 'normal');
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET }))
            .rejects.toThrow(/never applied/i);

        expect(ctx.chat).toHaveLength(2);
        expect(ctx.chat[1].mes).toBe(ORIGINAL);
    });
});
