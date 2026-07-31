/**
 * Surfaces that were declared but inert: the enabled switch, the invalidation
 * event, and snapshot cleanup's knowledge of what is still referenced.
 *
 * @see docs/RATIONALE.md#CFG-03 what the switch does and deliberately does not do
 * @see docs/RATIONALE.md#CFG-02 the umbrella event contract
 * @see docs/RATIONALE.md#VAULT-02 age alone never removes a live snapshot
 * @see docs/RATIONALE.md#TX-14 finalize ordering
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

/** Run one full intercession and return its result. */
async function commitOne({ ctx, transaction }) {
    ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.'));
    return runTransaction(transaction, { ctx, offset: CUT_OFFSET });
}

beforeEach(() => {
    uninstallFakeSillyTavern();
    document.body.innerHTML = '';
});

describe('the enabled switch', () => {
    async function openUI(enabled) {
        vi.resetModules();
        const harness = installFakeSillyTavern({ chat: baseChat() });
        document.body.innerHTML = '<div id="chat"></div>';

        const { getSettings } = await import('../src/stcontext.js');
        getSettings().enabled = enabled;
        getSettings().selectionInterface = 'window';

        const open = await import('../src/ui/open.js');
        const overlay = await import('../src/ui/overlay.js');
        open.openIntercede();
        return { ...harness, open, overlay };
    }

    it('refuses to open a new intercession when switched off', async () => {
        const { overlay } = await openUI(false);

        expect(overlay.isOverlayOpen()).toBe(false);
    });

    it('opens normally when switched on', async () => {
        const { overlay } = await openUI(true);

        expect(overlay.isOverlayOpen()).toBe(true);
    });

    it('still allows undo of an intercession committed before it was switched off', async () => {
        const { ctx, transaction } = await setup();
        await commitOne({ ctx, transaction });

        const { getSettings } = await import('../src/stcontext.js');
        getSettings().enabled = false;

        // Switching the extension off must never strand a committed intercession.
        await expect(transaction.undoIntercession()).resolves.toMatchObject({ ok: true });
        expect(ctx.chat).toHaveLength(2);
        expect(ctx.chat[1].mes).toBe(ORIGINAL);
    });
});

describe('intercede_invalidated', () => {
    /** Collect every invalidation payload the host sees. */
    function listen(ctx, constants) {
        const seen = [];
        ctx.eventSource.on(constants.INTERCEDE_EVENTS.INVALIDATED, payload => seen.push(payload));
        return seen;
    }

    it('fires alongside the committed event, naming where the chat shifted', async () => {
        const { ctx, transaction, constants } = await setup();
        const seen = listen(ctx, constants);

        const result = await commitOne({ ctx, transaction });

        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            transactionId: result.transactionId,
            operation: 'commit',
            fromIndex: 1,
        });
        // Everything from fromIndex on may have moved, not merely changed text.
        expect(seen[0].affectedMessageIds).toEqual([1, 2, 3]);
    });

    it('fires on rollback', async () => {
        const { ctx, transaction, constants } = await setup();
        const seen = listen(ctx, constants);
        // An empty continuation is an ordinary fatal validation failure, so the
        // transaction rolls itself back rather than latching recovery-required.
        ctx.generate = vi.fn(respondWith(ctx, ''));

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        expect(seen).toHaveLength(1);
        expect(seen[0].operation).toBe('rollback');
    });

    it('fires on undo', async () => {
        const { ctx, transaction, constants } = await setup();
        await commitOne({ ctx, transaction });
        const seen = listen(ctx, constants);

        await transaction.undoIntercession();

        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ operation: 'undo', fromIndex: 1 });
    });

    it('carries only integer message ids', async () => {
        const { ctx, transaction, constants } = await setup();
        const seen = listen(ctx, constants);

        await commitOne({ ctx, transaction });

        expect(seen[0].affectedMessageIds.every(Number.isInteger)).toBe(true);
    });
});

describe('snapshot cleanup', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    /**
     * Age a stored record past any plausible TTL. Written through the vault so
     * the in-memory cache is aged too — cleanup reads through it.
     */
    async function backdate(vault, key, days = 30) {
        const record = await vault.vaultGet(key);
        await vault.vaultPut(key, { ...record, createdAt: Date.now() - days * DAY_MS });
    }

    it('refuses to run while an intercession is in progress', async () => {
        const { ctx, transaction } = await setup();
        let result = null;
        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            // The snapshot being written is exactly what a sweep must not race.
            result = await transaction.cleanupSnapshots(1);
            const generated = assistantMessage('Revised continuation.');
            ctx.chat.push(generated);
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, ctx.chat.length - 1);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
        });

        await runTransaction(transaction, { ctx, offset: CUT_OFFSET });

        expect(result).toMatchObject({ ok: false, removed: 0 });
        expect(result.reason).toMatch(/in progress/i);
    });

    it('keeps a snapshot the chat metadata still points at, however old', async () => {
        const { ctx, transaction, vault } = await setup();
        const result = await commitOne({ ctx, transaction });
        const key = ctx.chatMetadata.intercede.transactions[result.transactionId].vaultKey;
        await backdate(vault, key);

        const cleanup = await transaction.cleanupSnapshots(1);

        expect(cleanup).toMatchObject({ ok: true, removed: 0 });
        expect(await vault.vaultGet(key)).toBeTruthy();
    });

    it('keeps a snapshot an unrecovered journal points at', async () => {
        // The record's own state says "finalized, collectable". Only the journal
        // knows it is the sole copy of a half-applied message's original text.
        const { transaction, vault } = await setup();
        const key = 'intercede:chat-1:orphan';
        await vault.vaultPut(key, {
            transactionId: 'orphan',
            chatId: 'chat-1',
            state: 'committed',
            finalizedAt: 1,
        });
        await backdate(vault, key);
        vault.writeJournal({
            transactionId: 'orphan',
            chatId: 'chat-1',
            stage: 'generation-started',
            vaultKey: key,
        });

        const cleanup = await transaction.cleanupSnapshots(1);

        expect(cleanup.removed).toBe(0);
        expect(await vault.vaultGet(key)).toBeTruthy();
    });

    it('removes an aged snapshot nothing points at any more', async () => {
        const { transaction, vault } = await setup();
        const key = 'intercede:chat-1:stale';
        await vault.vaultPut(key, {
            transactionId: 'stale',
            chatId: 'chat-1',
            state: 'committed',
            finalizedAt: 1,
        });
        await backdate(vault, key);

        const cleanup = await transaction.cleanupSnapshots(1);

        expect(cleanup).toMatchObject({ ok: true, removed: 1 });
        expect(await vault.vaultGet(key)).toBeNull();
    });
});

describe('finalize', () => {
    it('deletes the snapshot and leaves the messages untouched', async () => {
        const { ctx, transaction, vault } = await setup();
        const result = await commitOne({ ctx, transaction });
        const key = ctx.chatMetadata.intercede.transactions[result.transactionId].vaultKey;
        const before = ctx.chat.map(message => message.mes);

        await expect(transaction.finalizeIntercession()).resolves.toMatchObject({ ok: true });

        expect(ctx.chat.map(message => message.mes)).toEqual(before);
        expect(await vault.vaultGet(key)).toBeNull();
        const record = ctx.chatMetadata.intercede.transactions[result.transactionId];
        expect(record.finalizedAt).toBeGreaterThan(0);
        expect(record.vaultKey).toBeUndefined();
    });

    it('records the decision before deleting, so a failed delete cannot leak', async () => {
        // If the metadata save is what fails, the snapshot must still be there
        // and undo must still work — never gone while still advertised.
        const { ctx, transaction, vault } = await setup();
        const result = await commitOne({ ctx, transaction });
        const key = ctx.chatMetadata.intercede.transactions[result.transactionId].vaultKey;
        ctx.saveChat = vi.fn(async () => { throw new Error('disk full'); });

        await expect(transaction.finalizeIntercession()).rejects.toThrow();

        expect(await vault.vaultGet(key)).toBeTruthy();
    });

    it('refuses while an unfinished intercession is still journaled', async () => {
        const { ctx, transaction, vault } = await setup();
        await commitOne({ ctx, transaction });
        vault.writeJournal({
            transactionId: 'other',
            chatId: 'chat-1',
            stage: 'generation-started',
            vaultKey: 'intercede:chat-1:other',
        });

        const outcome = await transaction.finalizeIntercession();

        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toMatch(/journaled/i);
    });

    it('refuses a second time', async () => {
        const { ctx, transaction } = await setup();
        await commitOne({ ctx, transaction });
        await transaction.finalizeIntercession();

        const outcome = await transaction.finalizeIntercession();

        expect(outcome.ok).toBe(false);
    });
});
