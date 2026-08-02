/**
 * Resolves the active rewrite instruction from settings.
 *
 * The one rule everything here follows: **an empty field means "use the built-in
 * text", never "send an empty prompt"**. A user who clears a textarea has said
 * "go back to the default", and a template that cannot work is not used at all.
 *
 * @see docs/RATIONALE.md#PROMPT-02 why resolution lives here and not in prompt.js
 * @see docs/RATIONALE.md#CFG-04 the flat keys and the empty-string rule
 */

import { PROMPT_PRESETS, REWRITE_MODES } from './constants.js';
import { getWrapperTag } from './prompt.js';
import { BUILT_IN_PRESETS, DEFAULT_PRESET, getPreset, SUFFIX_PLACEHOLDER } from './prompt-presets.js';
import { getSettings } from './stcontext.js';

/** Settings key holding the override for each mode. @see docs/RATIONALE.md#CFG-04 */
export const MODE_SETTING_KEYS = Object.freeze({
    [REWRITE_MODES.PRESERVE]: 'promptModePreserve',
    [REWRITE_MODES.ADAPTIVE]: 'promptModeAdaptive',
    [REWRITE_MODES.REIMAGINE]: 'promptModeReimagine',
});

function isBlank(value) {
    return typeof value !== 'string' || value.trim() === '';
}

/** A template is usable only if it says where the suffix goes. */
export function isUsableTemplate(template) {
    return !isBlank(template) && template.includes(SUFFIX_PLACEHOLDER);
}

/**
 * Why a custom template was not used, or null when none was requested or it was fine.
 * The settings panel turns this into the warning shown above the preview.
 */
export function describeTemplateFallback(settings) {
    if (settings?.promptPreset !== PROMPT_PRESETS.CUSTOM) return null;
    const custom = settings?.promptTemplate;
    if (isBlank(custom)) return 'empty';
    return custom.includes(SUFFIX_PLACEHOLDER) ? null : 'missing-suffix';
}

/**
 * @param {object} [settings] defaults to the live extension settings
 * @returns {{
 *   template: string, addenda: object, wrapperTag: string|null,
 *   presetId: string, usingCustom: boolean, customized: boolean, fallback: string|null
 * }}
 */
export function resolvePromptConfig(settings = getSettings()) {
    const requested = settings?.promptPreset;
    // An unknown id — a preset removed in a later version, say — is not a reason
    // to fail; it resolves to the default the same as a fresh install would.
    const known = requested === PROMPT_PRESETS.CUSTOM
        || Object.hasOwn(BUILT_IN_PRESETS, String(requested));
    const presetId = known ? requested : DEFAULT_PRESET.id;
    const preset = getPreset(presetId);

    const fallback = describeTemplateFallback(settings);
    const usingCustom = presetId === PROMPT_PRESETS.CUSTOM && fallback === null;
    const template = usingCustom ? settings.promptTemplate : preset.template;

    const addenda = {};
    let addendaOverridden = false;
    for (const mode of Object.values(REWRITE_MODES)) {
        const override = settings?.[MODE_SETTING_KEYS[mode]];
        if (isBlank(override)) {
            addenda[mode] = preset.addenda[mode];
        } else {
            addenda[mode] = override;
            addendaOverridden = true;
        }
    }

    return {
        template,
        addenda,
        wrapperTag: getWrapperTag(template),
        presetId,
        usingCustom,
        customized: usingCustom || addendaOverridden,
        fallback,
    };
}
