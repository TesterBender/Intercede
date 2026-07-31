/**
 * Crash recovery, undo, and snapshot finalization.
 *
 * Recovery runs against a chat that a previous session left half-modified, so
 * these tests build that state directly rather than through a live transaction.
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

const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../src/ui/modal.js', () => ({
    showConfirm: confirmMock,
    showModal: vi.fn(async () => null),
}));

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

/**
 * Reproduce the on-disk state of a session that crashed after inserting the
 * user message but before the continuation was committed.
 */
async function simulateCrashAfterInsertion({ ctx, vault, constants }, { extraTail = [] } = {}) {
    const transactionId = 'tx-crashed';
    const vaultKey = `intercede:${ctx.chatId}:${transactionId}`;
    const original = structuredClone(ctx.chat[1]);
    const { hashText } = await import('../src/utils.js');

    await vault.vaultPutStrict(vaultKey, {
        state: 'snapshotted',
        transactionId,
        chatId: ctx.chatId,
        targetIndex: 1,
        originalChatLength: 2,
        completeOriginalMessage: original,
        metadataSnapshot: { existed: false, value: null },
        discardedSuffix: 'Suffix sentence.',
        prefix: 'Prefix sentence.',
        insertion: 'I cut in here.',
        rewriteMode: 'adaptive',
        createdAt: Date.now(),
    });

    vault.writeJournalStrict({
        transactionId,
        chatId: ctx.chatId,
        stage: constants.JOURNAL_STAGE.USER_INSERTED,
        vaultKey,
        targetIndex: 1,
        expectedTargetHash: hashText(ORIGINAL),
        originalChatLength: 2,
        startedAt: Date.now(),
    });

    // The half-applied chat the crash left behind.
    ctx.chat[1].mes = 'Prefix sentence.';
    ctx.chat[1].extra = { intercede: { transactionId, role: 'prefix' } };
    const inserted = userMessage('I cut in here.');
    inserted.extra = { intercede: { transactionId, role: 'insertion' } };
    ctx.chat.push(inserted, ...extraTail);

    return { transactionId, vaultKey };
}

beforeEach(() => {
    uninstallFakeSillyTavern();
    confirmMock.mockClear();
    confirmMock.mockResolvedValue(true);
});

describe('journal recovery', () => {
    it('restores the original message after an interrupted intercession', async () => {
        const harness = await setup();
        const { ctx, transaction, vault } = harness;
        const { vaultKey } = await simulateCrashAfterInsertion(harness);

        await transaction.checkRecovery();

        expect(ctx.chat).toHaveLength(2);
        expect(ctx.chat[1].mes).toBe(ORIGINAL);
        expect(ctx.chat[1].extra?.intercede).toBeUndefined();
        expect(vault.readJournal()).toBeNull();
        expect(await vault.vaultGet(vaultKey)).toBeNull();
    });

    it('refuses to delete a message it cannot prove belongs to the transaction', async () => {
        const harness = await setup();
        const { ctx, transaction } = harness;
        await simulateCrashAfterInsertion(harness, {
            extraTail: [assistantMessage('Unrelated extension output.')],
        });
        const lengthBefore = ctx.chat.length;

        await transaction.checkRecovery();

        expect(ctx.chat).toHaveLength(lengthBefore);
        expect(ctx.chat.some(m => m.mes === 'Unrelated extension output.')).toBe(true);
        // The half-applied prefix is left as-is rather than guessed at.
        expect(ctx.chat[1].mes).toBe('Prefix sentence.');
    });

    it('leaves the chat untouched when the user declines', async () => {
        const harness = await setup();
        const { ctx, transaction, vault } = harness;
        await simulateCrashAfterInsertion(harness);
        confirmMock.mockResolvedValue(false);

        await transaction.checkRecovery();

        expect(ctx.chat).toHaveLength(3);
        expect(ctx.chat[1].mes).toBe('Prefix sentence.');
        expect(vault.readJournal()).toBeNull();
    });

    it('discards a journal from a stage where nothing had been mutated', async () => {
        const { ctx, transaction, vault, constants } = await setup();
        const { hashText } = await import('../src/utils.js');

        vault.writeJournalStrict({
            transactionId: 'tx-armed',
            chatId: ctx.chatId,
            stage: constants.JOURNAL_STAGE.SNAPSHOTTED,
            vaultKey: `intercede:${ctx.chatId}:tx-armed`,
            targetIndex: 1,
            expectedTargetHash: hashText(ORIGINAL),
            originalChatLength: 2,
            startedAt: Date.now(),
        });

        await transaction.checkRecovery();

        expect(vault.readJournal()).toBeNull();
        expect(ctx.chat[1].mes).toBe(ORIGINAL);
        // Nothing was mutated, so the user is never prompted.
        expect(confirmMock).not.toHaveBeenCalled();
    });

    it('reports an unfinished intercession belonging to a different chat', async () => {
        const { ctx, transaction, vault, constants } = await setup();
        vault.writeJournalStrict({
            transactionId: 'tx-elsewhere',
            chatId: 'some-other-chat',
            stage: constants.JOURNAL_STAGE.USER_INSERTED,
            vaultKey: 'intercede:some-other-chat:tx-elsewhere',
            targetIndex: 1,
            startedAt: Date.now(),
        });

        await transaction.checkRecovery();

        expect(vault.readJournal()?.transactionId).toBe('tx-elsewhere');
        expect(ctx.chat).toHaveLength(2);
    });
});

describe('recovery-required state', () => {
    it('blocks new intercessions and deletes nothing', async () => {
        const { ctx, transaction } = await setup();

        // A before-commit listener appends a message, invalidating the tail
        // this transaction proved it owned.
        ctx.eventSource.on('intercede_before_commit', () => {
            ctx.chat.push(assistantMessage('Injected by a listener.'));
        });
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.'));

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        expect(ctx.chat.some(m => m.mes === 'Injected by a listener.')).toBe(true);
        expect(ctx.chat.some(m => m.mes === 'Revised continuation.')).toBe(true);
        expect(transaction.isRecoveryRequired()).toBe(true);
        expect(transaction.isEligibleTarget(ctx).ok).toBe(false);
    });

    it('can still restore the original from its snapshot on the next load', async () => {
        const { ctx, transaction, vault } = await setup();
        ctx.eventSource.on('intercede_before_commit', () => {
            ctx.chat.push(assistantMessage('Injected by a listener.'));
        });
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.'));

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();
        expect(vault.readJournal().stage).toBe('recovery-required');

        // The listener's message is not ours, so recovery must stop rather than
        // remove it — but it must still offer, and not lose, the snapshot.
        await transaction.checkRecovery();

        expect(ctx.chat.some(m => m.mes === 'Injected by a listener.')).toBe(true);
        expect(confirmMock).toHaveBeenCalled();
    });

    it('unblocks new intercessions when the user keeps the chat as it stands', async () => {
        const { ctx, transaction, vault } = await setup();
        ctx.eventSource.on('intercede_before_commit', () => {
            ctx.chat.push(assistantMessage('Injected by a listener.'));
        });
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.'));

        await expect(runTransaction(transaction, { ctx, offset: CUT_OFFSET })).rejects.toThrow();

        confirmMock.mockResolvedValue(false); // "Keep chat as it is"
        await transaction.checkRecovery();

        expect(transaction.isRecoveryRequired()).toBe(false);
        expect(vault.readJournal()).toBeNull();
    });
});

describe('undo', () => {
    it('restores the original message exactly', async () => {
        const { ctx, transaction } = await setup();
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.'));
        await runTransaction(transaction, { ctx, offset: CUT_OFFSET });

        const result = await transaction.undoIntercession();

        expect(result.ok).toBe(true);
        expect(ctx.chat).toHaveLength(2);
        expect(ctx.chat[1].mes).toBe(ORIGINAL);
        expect(Object.keys(ctx.chatMetadata.intercede.transactions)).toHaveLength(0);
    });

    it('declines when the snapshot is gone rather than approximating', async () => {
        const { ctx, transaction, vault } = await setup();
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.'));
        const committed = await runTransaction(transaction, { ctx, offset: CUT_OFFSET });

        const record = ctx.chatMetadata.intercede.transactions[committed.transactionId];
        await vault.vaultDelete(record.vaultKey);

        expect(await transaction.canUndoTip(ctx)).toBe(false);
        const result = await transaction.undoIntercession();
        expect(result.ok).toBe(false);
        expect(ctx.chat).toHaveLength(4);
    });
});

describe('finalize', () => {
    it('deletes the snapshot and leaves the messages untouched', async () => {
        const { ctx, transaction, vault } = await setup();
        ctx.generate = vi.fn(respondWith(ctx, 'Revised continuation.'));
        const committed = await runTransaction(transaction, { ctx, offset: CUT_OFFSET });
        const vaultKey = ctx.chatMetadata.intercede.transactions[committed.transactionId].vaultKey;

        expect(await transaction.canUndoTip(ctx)).toBe(true);

        const result = await transaction.finalizeIntercession();

        expect(result.ok).toBe(true);
        expect(await vault.vaultGet(vaultKey)).toBeNull();
        expect(await transaction.canUndoTip(ctx)).toBe(false);
        expect(ctx.chat).toHaveLength(4);
        expect(ctx.chat[3].mes).toBe('Revised continuation.');

        const record = ctx.chatMetadata.intercede.transactions[committed.transactionId];
        expect(record.finalizedAt).toBeGreaterThan(0);
        expect(record.vaultKey).toBeUndefined();
    });
});
