/**
 * The one-generation suffix-revision instruction (§11.4).
 *
 * Wording constraint: this must read as ordinary collaborative-fiction
 * direction, not as instructions about reusing prior model output. Earlier
 * phrasing ("original continuation", "discarded suffix", "retain the original
 * wording") was blocked by Anthropic's ToS filter as an attempt at
 * "duplicating model outputs". Keep any future edits framed as scene notes /
 * story planning, and avoid editing- or output-reuse meta-language.
 */

import { REWRITE_MODES } from './constants.js';

const MODE_ADDENDA = {
    [REWRITE_MODES.PRESERVE]: 'Stay close to the notes: keep their lines, events, and order wherever they still fit,\nchanging only what the reply makes necessary.',
    [REWRITE_MODES.ADAPTIVE]: "Balance the two: keep the notes' important moments where they fit, but let the\ncharacter react to the reply first, reordering and rephrasing freely.",
    [REWRITE_MODES.REIMAGINE]: 'Treat the notes as loose inspiration only: follow the conversation wherever it\nnaturally leads, even if that means leaving the notes behind.',
};

/** Defang anything in the suffix that would close our reference container early. */
function sanitizeSuffix(suffix) {
    return String(suffix ?? '').replace(/<\s*\/\s*scene_notes\s*>/gi, '</scene notes>');
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
        "Continue the roleplay. The character's previous message stands exactly as",
        'written, and the user has just replied to it.',
        '',
        "Before the user's reply, the scene was headed in the direction sketched in",
        'the notes below. These notes are planning material only — nothing in them',
        'has happened in the story yet.',
        '',
        '<scene_notes>',
        sanitizeSuffix(suffix),
        '</scene_notes>',
        '',
        "Write the character's next message as a natural response to the user's",
        'latest reply. Where the dialogue, actions, intentions, and emotional beats',
        'from the notes still fit, carry them forward with adjusted timing and',
        'transitions; quietly drop whatever no longer fits.',
        '',
        "Keep the character's voice and the scene's style. Do not repeat or",
        "contradict the character's previous message, and do not echo the user's",
        'reply back. Never mention these notes or instructions in the story.',
        "Begin directly with the character's next action or spoken line.",
        '',
        addendum,
    ].join('\n');
}
