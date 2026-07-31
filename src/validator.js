/**
 * Post-generation validation (§12.6) and quality heuristics (§17.6, §17.7).
 *
 * @see docs/RATIONALE.md#VAL-01 structural is fatal, stylistic only warns
 */

import { isOwnedMessage, OWNED_ROLE } from './ownership.js';
import { normalizeForComparison } from './utils.js';

/**
 * Structural validation against proven ownership (§5.4, INV-02/INV-03/INV-04).
 *
 * @see docs/RATIONALE.md#VAL-01 the two independent checks per message
 * @see docs/RATIONALE.md#VAL-02 why an over-long chat is fatal
 * @see docs/RATIONALE.md#VAL-03 prefix is compared byte-for-byte
 *
 * @param {object} params
 * @param {Array} params.chat
 * @param {object} params.ownership from createOwnership(), with refs populated
 * @param {string} params.prefix
 * @param {string} params.insertion
 * @returns {{ ok: boolean, fatal: string[], warnings: string[], suffixMessage: object | null }}
 */
export function validateOwnedStructure({ chat, ownership, prefix, insertion }) {
    const fatal = [];
    const warnings = [];

    if (chat.length !== ownership.expectedChatLength) {
        fatal.push(
            `Expected exactly ${ownership.expectedChatLength} messages after generation but found ${chat.length} — another extension changed the chat during this intercession.`,
        );
    }

    const prefixMessage = chat[ownership.prefixIndex];
    const userMessage = chat[ownership.insertionIndex];
    const suffixMessage = chat[ownership.expectedSuffixIndex];

    if (prefixMessage !== ownership.prefixRef
        || !isOwnedMessage(prefixMessage, ownership.transactionId, OWNED_ROLE.PREFIX)
        || prefixMessage?.is_user) {
        fatal.push('The preserved prefix is no longer the message this intercession cut.');
    } else if (prefixMessage.mes !== prefix) {
        fatal.push('The preserved prefix text was changed during generation.');
    }

    if (userMessage !== ownership.insertionRef
        || !isOwnedMessage(userMessage, ownership.transactionId, OWNED_ROLE.INSERTION)
        || !userMessage?.is_user) {
        fatal.push('The inserted user message is missing or no longer belongs to this intercession.');
    } else if (normalizeForComparison(userMessage.mes) !== normalizeForComparison(insertion)) {
        warnings.push('The inserted user message text was transformed (macros or bias may have applied).');
    }

    if (ownership.suffixIndex === null) {
        fatal.push('No revised continuation was captured.');
    } else if (ownership.suffixIndex !== ownership.expectedSuffixIndex) {
        fatal.push(
            `The revised continuation is at index ${ownership.suffixIndex} but this intercession expected index ${ownership.expectedSuffixIndex}.`,
        );
    } else if (suffixMessage !== ownership.suffixRef
        || !isOwnedMessage(suffixMessage, ownership.transactionId, OWNED_ROLE.SUFFIX_PENDING)) {
        fatal.push('The revised continuation is missing or no longer belongs to this intercession.');
    } else if (suffixMessage.is_user) {
        fatal.push('The generated continuation is not an assistant message.');
    } else if (suffixMessage.is_system) {
        fatal.push('The generated continuation is a system message.');
    } else if (!String(suffixMessage.mes ?? '').trim()) {
        fatal.push('The generated continuation is empty.');
    }

    return {
        ok: fatal.length === 0,
        fatal,
        warnings,
        suffixMessage: fatal.length === 0 ? suffixMessage : null,
    };
}

/**
 * Detect the generated text re-opening with the tail of the preserved prefix.
 * Comparison is whitespace- and case-normalized.
 * @returns {{ overlapChars: number, snippet: string } | null}
 */
export function detectPrefixOverlap(prefix, generated, minChars = 30) {
    const prefixNorm = normalizeForComparison(prefix);
    const generatedNorm = normalizeForComparison(generated);
    if (!prefixNorm || !generatedNorm) return null;

    const window = Math.min(240, prefixNorm.length, generatedNorm.length);
    for (let length = window; length >= minChars; length--) {
        const head = generatedNorm.slice(0, length);
        if (prefixNorm.endsWith(head)) {
            return { overlapChars: length, snippet: generated.slice(0, Math.min(length + 20, generated.length)) };
        }
    }
    return null;
}

/** Detect the model echoing the inserted user response near the start of its output. */
export function detectInsertionEcho(insertion, generated) {
    const insertionNorm = normalizeForComparison(insertion);
    if (insertionNorm.length < 12) return false;
    const head = normalizeForComparison(generated).slice(0, insertionNorm.length + 80);
    return head.includes(insertionNorm);
}

const META_COMMENTARY_REGEX = /\b(scene[ _]notes|discarded[ _]suffix|editorial reference|original draft|planning material|as an ai\b|the user'?s? insertion|per your instructions?|rewritten continuation)\b/i;

export function detectMetaCommentary(generated) {
    return META_COMMENTARY_REGEX.test(generated);
}

function wordTrigrams(text) {
    const words = normalizeForComparison(text).split(' ').filter(Boolean);
    const grams = new Set();
    for (let i = 0; i + 2 < words.length; i++) {
        grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
    return grams;
}

/**
 * Textual-overlap indicator between the discarded and revised suffixes (§17.6).
 * @see docs/RATIONALE.md#VAL-04 — overlap, NOT semantic fidelity
 */
export function computePreservation(originalSuffix, revisedSuffix) {
    const a = wordTrigrams(originalSuffix);
    const b = wordTrigrams(revisedSuffix);
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const gram of a) {
        if (b.has(gram)) shared++;
    }
    return Math.round((200 * shared) / (a.size + b.size));
}

/**
 * Run all quality heuristics; returns human-readable warning strings.
 */
export function qualityWarnings({ prefix, insertion, suffix, generated, mode }) {
    const warnings = [];

    const overlap = detectPrefixOverlap(prefix, generated);
    if (overlap) {
        warnings.push(`The continuation re-opens with ~${overlap.overlapChars} characters of the preserved prefix.`);
    }
    if (detectInsertionEcho(insertion, generated)) {
        warnings.push('The continuation appears to repeat your inserted response.');
    }
    if (detectMetaCommentary(generated)) {
        warnings.push('The continuation may contain meta-commentary about the rewrite.');
    }

    const preservation = computePreservation(suffix, generated);
    if (mode === 'preserve' && preservation < 15) {
        warnings.push(`Preserve-closely mode, but textual overlap with the original continuation is low (~${preservation}%).`);
    }
    if (preservation > 90 && !detectInsertionEcho(insertion, generated)) {
        const insertionAcknowledged = normalizeForComparison(generated).length !== normalizeForComparison(suffix).length;
        if (!insertionAcknowledged) {
            warnings.push('The continuation is nearly identical to the original — your response may not have been acknowledged.');
        }
    }

    return { warnings, preservation };
}
