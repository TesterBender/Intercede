/**
 * What the user is told when an intercession ends badly.
 *
 * A failure notice is not decoration: it is the only thing standing between the
 * user and a chat they believe has already been restored. Two toasts that
 * disagree are worse than one that is merely terse, and the pair this pins used
 * to disagree about whether anything had been rolled back at all.
 *
 * These drive `confirmAndCommit()` — the real commit pipeline both selection
 * interfaces use — rather than the transaction alone, because the duplication
 * lived in the seam between them.
 *
 * @see docs/RATIONALE.md#ERR-02
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    assistantMessage,
    freshModules,
    installFakeSillyTavern,
    respondWith,
    uninstallFakeSillyTavern,
    userMessage,
} from './helpers/fake-context.js';

const ORIGINAL = 'Prefix sentence. Suffix sentence.';
const CUT_OFFSET = 17;
const INSERTION = 'I cut in here.';

/** Toasts, in the order the user would see them stack up. */
let toasts = [];

function installFakeToastr() {
    toasts = [];
    const record = kind => (message) => { toasts.push({ kind, message: String(message) }); };
    globalThis.toastr = { info: record('info'), success: record('success'), warning: record('warning'), error: record('error') };
}

function errors() {
    return toasts.filter(toast => toast.kind === 'error');
}

async function setup() {
    vi.resetModules();
    installFakeToastr();
    const harness = installFakeSillyTavern({ chat: [userMessage('Hello there.'), assistantMessage(ORIGINAL)] });
    const modules = await freshModules();
    modules.lease.initLease();
    const commitFlow = await import('../src/ui/commit-flow.js');
    return { ...harness, ...modules, commitFlow };
}

/** Run the commit pipeline exactly as the selection UI does, confirmation off. */
function commit(commitFlow, ctx, overrides = {}) {
    const targetIndex = ctx.chat.length - 1;
    const raw = String(ctx.chat[targetIndex].mes ?? '');
    return commitFlow.confirmAndCommit({
        chatId: ctx.getCurrentChatId(),
        targetIndex,
        raw,
        boundary: { offset: CUT_OFFSET, type: 'sentence' },
        insertionText: INSERTION,
        rewriteMode: 'adaptive',
        message: ctx.chat[targetIndex],
        settings: { confirmBeforeCommit: false, warnExtensions: false, compareAfterCommit: false },
        closeMode: () => {},
        ...overrides,
    });
}

beforeEach(() => {
    uninstallFakeSillyTavern();
    delete globalThis.toastr;
});

describe('a terminal failure produces one authoritative notice', () => {
    /**
     * Recovery-required deliberately does *not* roll back — it stops and keeps
     * the evidence. The caller used to announce a rollback on top of it, which
     * told the user their original message was already back while it was still
     * cut in two.
     */
    it('does not claim a rollback when the transaction stopped for recovery', async () => {
        const { ctx, commitFlow, vault } = await setup();
        // The host completes the generation but announces no message at all.
        ctx.generate = vi.fn(respondWith(ctx, 'Never announced.', { emitReceived: false }));

        const committed = await commit(commitFlow, ctx);

        expect(committed).toBe(false);
        expect(errors()).toHaveLength(1);
        expect(errors()[0].message).toMatch(/stopped without changing anything further/);
        expect(errors()[0].message).not.toMatch(/rolled back/);
        // There is something left to recover from, so recovery is offered.
        expect(vault.readJournal()).not.toBeNull();
        expect(errors()[0].message).toMatch(/\/intercede recover/);
    });

    it('reports one rollback, and no recovery, for an ordinary failure', async () => {
        const { ctx, commitFlow, vault } = await setup();
        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, undefined, {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_AFTER_COMMANDS, undefined, {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, ctx.chat.length);
            throw new Error('backend exploded');
        });

        const committed = await commit(commitFlow, ctx);

        expect(committed).toBe(false);
        expect(errors()).toHaveLength(1);
        expect(errors()[0].message).toMatch(/failed and was rolled back/);
        // Nothing is left open, so nothing may point the user at recovery.
        expect(vault.readJournal()).toBeNull();
        expect(toasts.some(toast => /\/intercede recover/.test(toast.message))).toBe(false);
    });

    it('restores the original message exactly on an ordinary rollback', async () => {
        const { ctx, commitFlow } = await setup();
        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, undefined, {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_AFTER_COMMANDS, undefined, {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, ctx.chat.length);
            throw new Error('backend exploded');
        });

        await commit(commitFlow, ctx);

        expect(ctx.chat).toHaveLength(2);
        expect(ctx.chat[1].mes).toBe(ORIGINAL);
    });

    it('keeps the typed response after a failure, and clears it after a commit', async () => {
        const { ctx, commitFlow } = await setup();
        const targetIndex = ctx.chat.length - 1;
        const target = { chatId: ctx.getCurrentChatId(), targetIndex, raw: ORIGINAL };
        commitFlow.setDraft(target, { text: INSERTION, mode: 'adaptive', boundaryOffset: CUT_OFFSET });

        ctx.generate = vi.fn(respondWith(ctx, 'Never announced.', { emitReceived: false }));
        await commit(commitFlow, ctx);

        expect(commitFlow.getDraft(target)?.text).toBe(INSERTION);
    });

    it('says nothing further when the chat changed under the transaction', async () => {
        const { ctx, commitFlow } = await setup();
        ctx.generate = vi.fn(async () => {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, undefined, {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_AFTER_COMMANDS, undefined, {}, false);
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, ctx.chat.length);
            ctx.chatId = 'a-different-chat';
            throw new Error('backend exploded');
        });

        await commit(commitFlow, ctx);

        const spoken = toasts.filter(toast => toast.kind === 'error' || toast.kind === 'warning');
        expect(spoken).toHaveLength(1);
        expect(spoken[0].message).toMatch(/Reopen that chat/);
    });
});

describe('a successful commit', () => {
    it('reports success once, and an advisory warning does not undo it', async () => {
        const { ctx, commitFlow } = await setup();
        ctx.generate = vi.fn(respondWith(ctx, 'As an AI, I have rewritten the passage for you.'));

        const committed = await commit(commitFlow, ctx);

        expect(committed).toBe(true);
        expect(errors()).toHaveLength(0);
        expect(toasts.filter(toast => toast.kind === 'success')).toHaveLength(1);
        expect(toasts.some(toast => toast.kind === 'warning' && /re-reading/.test(toast.message))).toBe(true);
        // Advisory, not structural: the continuation is committed and intact.
        expect(ctx.chat).toHaveLength(4);
        expect(ctx.chat[3].mes).toBe('As an AI, I have rewritten the passage for you.');
    });
});
