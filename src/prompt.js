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
 * @see docs/RATIONALE.md#PROMPT-02 why the texts live in prompt-presets.js
 * @see docs/RATIONALE.md#PROMPT-03 why nothing substituted in is ever rescanned
 */

import { REWRITE_MODES } from './constants.js';
import { DEFAULT_PRESET, MODE_PLACEHOLDER, SUFFIX_PLACEHOLDER } from './prompt-presets.js';

/** The opening tag immediately before a position, whitespace apart. */
const OPENING_TAG_BEFORE = /<\s*([a-z][\w:-]*)[^>]*>\s*$/i;

/**
 * Every distinct container wrapping a suffix marker, in order, deduplicated
 * case-insensitively.
 * @see docs/RATIONALE.md#PROMPT-03 why all of them, not just the first
 */
export function getWrapperTags(template) {
    const source = String(template ?? '');
    const tags = [];
    const seen = new Set();
    let index = source.indexOf(SUFFIX_PLACEHOLDER);
    while (index >= 0) {
        const match = OPENING_TAG_BEFORE.exec(source.slice(0, index));
        const key = match?.[1].toLowerCase();
        if (key && !seen.has(key)) {
            seen.add(key);
            tags.push(match[1]);
        }
        index = source.indexOf(SUFFIX_PLACEHOLDER, index + SUFFIX_PLACEHOLDER.length);
    }
    return tags;
}

/** The first such container, or null — for the callers that report only one. */
export function getWrapperTag(template) {
    return getWrapperTags(template)[0] ?? null;
}

/**
 * A closing tag the model will not read as closing the container we opened.
 * `scene_notes` keeps its historical `</scene notes>` form exactly.
 */
function defangedForm(tag) {
    const spaced = tag.replace(/_/g, ' ');
    return spaced === tag ? `</${tag} >` : `</${spaced}>`;
}

/**
 * Defang anything in the suffix that would close one of our containers early.
 * The only alteration made to suffix text, and the only `replace` on this path.
 * @see docs/RATIONALE.md#PROMPT-03 why its replacement must stay `$`-free
 */
function sanitizeSuffix(suffix, wrapperTags = []) {
    let text = String(suffix ?? '');
    // `scene_notes` is defanged even under a custom template: the suffix may predate it.
    const tags = new Set(['scene_notes']);
    for (const tag of wrapperTags) {
        if (typeof tag === 'string' && tag.trim()) tags.add(tag.toLowerCase());
    }
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
    // A template that lost its placeholder would silently drop the suffix.
    // @see docs/RATIONALE.md#PROMPT-02
    const activeTemplate = typeof template === 'string' && template.includes(SUFFIX_PLACEHOLDER)
        ? template
        : DEFAULT_PRESET.template;
    const activeAddenda = addenda ?? DEFAULT_PRESET.addenda;
    const addendum = activeAddenda[mode]
        ?? activeAddenda[REWRITE_MODES.ADAPTIVE]
        ?? DEFAULT_PRESET.addenda[REWRITE_MODES.ADAPTIVE];

    // Resolved within template fragments, never across the assembled string, and
    // decided from the template rather than from the result.
    // @see docs/RATIONALE.md#PROMPT-03 — substituted values are data, not source
    const hasModePlaceholder = activeTemplate.includes(MODE_PLACEHOLDER);
    const safeSuffix = sanitizeSuffix(suffix, getWrapperTags(activeTemplate));

    const body = activeTemplate
        .split(SUFFIX_PLACEHOLDER)
        .map(fragment => fragment.split(MODE_PLACEHOLDER).join(addendum))
        .join(safeSuffix);

    return hasModePlaceholder ? body : `${body}\n\n${addendum}`;
}
