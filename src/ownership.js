/**
 * Proof of message ownership (§5.2, INV-03).
 *
 * Array position is not proof. Another extension can append, insert, or reorder
 * messages while Intercede is generating, so every message the transaction
 * intends to rewrite or delete must be identifiable by two independent means:
 * the object reference captured when the transaction created it, and a marker
 * written into `message.extra`.
 */

import { METADATA_KEY } from './constants.js';

/** Marker roles a message can carry for a transaction. */
export const OWNED_ROLE = Object.freeze({
    PREFIX: 'prefix',
    INSERTION: 'insertion',
    /** The captured continuation, before commit has accepted it. */
    SUFFIX_PENDING: 'suffix-pending',
    SUFFIX: 'suffix',
});

export function getIntercedeMarker(message) {
    const marker = message?.extra?.[METADATA_KEY];
    return (marker && typeof marker === 'object') ? marker : null;
}

export function isOwnedMessage(message, transactionId, role) {
    const marker = getIntercedeMarker(message);
    return marker?.transactionId === transactionId && marker?.role === role;
}

/**
 * Write an ownership marker, preserving chain provenance.
 *
 * A revised continuation can itself be interceded, so the message may already
 * carry an earlier transaction's marker. That earlier link is folded into
 * `parent` rather than discarded — undo relies on it to identify the
 * intercession the current one was cut from. Re-marking a message this
 * transaction already owns (suffix-pending to suffix) keeps whatever parent it
 * had.
 */
export function markOwnedMessage(message, transactionId, role) {
    const previous = getIntercedeMarker(message);
    let parent;

    if (previous?.transactionId === transactionId) {
        parent = previous.parent;
    } else if (previous?.transactionId) {
        parent = { transactionId: previous.transactionId, role: previous.role };
    }

    message.extra = {
        ...(message.extra ?? {}),
        [METADATA_KEY]: {
            transactionId,
            role,
            ...(parent ? { parent } : {}),
        },
    };
    return message;
}

/** Roles a transaction is allowed to have written. */
const KNOWN_ROLES = new Set(Object.values(OWNED_ROLE));

export function hasKnownRole(message, transactionId) {
    const marker = getIntercedeMarker(message);
    return marker?.transactionId === transactionId && KNOWN_ROLES.has(marker.role);
}

/**
 * Remove this transaction's marker, restoring the earlier link it displaced.
 *
 * Used when an interrupted transaction is abandoned rather than restored: the
 * messages stay, but they must stop claiming to belong to a transaction that
 * never completed. A chained message goes back to advertising its parent, so
 * the intercession below it remains identifiable.
 */
export function clearOwnedMarker(message, transactionId) {
    const marker = getIntercedeMarker(message);
    if (marker?.transactionId !== transactionId) return false;

    if (marker.parent?.transactionId) {
        message.extra[METADATA_KEY] = { ...marker.parent };
    } else {
        delete message.extra[METADATA_KEY];
    }
    return true;
}

/**
 * The bookkeeping a transaction needs to prove what it created.
 *
 * `expectedSuffixIndex` is where the continuation should land; `suffixIndex` is
 * where it actually landed, filled in by generation capture. They are compared,
 * never assumed equal.
 */
export function createOwnership(transactionId, targetIndex, originalChatLength) {
    return {
        transactionId,
        originalChatLength,
        prefixIndex: targetIndex,
        insertionIndex: targetIndex + 1,
        expectedSuffixIndex: targetIndex + 2,
        expectedChatLength: originalChatLength + 2,
        suffixIndex: null,
        prefixRef: null,
        insertionRef: null,
        suffixRef: null,
    };
}

/**
 * Locate an owned message by reference, and verify its marker still agrees.
 * @returns {{ index: number, message: object } | null}
 */
export function findOwned(chat, ref, transactionId, role) {
    if (!ref) return null;
    const index = chat.indexOf(ref);
    if (index < 0) return null;
    if (!isOwnedMessage(ref, transactionId, role)) return null;
    return { index, message: ref };
}
