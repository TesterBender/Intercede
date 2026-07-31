/**
 * Access layer for the SillyTavern client context.
 *
 * Everything goes through SillyTavern.getContext() rather than importing internal
 * client modules, per the official extension guidance. Names that have shifted
 * between releases (eventTypes/event_types, extensionPromptTypes/…) are resolved
 * here with fallbacks so the rest of the extension can stay clean.
 */

import { DEFAULT_SETTINGS, MODULE_NAME } from './constants.js';

export function getCtx() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

export function getEventTypes(ctx = getCtx()) {
    return ctx?.eventTypes ?? ctx?.event_types ?? {};
}

export function getEventSource(ctx = getCtx()) {
    return ctx?.eventSource ?? null;
}

/** extension_prompt_types with literal fallbacks matching SillyTavern's values. */
export function getPromptTypes(ctx = getCtx()) {
    return ctx?.extensionPromptTypes ?? ctx?.extension_prompt_types ?? { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
}

/** extension_prompt_roles with literal fallbacks matching SillyTavern's values. */
export function getPromptRoles(ctx = getCtx()) {
    return ctx?.extensionPromptRoles ?? ctx?.extension_prompt_roles ?? { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
}

export function getCurrentChatId(ctx = getCtx()) {
    if (!ctx) return null;
    if (typeof ctx.getCurrentChatId === 'function') {
        try {
            const id = ctx.getCurrentChatId();
            if (id !== undefined) return id ?? null;
        } catch { /* fall through */ }
    }
    return ctx.chatId ?? null;
}

export function isGroupChat(ctx = getCtx()) {
    return Boolean(ctx?.groupId);
}

/** The mutable per-chat metadata object. Must be reacquired after CHAT_CHANGED. */
export function getChatMetadata(ctx = getCtx()) {
    return ctx?.chatMetadata ?? ctx?.chat_metadata ?? null;
}

export async function saveMetadata(ctx = getCtx()) {
    if (!ctx) return;
    if (typeof ctx.saveMetadata === 'function') {
        await ctx.saveMetadata();
    } else if (typeof ctx.saveChat === 'function') {
        await ctx.saveChat();
    }
}

/**
 * Persist chat and metadata exactly once each.
 *
 * saveMetadata() above falls back to saveChat(), so calling both in sequence can
 * save the chat twice. Callers that have already saved the chat use this
 * instead, which makes the second call a no-op when the host has no separate
 * metadata save.
 */
export async function persistChatAndMetadata(ctx = getCtx()) {
    if (!ctx) throw new Error('SillyTavern context unavailable.');
    await ctx.saveChat();
    if (typeof ctx.saveMetadata === 'function') {
        await ctx.saveMetadata();
    }
}

/**
 * Remove a single message and keep the rendered chat consistent with the array.
 *
 * Prefers the host's own deletion (which reindexes and notifies other
 * extensions). The fallback splices and reprints, because removing a DOM node
 * by `mesid` only stays coherent when deleting strictly from the tail.
 */
export async function deleteMessageAt(ctx, index) {
    if (typeof ctx.deleteMessage === 'function') {
        await ctx.deleteMessage(index);
        return;
    }

    ctx.chat.splice(index, 1);

    if (typeof ctx.printMessages === 'function') {
        ctx.printMessages();
        return;
    }

    document.querySelector('#chat')?.replaceChildren();
    ctx.chat.forEach((message, messageIndex) => {
        try {
            ctx.addOneMessage(message, { forceId: messageIndex, scroll: false });
        } catch { /* rendering is best-effort; canonical state is already correct */ }
    });
}

/** Persistent extension settings (extension_settings.intercede), with defaults applied. */
export function getSettings(ctx = getCtx()) {
    const store = ctx?.extensionSettings ?? ctx?.extension_settings;
    if (!store) return { ...DEFAULT_SETTINGS };
    if (!store[MODULE_NAME] || typeof store[MODULE_NAME] !== 'object') {
        store[MODULE_NAME] = {};
    }
    const settings = store[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) settings[key] = value;
    }
    return settings;
}

export function saveSettings(ctx = getCtx()) {
    ctx?.saveSettingsDebounced?.();
}

/** localforage (bundled with SillyTavern) or a localStorage-backed stand-in. */
export function getStorageBackend() {
    const lf = globalThis.SillyTavern?.libs?.localforage ?? globalThis.localforage;
    if (lf?.createInstance) {
        try {
            return lf.createInstance({ name: 'Intercede' });
        } catch {
            return lf;
        }
    }
    if (lf) return lf;
    return localStorageShim;
}

const SHIM_PREFIX = '__intercede_vault__';
const localStorageShim = {
    async getItem(key) {
        const raw = localStorage.getItem(SHIM_PREFIX + key);
        return raw === null ? null : JSON.parse(raw);
    },
    async setItem(key, value) {
        localStorage.setItem(SHIM_PREFIX + key, JSON.stringify(value));
        return value;
    },
    async removeItem(key) {
        localStorage.removeItem(SHIM_PREFIX + key);
    },
    async keys() {
        const result = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(SHIM_PREFIX)) result.push(key.slice(SHIM_PREFIX.length));
        }
        return result;
    },
};

/**
 * Verify that the context exposes everything the core transaction needs.
 * @returns {{ ok: boolean, missing: string[], optionalMissing: string[] }}
 */
export function checkCapabilities() {
    const ctx = getCtx();
    const missing = [];
    const optionalMissing = [];

    if (!ctx) {
        return { ok: false, missing: ['SillyTavern.getContext()'], optionalMissing };
    }

    const required = ['chat', 'eventSource', 'generate', 'saveChat', 'addOneMessage', 'updateMessageBlock', 'setExtensionPrompt'];
    for (const name of required) {
        if (ctx[name] === undefined) missing.push(name);
    }
    // Naming the events we actually depend on, rather than checking that the
    // map is merely non-empty: a host missing the assistant-message event
    // cannot support ownership capture, and must not start a transaction.
    const eventTypes = getEventTypes(ctx);
    if (!Object.keys(eventTypes).length) {
        missing.push('eventTypes');
    } else {
        for (const name of ['GENERATION_STARTED', 'GENERATION_ENDED', 'CHAT_CHANGED']) {
            if (!eventTypes[name]) missing.push(`eventTypes.${name}`);
        }
        if (!eventTypes.MESSAGE_RECEIVED && !eventTypes.CHARACTER_MESSAGE_RENDERED) {
            missing.push('eventTypes.MESSAGE_RECEIVED (or CHARACTER_MESSAGE_RENDERED)');
        }
    }

    const optional = ['sendMessageAsUser', 'saveMetadata', 'SlashCommandParser', 'stopGeneration', 'substituteParams'];
    for (const name of optional) {
        if (ctx[name] === undefined) optionalMissing.push(name);
    }

    return { ok: missing.length === 0, missing, optionalMissing };
}
