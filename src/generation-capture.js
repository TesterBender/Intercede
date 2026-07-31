/**
 * Capture of the assistant message this transaction generated (§5.3, INV-03).
 *
 * Taking `chat[chat.length - 1]` after generation is unsafe: another extension
 * can append between the reply landing and generation ending, and the tail is
 * then somebody else's message. Instead we listen for the assistant-message
 * event and hold on to the object reference that arrives while our lease is
 * active.
 *
 * The event name and payload shape are the one place this file is coupled to a
 * SillyTavern version. If 1.18.x differs from the normalization below, fix it
 * here and record the observed payload in tests — never by relaxing the
 * ownership proof downstream.
 */

import { getCurrentChatId, getEventSource, getEventTypes } from './stcontext.js';
import { markOwnedMessage, OWNED_ROLE } from './ownership.js';

/**
 * SillyTavern has passed the message id as a bare integer historically; some
 * builds pass an object. Accept both, and fall back to identity lookup.
 */
export function normalizeMessageIndex(payload, ctx) {
    if (Number.isInteger(payload)) return payload;
    if (Number.isInteger(payload?.messageId)) return payload.messageId;
    if (Number.isInteger(payload?.index)) return payload.index;
    const candidate = payload?.message ?? payload;
    if (candidate && typeof candidate === 'object') {
        const index = ctx.chat.indexOf(candidate);
        if (index >= 0) return index;
    }
    return -1;
}

export function getCaptureEventName(ctx) {
    const events = getEventTypes(ctx);
    return events.MESSAGE_RECEIVED ?? events.CHARACTER_MESSAGE_RENDERED ?? null;
}

/**
 * Begin watching for this transaction's continuation.
 *
 * @param {object} ctx
 * @param {object} options
 * @param {string} options.transactionId
 * @param {*} options.chatId
 * @param {number} options.expectedIndex
 * @returns {{ finish: () => object, dispose: () => void }}
 */
export function beginAssistantCapture(ctx, { transactionId, chatId, expectedIndex }) {
    const eventName = getCaptureEventName(ctx);
    if (!eventName) {
        throw new Error('No supported assistant-message capture event is available.');
    }

    let captured = null;
    let ambiguousReason = null;

    const handler = (payload) => {
        if (getCurrentChatId(ctx) !== chatId) return;

        const index = normalizeMessageIndex(payload, ctx);
        const message = ctx.chat[index];
        if (!message || message.is_user || message.is_system) return;

        if (captured) {
            // The same message re-announced is not ambiguity; a second distinct
            // assistant message is.
            if (captured.ref !== message) {
                ambiguousReason = 'More than one assistant message arrived during this intercession.';
            }
            return;
        }

        captured = { index, ref: message };
        markOwnedMessage(message, transactionId, OWNED_ROLE.SUFFIX_PENDING);

        if (index !== expectedIndex) {
            ambiguousReason = `The continuation arrived at index ${index}, but this intercession expected index ${expectedIndex}.`;
        }
    };

    getEventSource(ctx)?.on(eventName, handler);

    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        getEventSource(ctx)?.off?.(eventName, handler);
    };

    return {
        /** @returns {{ ok: boolean, reason?: string, index?: number, ref?: object }} */
        finish() {
            dispose();
            if (!captured) {
                return { ok: false, reason: 'No assistant continuation was captured for this intercession.' };
            }
            if (ambiguousReason) {
                return { ok: false, reason: ambiguousReason };
            }
            return { ok: true, index: captured.index, ref: captured.ref };
        },
        dispose,
        get eventName() {
            return eventName;
        },
    };
}
