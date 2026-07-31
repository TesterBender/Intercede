/**
 * Ownership markers, chain provenance, and the lease-applied assertion.
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
import {
    createOwnership,
    getIntercedeMarker,
    isOwnedMessage,
    markOwnedMessage,
    OWNED_ROLE,
} from '../src/ownership.js';

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

describe('markOwnedMessage', () => {
    it('writes transaction id and role', () => {
        const message = assistantMessage('Text.');
        markOwnedMessage(message, 'tx-1', OWNED_ROLE.PREFIX);

        expect(getIntercedeMarker(message)).toEqual({ transactionId: 'tx-1', role: 'prefix' });
        expect(isOwnedMessage(message, 'tx-1', OWNED_ROLE.PREFIX)).toBe(true);
        expect(isOwnedMessage(message, 'tx-2', OWNED_ROLE.PREFIX)).toBe(false);
        expect(isOwnedMessage(message, 'tx-1', OWNED_ROLE.SUFFIX)).toBe(false);
    });

    it('preserves unrelated keys in extra', () => {
        const message = assistantMessage('Text.', { swipe_info: 'keep me' });
        markOwnedMessage(message, 'tx-1', OWNED_ROLE.PREFIX);

        expect(message.extra.swipe_info).toBe('keep me');
    });

    // Interceding a revised continuation is a supported operation, and the
    // earlier link has to stay identifiable from the message itself. A marker
    // helper that simply overwrote extra[METADATA_KEY] would silently break
    // chained undo.
    it('folds an earlier transaction marker into parent', () => {
        const message = assistantMessage('A revised continuation.');
        markOwnedMessage(message, 'tx-old', OWNED_ROLE.SUFFIX);
        markOwnedMessage(message, 'tx-new', OWNED_ROLE.PREFIX);

        expect(getIntercedeMarker(message)).toEqual({
            transactionId: 'tx-new',
            role: 'prefix',
            parent: { transactionId: 'tx-old', role: 'suffix' },
        });
    });

    it('keeps the existing parent when re-marking its own message', () => {
        const message = assistantMessage('A revised continuation.');
        markOwnedMessage(message, 'tx-old', OWNED_ROLE.SUFFIX);
        markOwnedMessage(message, 'tx-new', OWNED_ROLE.SUFFIX_PENDING);
        markOwnedMessage(message, 'tx-new', OWNED_ROLE.SUFFIX);

        expect(getIntercedeMarker(message)).toEqual({
            transactionId: 'tx-new',
            role: 'suffix',
            parent: { transactionId: 'tx-old', role: 'suffix' },
        });
    });
});

describe('createOwnership', () => {
    it('derives the expected positions from the target index', () => {
        const ownership = createOwnership('tx-1', 4, 5);

        expect(ownership).toMatchObject({
            prefixIndex: 4,
            insertionIndex: 5,
            expectedSuffixIndex: 6,
            expectedChatLength: 7,
            suffixIndex: null,
        });
    });
});

describe('chained intercession', () => {
    it('keeps the earlier link identifiable after interceding a continuation', async () => {
        const { ctx, transaction } = await setup();

        ctx.generate = vi.fn(respondWith(ctx, 'First revised continuation. And more.'));
        const first = await runTransaction(transaction, { ctx, offset: CUT_OFFSET });
        expect(first.ok).toBe(true);

        // Now intercede the continuation the first transaction produced.
        ctx.generate = vi.fn(respondWith(ctx, 'Second revised continuation.'));
        const second = await runTransaction(transaction, {
            ctx,
            targetIndex: 3,
            offset: 'First revised continuation.'.length + 1,
            insertionText: 'And again.',
        });
        expect(second.ok).toBe(true);

        const marker = getIntercedeMarker(ctx.chat[3]);
        expect(marker.transactionId).toBe(second.transactionId);
        expect(marker.role).toBe('prefix');
        expect(marker.parent).toEqual({ transactionId: first.transactionId, role: 'suffix' });

        const record = ctx.chatMetadata.intercede.transactions[second.transactionId];
        expect(record.parentTransactionId).toBe(first.transactionId);
        expect(record.chainDepth).toBe(1);
    });
});

describe('lease application', () => {
    it('fails instead of committing when the rewrite instruction never reached the generation', async () => {
        const { ctx, transaction } = await setup();

        // An unrelated generation arrives first and consumes the lease slot, so
        // Intercede's own generation runs with no instruction installed.
        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'quiet', {}, false);
            ctx.chat.push(assistantMessage('Uninstructed continuation.'));
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.length - 1);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'quiet');
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET }))
            .rejects.toThrow(/never applied/i);

        expect(ctx.chat).toHaveLength(2);
        expect(ctx.chat[1].mes).toBe(ORIGINAL);
    });

    it('installs the instruction exactly once for a matching generation', async () => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.'));

        await runTransaction(transaction, { ctx, offset: CUT_OFFSET });

        const installs = ctx.setExtensionPrompt.mock.calls.filter(([, text]) => text);
        expect(installs).toHaveLength(1);
        expect(installs[0][1]).toContain('scene_notes');
    });
});
