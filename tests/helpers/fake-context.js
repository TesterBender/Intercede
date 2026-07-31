/**
 * A fake SillyTavern client context for module tests.
 *
 * The extension reaches the host exclusively through
 * `globalThis.SillyTavern.getContext()` (see src/stcontext.js), so installing a
 * fake global is enough to drive the real transaction code — no module mocking.
 *
 * Several modules hold state at module scope (`activeTransaction` in
 * transaction.js, `store`/`cache` in vault.js, `currentLease` in lease.js).
 * Tests must therefore `vi.resetModules()` and re-import between cases; see
 * `freshModules()` below.
 */

import { vi } from 'vitest';

/** Default chat id used when a test does not supply one. */
export const CHAT_ID = 'chat-1';

export function assistantMessage(text, extra = undefined) {
    return {
        name: 'Character',
        is_user: false,
        is_system: false,
        send_date: 'January 1, 2026 12:00pm',
        mes: text,
        ...(extra ? { extra } : {}),
    };
}

export function userMessage(text) {
    return {
        name: 'You',
        is_user: true,
        is_system: false,
        send_date: 'January 1, 2026 12:00pm',
        mes: text,
        extra: {},
    };
}

/**
 * An in-memory localforage stand-in with failure injection.
 *
 * `failSetOnce` / `failGetOnce` reject the next call. `swallowSetOnce` resolves
 * without persisting, which is how a durable write can succeed from the caller's
 * point of view while the record is not actually there — the case that must not
 * be masked by the in-memory cache.
 */
export function createFakeStorage() {
    const data = new Map();
    const control = {
        failSetOnce: null,
        failGetOnce: null,
        swallowSetOnce: false,
        setCalls: 0,
        getCalls: 0,
    };

    const store = {
        async setItem(key, value) {
            control.setCalls++;
            if (control.failSetOnce) {
                const error = control.failSetOnce;
                control.failSetOnce = null;
                throw error;
            }
            if (control.swallowSetOnce) {
                control.swallowSetOnce = false;
                return value;
            }
            data.set(key, structuredClone(value));
            return value;
        },
        async getItem(key) {
            control.getCalls++;
            if (control.failGetOnce) {
                const error = control.failGetOnce;
                control.failGetOnce = null;
                throw error;
            }
            const value = data.get(key);
            return value === undefined ? null : structuredClone(value);
        },
        async removeItem(key) {
            data.delete(key);
        },
        async keys() {
            return [...data.keys()];
        },
    };

    return { store, data, control, createInstance: () => store };
}

/**
 * Install a fake `globalThis.SillyTavern` and return the context plus handles.
 *
 * @param {object} [options]
 * @param {Array} [options.chat] initial chat array (cloned)
 * @param {string} [options.chatId]
 * @param {object} [options.chatMetadata]
 * @param {boolean} [options.withSendMessageAsUser] expose the native user-send path
 */
export function installFakeSillyTavern(options = {}) {
    const {
        chat = [assistantMessage('Prefix sentence. Suffix sentence.')],
        chatId = CHAT_ID,
        chatMetadata = {},
        withSendMessageAsUser = false,
    } = options;

    const handlers = new Map();
    const eventSource = {
        on(name, handler) {
            if (!handlers.has(name)) handlers.set(name, new Set());
            handlers.get(name).add(handler);
        },
        off(name, handler) {
            handlers.get(name)?.delete(handler);
        },
        async emit(name, ...args) {
            for (const handler of [...(handlers.get(name) ?? [])]) {
                await handler(...args);
            }
        },
        listenerCount(name) {
            return handlers.get(name)?.size ?? 0;
        },
    };

    const storage = createFakeStorage();

    const ctx = {
        chat: structuredClone(chat),
        chatId,
        chatMetadata: structuredClone(chatMetadata),
        name1: 'You',
        eventSource,
        eventTypes: {
            APP_READY: 'app_ready',
            CHAT_CHANGED: 'chat_changed',
            GENERATION_STARTED: 'generation_started',
            GENERATION_ENDED: 'generation_ended',
            GENERATION_STOPPED: 'generation_stopped',
            MESSAGE_RECEIVED: 'message_received',
            MESSAGE_SENT: 'message_sent',
            MESSAGE_UPDATED: 'message_updated',
            USER_MESSAGE_RENDERED: 'user_message_rendered',
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
        },
        extensionSettings: { intercede: {} },
        getCurrentChatId: () => ctx.chatId,
        generate: vi.fn(async () => {}),
        saveChat: vi.fn(async () => {}),
        saveMetadata: vi.fn(async () => {}),
        addOneMessage: vi.fn(),
        updateMessageBlock: vi.fn(),
        printMessages: vi.fn(),
        stopGeneration: vi.fn(),
        setExtensionPrompt: vi.fn(),
        saveSettingsDebounced: vi.fn(),
        substituteParams: (text) => text,
    };

    if (withSendMessageAsUser) {
        ctx.sendMessageAsUser = vi.fn(async (text) => {
            ctx.chat.push(userMessage(text));
        });
    }

    globalThis.SillyTavern = {
        getContext: () => ctx,
        libs: { localforage: storage },
    };

    try {
        globalThis.localStorage?.clear();
    } catch { /* jsdom always provides one; ignore if not */ }

    return { ctx, eventSource, storage, handlers };
}

export function uninstallFakeSillyTavern() {
    delete globalThis.SillyTavern;
    try {
        globalThis.localStorage?.clear();
    } catch { /* ignore */ }
}

/**
 * Re-import the extension modules with fresh module-level state.
 * Call after `vi.resetModules()` and after installing the fake context.
 */
export async function freshModules() {
    const [transaction, vault, validator, lease, constants, anchors, segmentation] = await Promise.all([
        import('../../src/transaction.js'),
        import('../../src/vault.js'),
        import('../../src/validator.js'),
        import('../../src/lease.js'),
        import('../../src/constants.js'),
        import('../../src/anchors.js'),
        import('../../src/segmentation.js'),
    ]);
    return { transaction, vault, validator, lease, constants, anchors, segmentation };
}

/**
 * Build the anchor a UI selection would produce for a cut at `offset`.
 * Uses the real anchor module so tests exercise real resolution.
 */
export async function anchorAt(raw, offset, boundaryType = 'sentence') {
    const { createAnchor } = await import('../../src/anchors.js');
    return createAnchor(raw, offset, boundaryType);
}

/**
 * Drive a full transaction the way the UI does.
 * `ctx.generate` should be configured by the caller first.
 */
export async function runTransaction(transactionModule, { ctx, targetIndex = ctx.chat.length - 1, offset, insertionText = 'I cut in here.', rewriteMode = 'adaptive' }) {
    const raw = String(ctx.chat[targetIndex].mes ?? '');
    const anchor = await anchorAt(raw, offset);
    const tx = new transactionModule.IntercedeTransaction({
        targetIndex,
        anchor,
        insertionText,
        rewriteMode,
    });
    return tx.run();
}

/**
 * Simulate SillyTavern producing an assistant reply during `generate()`:
 * fires GENERATION_STARTED, appends the message, fires MESSAGE_RECEIVED and
 * GENERATION_ENDED in the order a real backend does.
 */
export function respondWith(ctx, text, options = {}) {
    const { kind = 'normal', extraMessages = [], emitReceived = true } = options;
    return async () => {
        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, kind, {}, false);

        const generated = assistantMessage(text);
        ctx.chat.push(generated);
        const index = ctx.chat.length - 1;
        if (emitReceived) {
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, index);
        }

        for (const extra of extraMessages) {
            ctx.chat.push(extra);
        }

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED, kind);
        return generated;
    };
}
