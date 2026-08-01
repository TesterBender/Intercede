/**
 * Capture of the assistant message this transaction generated (§5.3, INV-03).
 *
 * @see docs/RATIONALE.md#CAP-01 observed candidate is not an owned message
 * @see docs/RATIONALE.md#CAP-02 the one place coupled to a SillyTavern version
 * @see docs/RATIONALE.md#CAP-05 the proof here is structural only, by design
 */

import { RecoveryRequiredError } from './errors.js';
import { classifyGenerationKind } from './lease.js';
import { getCurrentChatId, getEventSource, getEventTypes } from './stcontext.js';
import { markOwnedMessage, OWNED_ROLE } from './ownership.js';

/**
 * Resolve the message index from the host's event payload.
 * @see docs/RATIONALE.md#CAP-03 accepted payload shapes
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
 * @returns {{ finish: () => Array, evidence: () => object, dispose: () => void, eventName: string }}
 *   `finish()` yields every candidate observed, in arrival order. It never
 *   decides which one is ours — @see docs/RATIONALE.md#CAP-01
 *   `evidence()` reports why the events that did *not* become candidates were
 *   set aside. Counts and kind names only — @see docs/RATIONALE.md#CAP-07
 */
export function beginAssistantCapture(ctx, { chatId, expectedGenerationKind = 'normal' }) {
    const eventName = getCaptureEventName(ctx);
    if (!eventName) {
        throw new Error('No supported assistant-message capture event is available.');
    }

    const candidates = [];
    /** Why events were set aside. Metadata only. @see docs/RATIONALE.md#CAP-07 */
    const observed = {
        events: 0,
        otherChat: 0,
        namedOtherKind: 0,
        unresolvedIndex: 0,
        notAssistant: 0,
        alreadySeen: 0,
        kinds: {},
    };
    let closed = false;

    const handler = (payload, generationType) => {
        if (closed) return;
        observed.events += 1;
        if (getCurrentChatId(ctx) !== chatId) { observed.otherChat += 1; return; }

        // @see docs/RATIONALE.md#CAP-04, #CAP-06
        const { kind, source } = classifyGenerationKind(generationType);
        const label = source === 'opaque' ? 'opaque' : kind;
        observed.kinds[label] = (observed.kinds[label] ?? 0) + 1;

        if (source === 'named' && kind !== expectedGenerationKind) {
            observed.namedOtherKind += 1;
            return;
        }

        const index = normalizeMessageIndex(payload, ctx);
        const message = ctx.chat[index];
        if (!message) { observed.unresolvedIndex += 1; return; }
        if (message.is_user || message.is_system) { observed.notAssistant += 1; return; }
        if (candidates.some(candidate => candidate.message === message)) {
            observed.alreadySeen += 1;
            return;
        }

        candidates.push({ index, message, kind, kindSource: source });
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
        evidence() {
            return { eventName, expectedGenerationKind, candidates: candidates.length, ...observed };
        },
        dispose,
        eventName,
    };
}

/**
 * Promote an observed candidate to an owned message, or refuse.
 *
 * @see docs/RATIONALE.md#CAP-05 why this stays separate from the lease receipt
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
