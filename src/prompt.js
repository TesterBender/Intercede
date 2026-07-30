/**
 * The one-generation suffix-revision instruction (§11.4).
 */

import { REWRITE_MODES } from './constants.js';

const MODE_ADDENDA = {
    [REWRITE_MODES.PRESERVE]: 'PRESERVE CLOSELY:\nRetain the original wording and sequence wherever logically possible.',
    [REWRITE_MODES.ADAPTIVE]: 'ADAPT NATURALLY:\nPrioritize coherence and natural reaction while preserving important\ncompatible material.',
    [REWRITE_MODES.REIMAGINE]: 'REIMAGINE REMAINDER:\nThe discarded suffix is optional inspiration. Follow the new interaction\nwhere it naturally leads.',
};

/** Defang anything in the suffix that would close our reference container early. */
function sanitizeSuffix(suffix) {
    return String(suffix ?? '').replace(/<\s*\/\s*discarded_suffix\s*>/gi, '</discarded suffix>');
}

/**
 * @param {object} options
 * @param {string} options.suffix the discarded original continuation
 * @param {string} options.mode one of REWRITE_MODES
 * @returns {string}
 */
export function buildRewritePrompt({ suffix, mode }) {
    const addendum = MODE_ADDENDA[mode] ?? MODE_ADDENDA[REWRITE_MODES.ADAPTIVE];
    return [
        "A user response has been inserted into the middle of the character's",
        'previous message.',
        '',
        'The preceding assistant message is the exact preserved prefix. It has',
        'already occurred and must not be repeated, rewritten, summarized, or',
        'contradicted.',
        '',
        'The latest user message is the newly inserted response. Continue directly',
        'from it.',
        '',
        'The text inside <discarded_suffix> was the original continuation before',
        'the user response was inserted. It is editorial reference material, not',
        'canonical history and not an event that has already happened.',
        '',
        '<discarded_suffix>',
        sanitizeSuffix(suffix),
        '</discarded_suffix>',
        '',
        'Write only the assistant continuation that follows the latest user message.',
        '',
        'Preserve compatible dialogue, intentions, revelations, actions, emotional',
        'beats, and style from the discarded suffix. Revise transitions, reactions,',
        'timing, wording, ordering, and events as needed to account naturally for',
        "the user's response. Remove anything that no longer makes sense.",
        '',
        'Do not mention editing, drafts, suffixes, instructions, or this operation.',
        "Do not repeat the preceding assistant message or the user's response.",
        'Begin directly with the next narrative action or spoken line.',
        '',
        addendum,
    ].join('\n');
}
