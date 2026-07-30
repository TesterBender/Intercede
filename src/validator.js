/**
 * Post-generation validation (§12.6) and quality heuristics (§17.6, §17.7).
 *
 * Structural corruption is fatal (triggers rollback). Stylistic problems —
 * prefix repetition, ignored insertion, meta-commentary — produce warnings only:
 * ambiguous prose is shown to the user, never silently rejected or rewritten.
 */

import { normalizeForComparison } from './utils.js';

/**
 * Structural validation of the chat tail after generation.
 * @param {object} params
 * @param {Array} params.chat
 * @param {number} params.targetIndex
 * @param {string} params.prefix
 * @param {string} params.insertion
 * @returns {{ ok: boolean, fatal: string[], warnings: string[] }}
 */
export function validateStructure({ chat, targetIndex, prefix, insertion }) {
    const fatal = [];
    const warnings = [];
    const expectedLength = targetIndex + 3;

    const prefixMessage = chat[targetIndex];
    const userMessage = chat[targetIndex + 1];
    const tip = chat[chat.length - 1];

    if (!prefixMessage || prefixMessage.is_user || prefixMessage.mes !== prefix) {
        fatal.push('The preserved prefix message no longer matches the transaction.');
    }
    if (!userMessage || !userMessage.is_user) {
        fatal.push('The inserted user message is missing.');
    } else if (normalizeForComparison(userMessage.mes) !== normalizeForComparison(insertion)) {
        warnings.push('The inserted user message text was transformed (macros or bias may have applied).');
    }
    if (chat.length < expectedLength) {
        fatal.push('No revised continuation was generated.');
    } else {
        if (!tip || tip.is_user) {
            fatal.push('The generated continuation is not an assistant message.');
        } else if (tip.is_system) {
            fatal.push('The generated continuation is a system message.');
        } else if (!String(tip.mes ?? '').trim()) {
            fatal.push('The generated continuation is empty.');
        }
        if (chat.length > expectedLength) {
            warnings.push(`Expected ${expectedLength} messages but found ${chat.length} — another extension may have added messages.`);
        }
    }

    return { ok: fatal.length === 0, fatal, warnings };
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

const META_COMMENTARY_REGEX = /\b(discarded[ _]suffix|editorial reference|original draft|as an ai\b|the user'?s? insertion|per your instructions?|rewritten continuation)\b/i;

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
 * A Sørensen–Dice coefficient over word trigrams, as a rounded percentage.
 * This measures textual overlap only — it is not a claim about semantic fidelity.
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
