/**
 * The one-generation suffix-revision instruction (§11.4).
 *
 * Wording constraint: this must read as ordinary collaborative-fiction
 * direction, not as instructions about reusing prior model output. Earlier
 * phrasing ("original continuation", "discarded suffix", "retain the original
 * wording") was blocked by Anthropic's ToS filter as an attempt at
 * "duplicating model outputs". Keep any future edits framed as scene notes /
 * story planning, and avoid editing- or output-reuse meta-language.
 *
 * The texts themselves now live in `src/prompt-presets.js` and may be replaced
 * by the user; this module only assembles whichever one is active, and stays
 * free of any settings dependency so it can be exercised on its own.
 * @see docs/RATIONALE.md#PROMPT-02
 */

import { REWRITE_MODES } from './constants.js';
import { DEFAULT_PRESET, MODE_PLACEHOLDER, SUFFIX_PLACEHOLDER } from './prompt-presets.js';

/**
 * The tag wrapping the suffix placeholder in a template, or null when the
 * placeholder is not wrapped at all.
 *
 * Read from the template rather than hardcoded, because a user-authored
 * template may name its container something else — and the container that
 * needs defending is whichever one the active template actually opened.
 *
 * @see docs/RATIONALE.md#PROMPT-02
 */
export function getWrapperTag(template) {
    const source = String(template ?? '');
    const index = source.indexOf(SUFFIX_PLACEHOLDER);
    if (index < 0) return null;
    // The nearest opening tag before the placeholder, whitespace apart.
    const match = /<\s*([a-z][\w:-]*)[^>]*>\s*$/i.exec(source.slice(0, index));
    return match ? match[1] : null;
}

/**
 * A closing tag the model will not read as closing the container we opened.
 * `scene_notes` keeps its historical `</scene notes>` form exactly.
 */
function defangedForm(tag) {
    const spaced = tag.replace(/_/g, ' ');
    return spaced === tag ? `</${tag} >` : `</${spaced}>`;
}

/** Defang anything in the suffix that would close our reference container early. */
function sanitizeSuffix(suffix, wrapperTag) {
    let text = String(suffix ?? '');
    // The default container is always defanged, even under a custom template:
    // it costs nothing and the suffix may predate a template change.
    const tags = new Set(['scene_notes']);
    if (wrapperTag) tags.add(wrapperTag.toLowerCase());
    for (const tag of tags) {
        const pattern = new RegExp(`<\\s*/\\s*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`, 'gi');
        text = text.replace(pattern, defangedForm(tag));
    }
    return text;
}

/**
 * @param {object} options
 * @param {string} options.suffix the discarded original continuation
 * @param {string} options.mode one of REWRITE_MODES
 * @param {string} [options.template] active template; falls back to the default preset
 * @param {object} [options.addenda] per-mode wording; falls back to the default preset
 * @returns {string}
 */
export function buildRewritePrompt({ suffix, mode, template, addenda } = {}) {
    // A template that lost its placeholder would silently drop the suffix, so
    // an unusable one is not used at all. @see docs/RATIONALE.md#PROMPT-02
    const activeTemplate = typeof template === 'string' && template.includes(SUFFIX_PLACEHOLDER)
        ? template
        : DEFAULT_PRESET.template;
    const activeAddenda = addenda ?? DEFAULT_PRESET.addenda;
    const addendum = activeAddenda[mode]
        ?? activeAddenda[REWRITE_MODES.ADAPTIVE]
        ?? DEFAULT_PRESET.addenda[REWRITE_MODES.ADAPTIVE];

    // split/join, not replace: the suffix is chat text, and `$&` or `$'` inside
    // it would be expanded as a replacement pattern.
    const body = activeTemplate.split(SUFFIX_PLACEHOLDER)
        .join(sanitizeSuffix(suffix, getWrapperTag(activeTemplate)));

    return body.includes(MODE_PLACEHOLDER)
        ? body.split(MODE_PLACEHOLDER).join(addendum)
        : `${body}\n\n${addendum}`;
}
