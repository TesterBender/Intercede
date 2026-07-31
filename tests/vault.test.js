/**
 * Durable snapshot vault and recovery journal (INV-07, INV-12).
 *
 * The governing rule: the extension must not change `message.mes` until the
 * snapshot and journal are known to be durable. "Known" means round-trip
 * verified, not "the write call did not throw".
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
    vi.restoreAllMocks();
});

describe('INV-07 — durable pre-mutation state', () => {
    it('aborts before mutating the message when the journal cannot be written', async () => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.'));
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        expect(ctx.chat).toHaveLength(2);
        expect(ctx.chat[1].mes).toBe(ORIGINAL);
        expect(ctx.generate).not.toHaveBeenCalled();
    });

    it('aborts before mutating the message when the vault write is not durable', async () => {
        const { ctx, storage, transaction } = await setup();
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.'));
        // setItem resolves, but nothing is actually persisted.
        storage.control.swallowSetOnce = true;

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        expect(ctx.chat).toHaveLength(2);
        expect(ctx.chat[1].mes).toBe(ORIGINAL);
        expect(ctx.generate).not.toHaveBeenCalled();
    });

    it('aborts before mutating the message when the vault write rejects', async () => {
        const { ctx, storage, transaction } = await setup();
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.'));
        storage.control.failSetOnce = new Error('QuotaExceededError');

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        expect(ctx.chat).toHaveLength(2);
        expect(ctx.chat[1].mes).toBe(ORIGINAL);
    });

    it('does not let the in-memory cache mask a failed durable write', async () => {
        const { storage, vault } = await setup();
        storage.control.swallowSetOnce = true;

        await expect(vault.vaultPutStrict('intercede:chat-1:tx-1', {
            transactionId: 'tx-1',
            chatId: 'chat-1',
            createdAt: Date.now(),
        })).rejects.toThrow();

        // The phantom must not be readable afterwards.
        expect(vault.vaultGetCached('intercede:chat-1:tx-1')).toBeNull();
        await expect(vault.vaultGet('intercede:chat-1:tx-1')).resolves.toBeNull();
    });
});

describe('INV-12 — persistence failure stays recoverable', () => {
    it('keeps the journal when the post-rollback save fails', async () => {
        const { ctx, transaction, vault } = await setup();
        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, 'normal');
            throw new Error('backend exploded');
        });
        ctx.saveChat = vi.fn(async () => { throw new Error('disk failure'); });

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        expect(vault.readJournal()).not.toBeNull();
    });
});

describe('journal collision guard', () => {
    it('refuses to overwrite an unrecovered journal from another transaction', async () => {
        const { vault, constants } = await setup();

        vault.writeJournalStrict({
            transactionId: 'tx-a',
            chatId: 'chat-a',
            stage: constants.JOURNAL_STAGE.USER_INSERTED,
            vaultKey: 'intercede:chat-a:tx-a',
            targetIndex: 3,
            startedAt: Date.now(),
        });

        expect(() => vault.writeJournalStrict({
            transactionId: 'tx-b',
            chatId: 'chat-b',
            stage: constants.JOURNAL_STAGE.ABOUT_TO_MUTATE,
            vaultKey: 'intercede:chat-b:tx-b',
            targetIndex: 1,
            startedAt: Date.now(),
        })).toThrow(/unrecovered|in progress|another/i);

        expect(vault.readJournal().transactionId).toBe('tx-a');
    });

    it('allows a new journal once the previous one reached a terminal stage', async () => {
        const { vault, constants } = await setup();

        vault.writeJournalStrict({
            transactionId: 'tx-a',
            chatId: 'chat-a',
            stage: constants.JOURNAL_STAGE.ROLLED_BACK,
            vaultKey: 'intercede:chat-a:tx-a',
            targetIndex: 3,
            startedAt: Date.now(),
        });

        expect(() => vault.writeJournalStrict({
            transactionId: 'tx-b',
            chatId: 'chat-b',
            stage: constants.JOURNAL_STAGE.ABOUT_TO_MUTATE,
            vaultKey: 'intercede:chat-b:tx-b',
            targetIndex: 1,
            startedAt: Date.now(),
        })).not.toThrow();

        expect(vault.readJournal().transactionId).toBe('tx-b');
    });
});

describe('IC-P1-004 — cleanup must not delete a live undo snapshot', () => {
    it('keeps committed, non-finalized records regardless of age', async () => {
        const { vault } = await setup();
        const old = Date.now() - 90 * 24 * 60 * 60 * 1000;

        await vault.vaultPutStrict('intercede:chat-1:committed', {
            transactionId: 'committed',
            chatId: 'chat-1',
            state: 'committed',
            createdAt: old,
        });
        await vault.vaultPutStrict('intercede:chat-1:finalized', {
            transactionId: 'finalized',
            chatId: 'chat-1',
            state: 'committed',
            finalizedAt: old,
            createdAt: old,
        });

        const removed = await vault.cleanupVault(30);

        expect(removed).toBe(1);
        expect(await vault.vaultGet('intercede:chat-1:committed')).not.toBeNull();
        expect(await vault.vaultGet('intercede:chat-1:finalized')).toBeNull();
    });

    it('keeps everything when the TTL is zero', async () => {
        const { vault } = await setup();
        await vault.vaultPutStrict('intercede:chat-1:old', {
            transactionId: 'old',
            chatId: 'chat-1',
            state: 'committed',
            finalizedAt: 1,
            createdAt: 1,
        });

        expect(await vault.cleanupVault(0)).toBe(0);
        expect(await vault.vaultGet('intercede:chat-1:old')).not.toBeNull();
    });
});
