/**
 * Proof of message ownership (§5.2, INV-03).
 *
 * @see docs/RATIONALE.md#OWN-01 why position is never proof
 * @see docs/RATIONALE.md#OWN-02 markers merge to preserve chain provenance
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
 * @see docs/RATIONALE.md#OWN-02 — merging is load-bearing; do not overwrite
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
 * @see docs/RATIONALE.md#OWN-03
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
 * @see docs/RATIONALE.md#OWN-04 expected vs actual position
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
