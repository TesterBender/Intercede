/**
 * Prompt resolution.
 *
 * The load-bearing test here is the first one: an install that never opens the
 * Prompt section must send the *identical* instruction it sent in v0.6.0. That
 * wording is tuned — `docs/RATIONALE.md#PROMPT-01` records that earlier phrasing
 * was rejected outright by a backend filter — so "close enough" is not a pass.
 * The literal below is a transcription of the shipped v0.6.0 output, kept here
 * rather than imported so that a change to the presets cannot quietly rewrite
 * its own expectation.
 *
 * Everything after that guards one rule: an empty or unusable field means "use
 * the built-in text", never "send an empty prompt". @see docs/RATIONALE.md#CFG-04
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, REWRITE_MODES } from '../src/constants.js';
import { describeTemplateFallback, isUsableTemplate, resolvePromptConfig } from '../src/prompt-config.js';
import { buildRewritePrompt, getWrapperTag, getWrapperTags } from '../src/prompt.js';
import { BUILT_IN_PRESETS, DEFAULT_PRESET } from '../src/prompt-presets.js';
import { installFakeSillyTavern, uninstallFakeSillyTavern } from './helpers/fake-context.js';

/** Exactly what v0.6.0 emitted for `{ suffix: 'SUFFIX', mode: 'adaptive' }`. */
const V0_6_0_ADAPTIVE = `[Continue the roleplay. The character's previous message stands exactly as written, and the user has just replied to it.

Before the user's reply, the scene was headed in the direction sketched in the notes below. These notes are planning material only — nothing in them has happened in the story yet.

<scene_notes>
SUFFIX
</scene_notes>

Write the character's next message as a natural response to the user's latest reply. Where the dialogue, actions, intentions, and emotional beats from the notes still fit, carry them forward with adjusted timing and transitions; quietly drop whatever no longer fits.

Keep the character's voice and the scene's style. Do not repeat or contradict the character's previous message, and do not echo the user's reply back. Never mention these notes or instructions in the story.
Begin directly with the character's next action or spoken line.]

Balance the two: keep the notes' important moments where they fit, but let the
character react to the reply first, reordering and rephrasing freely.`;

/** Settings as a fresh install sees them, before anyone touches the drawer. */
function freshSettings(overrides = {}) {
    return { ...DEFAULT_SETTINGS, ...overrides };
}

beforeEach(() => {
    uninstallFakeSillyTavern();
});

describe('the default prompt did not move', () => {
    it('emits the v0.6.0 instruction byte for byte', () => {
        const prompt = buildRewritePrompt({
            suffix: 'SUFFIX',
            mode: REWRITE_MODES.ADAPTIVE,
            ...resolvePromptConfig(freshSettings()),
        });

        expect(prompt).toBe(V0_6_0_ADAPTIVE);
    });

    it('emits the same string with no template or addenda supplied at all', () => {
        // The two call sites spread a resolved config in, but the function has to
        // stand alone — that is what keeps it testable without a host.
        expect(buildRewritePrompt({ suffix: 'SUFFIX', mode: REWRITE_MODES.ADAPTIVE }))
            .toBe(V0_6_0_ADAPTIVE);
    });

    it.each(Object.values(REWRITE_MODES))('appends the tuned wording for %s', (mode) => {
        const prompt = buildRewritePrompt({ suffix: 'S', mode, ...resolvePromptConfig(freshSettings()) });
        expect(prompt.endsWith(DEFAULT_PRESET.addenda[mode])).toBe(true);
    });

    it('falls back to adaptive wording for an unrecognised mode', () => {
        const prompt = buildRewritePrompt({ suffix: 'S', mode: 'nonsense' });
        expect(prompt.endsWith(DEFAULT_PRESET.addenda[REWRITE_MODES.ADAPTIVE])).toBe(true);
    });
});

describe('preset selection', () => {
    it.each(Object.keys(BUILT_IN_PRESETS))('resolves the %s preset', (id) => {
        const config = resolvePromptConfig(freshSettings({ promptPreset: id }));

        expect(config.presetId).toBe(id);
        expect(config.template).toBe(BUILT_IN_PRESETS[id].template);
        expect(config.customized).toBe(false);
    });

    it('every built-in template is usable', () => {
        for (const preset of Object.values(BUILT_IN_PRESETS)) {
            expect(isUsableTemplate(preset.template), preset.id).toBe(true);
        }
    });

    it('resolves an unknown preset to the default rather than failing', () => {
        // A preset id retired in some later version must not brick the extension
        // for anyone whose settings still name it.
        const config = resolvePromptConfig(freshSettings({ promptPreset: 'preset-from-the-future' }));

        expect(config.presetId).toBe(DEFAULT_PRESET.id);
        expect(config.template).toBe(DEFAULT_PRESET.template);
    });

    it('survives settings that are missing entirely', () => {
        const config = resolvePromptConfig({});
        expect(config.template).toBe(DEFAULT_PRESET.template);
    });
});

describe('an empty field means the default, never an empty prompt', () => {
    it('uses the default template when a custom one is blank', () => {
        const config = resolvePromptConfig(freshSettings({
            promptPreset: 'custom',
            promptTemplate: '   \n  ',
        }));

        expect(config.template).toBe(DEFAULT_PRESET.template);
        expect(config.usingCustom).toBe(false);
        expect(config.fallback).toBe('empty');
    });

    it('refuses a custom template with no suffix marker', () => {
        const settings = freshSettings({
            promptPreset: 'custom',
            promptTemplate: 'Just keep writing the scene.',
        });

        // Honouring it would drop the set-aside continuation silently — the whole
        // point of the generation.
        expect(describeTemplateFallback(settings)).toBe('missing-suffix');
        expect(resolvePromptConfig(settings).template).toBe(DEFAULT_PRESET.template);
    });

    it('uses a custom template that does carry the marker', () => {
        const config = resolvePromptConfig(freshSettings({
            promptPreset: 'custom',
            promptTemplate: '<plan>\n{{suffix}}\n</plan>',
        }));

        expect(config.usingCustom).toBe(true);
        expect(config.customized).toBe(true);
        expect(config.fallback).toBe(null);
    });

    it('overlays only the mode fields that were actually filled in', () => {
        const config = resolvePromptConfig(freshSettings({ promptModePreserve: 'Word for word.' }));

        expect(config.addenda[REWRITE_MODES.PRESERVE]).toBe('Word for word.');
        expect(config.addenda[REWRITE_MODES.ADAPTIVE]).toBe(DEFAULT_PRESET.addenda[REWRITE_MODES.ADAPTIVE]);
        expect(config.customized).toBe(true);
    });

    it('ignores a whitespace-only mode override', () => {
        const config = resolvePromptConfig(freshSettings({ promptModeAdaptive: '   ' }));

        expect(config.addenda[REWRITE_MODES.ADAPTIVE]).toBe(DEFAULT_PRESET.addenda[REWRITE_MODES.ADAPTIVE]);
        expect(config.customized).toBe(false);
    });
});

describe('placeholder handling', () => {
    it('places the mode wording where {{mode}} appears', () => {
        const prompt = buildRewritePrompt({
            suffix: 'S',
            mode: REWRITE_MODES.PRESERVE,
            template: 'Head\n{{mode}}\n<n>{{suffix}}</n>\nTail',
            addenda: { [REWRITE_MODES.PRESERVE]: 'MODE' },
        });

        expect(prompt).toBe('Head\nMODE\n<n>S</n>\nTail');
    });

    it('appends the mode wording exactly once when {{mode}} is absent', () => {
        const prompt = buildRewritePrompt({
            suffix: 'S',
            mode: REWRITE_MODES.PRESERVE,
            template: '<n>{{suffix}}</n>',
            addenda: { [REWRITE_MODES.PRESERVE]: 'MODE' },
        });

        expect(prompt).toBe('<n>S</n>\n\nMODE');
        expect(prompt.match(/MODE/g)).toHaveLength(1);
    });

    it('appends once even when the suffix itself contains {{mode}}', () => {
        // Whether to append is decided from the template. Reading it back off the
        // assembled body would let the suffix suppress the append, or double it.
        const prompt = buildRewritePrompt({
            suffix: 'talking about {{mode}} here',
            mode: REWRITE_MODES.PRESERVE,
            template: '<n>{{suffix}}</n>',
            addenda: { [REWRITE_MODES.PRESERVE]: 'MODE' },
        });

        expect(prompt).toBe('<n>talking about {{mode}} here</n>\n\nMODE');
        expect(prompt.match(/MODE/g)).toHaveLength(1);
    });

    it('substitutes every occurrence of the suffix marker', () => {
        const prompt = buildRewritePrompt({
            suffix: 'S',
            mode: REWRITE_MODES.ADAPTIVE,
            template: '<n>{{suffix}}</n> and again <n>{{suffix}}</n>',
            addenda: { [REWRITE_MODES.ADAPTIVE]: '' },
        });

        expect(prompt).toBe('<n>S</n> and again <n>S</n>\n\n');
    });

    it('treats a suffix containing $& as literal text', () => {
        // `String.replace` would expand this into the matched substring; a chat
        // message is exactly the kind of text that contains one by accident.
        const prompt = buildRewritePrompt({
            suffix: "he wrote $& and $' on the board",
            mode: REWRITE_MODES.ADAPTIVE,
        });

        expect(prompt).toContain("he wrote $& and $' on the board");
    });
});

/**
 * Regression: the assembled body used to be searched for `{{mode}}` *after* the
 * suffix was joined into it, so a continuation containing that literal text had
 * the mode wording spliced into the middle of a sentence. Reported live against
 * "Here is {{mode}}. My Trap Card!".
 *
 * The rule these pin: placeholder resolution applies only to text the template
 * author wrote. @see docs/RATIONALE.md#PROMPT-03
 */
describe('substituted values are data, not template source', () => {
    it('leaves a literal {{mode}} in the suffix exactly where it was', () => {
        const prompt = buildRewritePrompt({
            suffix: 'Here is {{mode}}. My Trap Card!',
            mode: REWRITE_MODES.ADAPTIVE,
            template: '<scene_notes>\n{{suffix}}\n</scene_notes>\n{{mode}}',
            addenda: { [REWRITE_MODES.ADAPTIVE]: 'MODE WORDING' },
        });

        expect(prompt).toBe(
            '<scene_notes>\nHere is {{mode}}. My Trap Card!\n</scene_notes>\nMODE WORDING',
        );
        // Exactly one, and it came from the template's marker — not the suffix's.
        expect(prompt.match(/MODE WORDING/g)).toHaveLength(1);
    });

    it('keeps every placeholder-looking sequence in the suffix literal', () => {
        const suffix = "markers {{mode}} and {{suffix}}, patterns $& and $', all literal";
        const prompt = buildRewritePrompt({
            suffix,
            mode: REWRITE_MODES.ADAPTIVE,
            template: '<scene_notes>\n{{suffix}}\n</scene_notes>\n{{mode}}',
            addenda: { [REWRITE_MODES.ADAPTIVE]: 'MODE WORDING' },
        });

        expect(prompt).toContain(suffix);
        for (const sequence of ['{{mode}}', '{{suffix}}', '$&', "$'"]) {
            expect(prompt, sequence).toContain(sequence);
        }
        expect(prompt.match(/MODE WORDING/g)).toHaveLength(1);
    });

    it('does not rescan the addendum it just inserted', () => {
        // `join()` never revisits what it inserts; this pins that it stays that way.
        const prompt = buildRewritePrompt({
            suffix: 'PLAIN',
            mode: REWRITE_MODES.ADAPTIVE,
            template: '<scene_notes>\n{{suffix}}\n</scene_notes>\n{{mode}}',
            addenda: { [REWRITE_MODES.ADAPTIVE]: "see {{mode}} and {{suffix}}, plus $& and $'" },
        });

        expect(prompt).toBe(
            "<scene_notes>\nPLAIN\n</scene_notes>\nsee {{mode}} and {{suffix}}, plus $& and $'",
        );
    });

    it('resolves template markers on both sides of the suffix', () => {
        const prompt = buildRewritePrompt({
            suffix: 'and {{mode}} stays put',
            mode: REWRITE_MODES.ADAPTIVE,
            template: '{{mode}}\n<n>{{suffix}}</n>\n{{mode}}',
            addenda: { [REWRITE_MODES.ADAPTIVE]: 'W' },
        });

        expect(prompt).toBe('W\n<n>and {{mode}} stays put</n>\nW');
    });
});

describe('the container the suffix cannot close', () => {
    it('reads the wrapper tag out of the active template', () => {
        expect(getWrapperTag(DEFAULT_PRESET.template)).toBe('scene_notes');
        expect(getWrapperTag('<story_plan>\n{{suffix}}\n</story_plan>')).toBe('story_plan');
        expect(getWrapperTag('no placeholder here')).toBe(null);
        expect(getWrapperTag('bare {{suffix}}')).toBe(null);
    });

    it('collects a container for every marker, deduplicated case-insensitively', () => {
        expect(getWrapperTags(DEFAULT_PRESET.template)).toEqual(['scene_notes']);
        expect(getWrapperTags('<first>{{suffix}}</first>\n<second>{{suffix}}</second>'))
            .toEqual(['first', 'second']);
        expect(getWrapperTags('<Notes>{{suffix}}</Notes>\n<notes>{{suffix}}</notes>'))
            .toEqual(['Notes']);
        // A marker with no container contributes nothing, but must not hide later ones.
        expect(getWrapperTags('bare {{suffix}} then <n>{{suffix}}</n>')).toEqual(['n']);
        expect(getWrapperTags('nothing here')).toEqual([]);
    });

    it('defangs every container the template opened, not only the first', () => {
        const prompt = buildRewritePrompt({
            suffix: 'closes </first> and </second> both',
            mode: REWRITE_MODES.ADAPTIVE,
            template: '<first>{{suffix}}</first>\n<second>{{suffix}}</second>',
            addenda: { [REWRITE_MODES.ADAPTIVE]: '' },
        });

        expect(prompt).toContain('closes </first > and </second > both');
        expect(prompt).not.toContain('closes </first> and </second> both');
        // Each genuine closing tag, supplied by the template, survives exactly once.
        expect(prompt.match(/<\/first>/g)).toHaveLength(1);
        expect(prompt.match(/<\/second>/g)).toHaveLength(1);
    });

    it('defangs the default container exactly as v0.6.0 did', () => {
        const prompt = buildRewritePrompt({
            suffix: 'text </scene_notes> more',
            mode: REWRITE_MODES.ADAPTIVE,
        });

        expect(prompt).toContain('text </scene notes> more');
        expect(prompt.match(/<\/scene_notes>/g)).toHaveLength(1); // only the real one
    });

    it('defangs a custom container too', () => {
        const prompt = buildRewritePrompt({
            suffix: 'text </story_plan> more',
            mode: REWRITE_MODES.ADAPTIVE,
            template: '<story_plan>\n{{suffix}}\n</story_plan>',
            addenda: { [REWRITE_MODES.ADAPTIVE]: '' },
        });

        expect(prompt).toContain('text </story plan> more');
        expect(prompt.match(/<\/story_plan>/g)).toHaveLength(1);
    });

    it('still defangs the default container under a custom template', () => {
        // A suffix can predate a template change; the old container costs nothing
        // to keep defending.
        const prompt = buildRewritePrompt({
            suffix: 'text </scene_notes> more',
            mode: REWRITE_MODES.ADAPTIVE,
            template: '<plan>\n{{suffix}}\n</plan>',
            addenda: { [REWRITE_MODES.ADAPTIVE]: '' },
        });

        expect(prompt).not.toContain('text </scene_notes> more');
    });

    it('breaks a single-word container that has no underscore to spend', () => {
        const prompt = buildRewritePrompt({
            suffix: 'text </planning> more',
            mode: REWRITE_MODES.ADAPTIVE,
            template: '<planning>\n{{suffix}}\n</planning>',
            addenda: { [REWRITE_MODES.ADAPTIVE]: '' },
        });

        expect(prompt).toContain('text </planning > more');
        expect(prompt.match(/<\/planning>/g)).toHaveLength(1);
    });
});

describe('resolution against live settings', () => {
    it('reads the host settings when none are passed', () => {
        installFakeSillyTavern();
        const config = resolvePromptConfig();

        expect(config.presetId).toBe(DEFAULT_PRESET.id);
        expect(config.wrapperTag).toBe('scene_notes');
    });
});
