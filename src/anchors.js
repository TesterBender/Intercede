/**
 * Source-anchored cuts (§17.2 of the design).
 * @see docs/RATIONALE.md#ANC-01 what an anchor records, and why
 */

import { ANCHOR_CONTEXT_CHARS } from './constants.js';
import { splitAtOffset } from './segmentation.js';
import { hashText } from './utils.js';

/**
 * @typedef {object} SourceAnchor
 * @property {number} rawOffset
 * @property {'paragraph' | 'sentence'} boundaryType
 * @property {string} originalMessageHash
 * @property {string} prefixHash
 * @property {string} suffixHash
 * @property {string} contextBefore
 * @property {string} contextAfter
 */

/**
 * @param {string} raw full raw message text at selection time
 * @param {number} offset cut offset into `raw`
 * @param {'paragraph' | 'sentence'} boundaryType
 * @returns {SourceAnchor}
 */
export function createAnchor(raw, offset, boundaryType) {
    const { prefix, suffix } = splitAtOffset(raw, offset);
    return {
        rawOffset: offset,
        boundaryType,
        originalMessageHash: hashText(raw),
        prefixHash: hashText(prefix),
        suffixHash: hashText(suffix),
        contextBefore: raw.slice(Math.max(0, offset - ANCHOR_CONTEXT_CHARS), offset),
        contextAfter: raw.slice(offset, offset + ANCHOR_CONTEXT_CHARS),
    };
}

/**
 * Resolve an anchor against the message's current raw text.
 * @see docs/RATIONALE.md#ANC-02 the conservative rebase rule
 *
 * @param {string} raw current raw message text
 * @param {SourceAnchor} anchor
 * @returns {{ ok: boolean, offset?: number, rebased?: boolean, reason?: string }}
 */
export function resolveAnchor(raw, anchor) {
    if (hashText(raw) === anchor.originalMessageHash) {
        return { ok: true, offset: anchor.rawOffset, rebased: false };
    }

    const needle = anchor.contextBefore + anchor.contextAfter;
    if (!needle || !anchor.contextBefore) {
        return { ok: false, reason: 'Message changed and the cut has no context to rebase with.' };
    }

    const first = raw.indexOf(needle);
    if (first === -1) {
        return { ok: false, reason: 'Message changed and the original cut location no longer exists.' };
    }
    if (raw.indexOf(needle, first + 1) !== -1) {
        return { ok: false, reason: 'Message changed and the cut location is ambiguous.' };
    }

    return { ok: true, offset: first + anchor.contextBefore.length, rebased: true };
}
