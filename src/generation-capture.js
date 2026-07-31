/**
 * Capture of the assistant message this transaction generated (§5.3, INV-03).
 *
 * Taking `chat[chat.length - 1]` after generation is unsafe: another extension
 * can append between the reply landing and generation ending, and the tail is
 * then somebody else's message. Instead we watch the assistant-message event.
 *
 * The critical distinction is between an *observed candidate* and an *owned
 * message*. The event handler only records what it saw; it writes nothing. A
 * candidate becomes owned only once `proveGeneratedSuffix` has checked it
 * against the transaction's expected shape. Marking inside the handler would
 * make the marker self-justifying — Intercede would tag the first assistant
 * message to arrive, then later treat its own tag as evidence of ownership,
 * which is exactly the inference INV-03 exists to forbid.
 *
 * The event name and payload shape are the one place this file is coupled to a
 * SillyTavern version. If 1.18.x differs from the normalization below, fix it
 * here and record the observed payload in tests — never by relaxing the
 * ownership proof downstream.
 */

import { RecoveryRequiredError } from './errors.js';
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
 * Watch for assistant messages while this transaction is generating.
 *
 * @returns {{ finish: () => Array, dispose: () => void, eventName: string }}
 *   `finish()` yields every candidate observed, in arrival order. It never
 *   decides which one is ours.
 */
export function beginAssistantCapture(ctx, { chatId, expectedGenerationKind = 'normal' }) {
    const eventName = getCaptureEventName(ctx);
    if (!eventName) {
        throw new Error('No supported assistant-message capture event is available.');
    }

    const candidates = [];
    let closed = false;

    const handler = (payload, generationType) => {
        if (closed) return;
        if (getCurrentChatId(ctx) !== chatId) return;

        // Builds that pass no type are treated as ordinary generation rather
        // than filtered out, so capture does not silently observe nothing.
        const kind = (generationType === undefined || generationType === null || generationType === '')
            ? 'normal'
            : String(generationType);
        if (kind !== expectedGenerationKind) return;

        const index = normalizeMessageIndex(payload, ctx);
        const message = ctx.chat[index];
        if (!message || message.is_user || message.is_system) return;

        // The same message announced twice is one candidate, not two.
        if (candidates.some(candidate => candidate.message === message)) return;

        candidates.push({ index, message, kind });
    };

    getEventSource(ctx)?.on(eventName, handler);

    const dispose = () => {
        if (closed) return;
        closed = true;
        getEventSource(ctx)?.off?.(eventName, handler);
    };

    return {
        finish() {
            dispose();
            return [...candidates];
        },
        dispose,
        eventName,
    };
}

/**
 * Promote an observed candidate to an owned message, or refuse.
 *
 * This is deliberately structural only. It answers "is this message the one
 * this transaction created?" — not "was it generated with the right
 * instruction", which the lease receipt answers separately. Keeping them apart
 * matters for rollback: a continuation produced without the rewrite prompt is
 * still *ours* to remove, whereas an ambiguous tail is nobody's to touch.
 *
 * @throws {RecoveryRequiredError} when ownership cannot be established.
 * @returns {{ index: number, message: object }}
 */
export function proveGeneratedSuffix({ candidates, chat, ownership }) {
    if (candidates.length === 0) {
        throw new RecoveryRequiredError(
            'No assistant continuation was captured for this intercession.',
        );
    }
    if (candidates.length !== 1) {
        throw new RecoveryRequiredError(
            `Expected one assistant message during this intercession but observed ${candidates.length}.`,
        );
    }

    const [candidate] = candidates;

    if (chat.length !== ownership.expectedChatLength) {
        throw new RecoveryRequiredError(
            `The chat holds ${chat.length} messages but this intercession expected ${ownership.expectedChatLength}.`,
        );
    }
    if (candidate.index !== ownership.expectedSuffixIndex) {
        throw new RecoveryRequiredError(
            `The continuation arrived at index ${candidate.index} but this intercession expected index ${ownership.expectedSuffixIndex}.`,
        );
    }
    if (chat[ownership.expectedSuffixIndex] !== candidate.message) {
        throw new RecoveryRequiredError(
            'The captured continuation is no longer at the position it arrived in.',
        );
    }
    if (candidate.message.is_user || candidate.message.is_system) {
        throw new RecoveryRequiredError(
            'The captured continuation is not an assistant message.',
        );
    }

    markOwnedMessage(candidate.message, ownership.transactionId, OWNED_ROLE.SUFFIX_PENDING);
    return { index: candidate.index, message: candidate.message };
}
