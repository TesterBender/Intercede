/**
 * Custom Intercede events (§15) — emitted through the shared SillyTavern
 * eventSource so memory, summary, timeline, and analytics extensions can
 * invalidate derived state after a history rewrite.
 */

import { INTERCEDE_EVENTS } from './constants.js';
import { getEventSource } from './stcontext.js';

/**
 * @param {string} name one of INTERCEDE_EVENTS
 * @param {object} payload
 * @param {string} payload.transactionId
 * @param {string} payload.chatId
 * @param {number} [payload.originalMessageIndex]
 * @param {string} [payload.originalHash]
 * @param {number[]} [payload.affectedMessageIds]
 * @param {string} [payload.discardedSuffixHash]
 * @param {string} payload.operation
 */
export async function emitIntercedeEvent(name, payload) {
    try {
        await getEventSource()?.emit(name, payload);
    } catch (error) {
        console.warn('[Intercede] event handler error for', name, error);
    }
}

export { INTERCEDE_EVENTS };
