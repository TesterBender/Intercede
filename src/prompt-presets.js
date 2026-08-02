/**
 * Built-in rewrite-instruction presets.
 *
 * The `scene-notes` preset is the wording that shipped through v0.6.0, moved here
 * verbatim so that an install which never touches the settings emits exactly the
 * same prompt it always did. `tests/prompt-config.test.js` pins that byte-for-byte.
 *
 * Wording constraint, inherited from `src/prompt.js` and binding on every preset
 * here and on anything a user writes: this must read as ordinary collaborative-fiction
 * direction, not as instructions about reusing prior model output. Earlier phrasing
 * ("original continuation", "discarded suffix", "retain the original wording") was
 * blocked by Anthropic's ToS filter as an attempt at "duplicating model outputs".
 *
 * @see docs/RATIONALE.md#PROMPT-01 the framing and why it is worded this way
 * @see docs/RATIONALE.md#PROMPT-02 why presets are data and the default is verbatim
 */

import { PROMPT_PRESETS, REWRITE_MODES } from './constants.js';

/** Marks where the discarded continuation is interpolated. Required in every template. */
export const SUFFIX_PLACEHOLDER = '{{suffix}}';

/** Marks where the per-mode wording goes. Optional — appended at the end when absent. */
export const MODE_PLACEHOLDER = '{{mode}}';

/**
 * The v0.6.0 wording. Do not edit to change behaviour — add a preset instead.
 * @see docs/RATIONALE.md#PROMPT-02
 */
const SCENE_NOTES_TEMPLATE = [
    "[Continue the roleplay. The character's previous message stands exactly as written, and the user has just replied to it.",
    '',
    "Before the user's reply, the scene was headed in the direction sketched in the notes below. These notes are planning material only — nothing in them has happened in the story yet.",
    '',
    '<scene_notes>',
    SUFFIX_PLACEHOLDER,
    '</scene_notes>',
    '',
    "Write the character's next message as a natural response to the user's latest reply. Where the dialogue, actions, intentions, and emotional beats from the notes still fit, carry them forward with adjusted timing and transitions; quietly drop whatever no longer fits.",
    '',
    "Keep the character's voice and the scene's style. Do not repeat or contradict the character's previous message, and do not echo the user's reply back. Never mention these notes or instructions in the story.",
    "Begin directly with the character's next action or spoken line.]",
    '',
    MODE_PLACEHOLDER,
].join('\n');

/** The v0.6.0 mode addenda, likewise verbatim. */
const SCENE_NOTES_ADDENDA = Object.freeze({
    [REWRITE_MODES.PRESERVE]: 'Stay close to the notes: keep their lines, events, and order wherever they still fit,\nchanging only what the reply makes necessary.',
    [REWRITE_MODES.ADAPTIVE]: "Balance the two: keep the notes' important moments where they fit, but let the\ncharacter react to the reply first, reordering and rephrasing freely.",
    [REWRITE_MODES.REIMAGINE]: 'Treat the notes as loose inspiration only: follow the conversation wherever it\nnaturally leads, even if that means leaving the notes behind.',
});

/**
 * The shorter variant that lived commented out beside the default through v0.6.0.
 * Same framing, fewer tokens — for backends that lose the thread across a long preamble.
 */
const DIRECT_TEMPLATE = [
    "[Continue the roleplay after the user's latest reply. The character's previous message is fixed.",
    '',
    'The following notes are unrealized plans, not events that have already occurred:',
    '',
    '<scene_notes>',
    SUFFIX_PLACEHOLDER,
    '</scene_notes>',
    '',
    "Write the character's next message naturally in the established voice and style. Adapt any notes that still fit and omit those that do not. Do not repeat or contradict the previous message, echo the user's reply, or reveal these notes or instructions. Begin directly with action or dialogue.]",
    '',
    MODE_PLACEHOLDER,
].join('\n');

/**
 * Minimal framing for small local models, which tend to start narrating the
 * instructions back when the preamble outweighs the scene.
 *
 * Unlike the two above, this wording has not been through live tuning.
 */
const TERSE_TEMPLATE = [
    '[Continue the roleplay.',
    '',
    'Planned, but not yet happened:',
    '',
    '<scene_notes>',
    SUFFIX_PLACEHOLDER,
    '</scene_notes>',
    '',
    "Write the character's next message, answering the user's latest reply. Keep what still fits, drop what does not. Stay in voice. Never mention these notes. Begin with action or dialogue.]",
    '',
    MODE_PLACEHOLDER,
].join('\n');

const TERSE_ADDENDA = Object.freeze({
    [REWRITE_MODES.PRESERVE]: 'Keep the notes: their lines, events, and order, changing only what the reply forces.',
    [REWRITE_MODES.ADAPTIVE]: 'React to the reply first, then work in whichever notes still fit.',
    [REWRITE_MODES.REIMAGINE]: 'Treat the notes as loose inspiration; follow the conversation instead.',
});

/**
 * Built-in presets, in the order they appear in the settings drawer.
 * `custom` is not listed here — it resolves to the user's own template.
 */
export const BUILT_IN_PRESETS = Object.freeze({
    [PROMPT_PRESETS.SCENE_NOTES]: Object.freeze({
        id: PROMPT_PRESETS.SCENE_NOTES,
        label: 'Scene notes (default)',
        template: SCENE_NOTES_TEMPLATE,
        addenda: SCENE_NOTES_ADDENDA,
    }),
    [PROMPT_PRESETS.DIRECT]: Object.freeze({
        id: PROMPT_PRESETS.DIRECT,
        label: 'Direct (shorter)',
        template: DIRECT_TEMPLATE,
        addenda: SCENE_NOTES_ADDENDA,
    }),
    [PROMPT_PRESETS.TERSE]: Object.freeze({
        id: PROMPT_PRESETS.TERSE,
        label: 'Terse (small local models)',
        template: TERSE_TEMPLATE,
        addenda: TERSE_ADDENDA,
    }),
});

/** The preset every fallback lands on. */
export const DEFAULT_PRESET = BUILT_IN_PRESETS[PROMPT_PRESETS.SCENE_NOTES];

/** @returns {{ id: string, label: string, template: string, addenda: object }} never null */
export function getPreset(id) {
    return BUILT_IN_PRESETS[id] ?? DEFAULT_PRESET;
}
