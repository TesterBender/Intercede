/**
 * Settings-panel wiring.
 *
 * The panel is a template string bound afterwards by element id
 * (`initSettingsPanel`'s `byId`), so restructuring the markup for layout fails
 * *silently*: the drawer still renders, and one control simply stops saving.
 * These tests pin the contract between the markup and the code that binds it —
 * and between the markup and the stylesheet, since the width and alignment
 * rules are keyed on wrapper classes that a future edit could drop.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeSillyTavern, uninstallFakeSillyTavern } from './helpers/fake-context.js';

/** Every id `initSettingsPanel` binds, with the settings key it writes. */
const CHECKBOXES = [
    ['intercede_enabled', 'enabled'],
    ['intercede_show_button', 'showButton'],
    ['intercede_confirm', 'confirmBeforeCommit'],
    ['intercede_compare_after', 'compareAfterCommit'],
    ['intercede_warn_extensions', 'warnExtensions'],
];

const SELECTS = [
    ['intercede_interface', 'selectionInterface', 'window'],
    ['intercede_boundaries', 'boundaries', 'paragraph'],
    ['intercede_default_mode', 'defaultMode', 'preserve'],
    ['intercede_prompt_preset', 'promptPreset', 'direct'],
];

/** The prompt fields, which are free text rather than a fixed set of values. */
const TEXTAREAS = [
    ['intercede_prompt_template', 'promptTemplate'],
    ['intercede_prompt_mode_preserve', 'promptModePreserve'],
    ['intercede_prompt_mode_adaptive', 'promptModeAdaptive'],
    ['intercede_prompt_mode_reimagine', 'promptModeReimagine'],
];

async function mountPanel() {
    uninstallFakeSillyTavern();
    vi.resetModules();
    document.body.innerHTML = '<div id="extensions_settings2"></div><div id="chat"></div>';
    globalThis.toastr = { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() };

    const { ctx } = installFakeSillyTavern();
    const { initSettingsPanel } = await import('../src/ui/settings.js');
    const { getSettings } = await import('../src/stcontext.js');
    initSettingsPanel();
    return { ctx, getSettings };
}

beforeEach(() => {
    uninstallFakeSillyTavern();
    document.body.innerHTML = '';
    delete globalThis.toastr;
});

describe('settings panel bindings', () => {
    it('renders every element the panel binds by id', async () => {
        await mountPanel();

        for (const [id] of [...CHECKBOXES, ...SELECTS, ...TEXTAREAS]) {
            expect(document.getElementById(id), id).toBeTruthy();
        }
        expect(document.getElementById('intercede_snapshot_ttl')).toBeTruthy();
        expect(document.getElementById('intercede_cleanup_now')).toBeTruthy();
        expect(document.getElementById('intercede_prompt_preview')).toBeTruthy();
        expect(document.getElementById('intercede_prompt_reset')).toBeTruthy();
    });

    it('points every checkbox label at an input that exists', async () => {
        await mountPanel();

        const labels = [...document.querySelectorAll('.intercede-settings label.checkbox_label[for]')];
        expect(labels).toHaveLength(CHECKBOXES.length);
        for (const label of labels) {
            const target = document.getElementById(label.htmlFor);
            expect(target, label.htmlFor).toBeTruthy();
            // The label must actually wrap its input, which is what makes the
            // whole row clickable rather than just the box.
            expect(label.contains(target), label.htmlFor).toBe(true);
        }
    });

    it.each(CHECKBOXES)('writes %s through to settings.%s', async (id, key) => {
        const { getSettings } = await mountPanel();
        const input = document.getElementById(id);
        const before = Boolean(getSettings()[key]);

        input.checked = !before;
        input.dispatchEvent(new Event('change'));

        expect(getSettings()[key]).toBe(!before);
    });

    it.each(SELECTS)('writes %s through to settings.%s', async (id, key, value) => {
        const { getSettings } = await mountPanel();
        const select = document.getElementById(id);

        select.value = value;
        select.dispatchEvent(new Event('change'));

        expect(getSettings()[key]).toBe(value);
    });

    it.each(TEXTAREAS)('writes %s through to settings.%s', async (id, key) => {
        const { getSettings } = await mountPanel();
        const area = document.getElementById(id);

        area.value = 'Keep it short.';
        area.dispatchEvent(new Event('change'));

        expect(getSettings()[key]).toBe('Keep it short.');
    });

    it('clamps a negative snapshot age to zero', async () => {
        const { getSettings } = await mountPanel();
        const ttl = document.getElementById('intercede_snapshot_ttl');

        ttl.value = '-5';
        ttl.dispatchEvent(new Event('change'));

        expect(getSettings().snapshotTtlDays).toBe(0);
        expect(ttl.value).toBe('0');
    });

    it('still runs cleanup when the button is clicked', async () => {
        await mountPanel();

        document.getElementById('intercede_cleanup_now').click();

        await vi.waitFor(() => expect(globalThis.toastr.info).toHaveBeenCalled());
        // Default TTL is 0 — cleanup reports the stored count rather than deleting.
        expect(globalThis.toastr.info.mock.calls[0][0]).toMatch(/keep forever/);
    });
});

/**
 * The prompt section is the one place in the drawer where a control can be
 * *bound correctly* and still be wrong: a preset the select cannot display, or
 * a preview that stops tracking the fields it is supposed to explain.
 */
describe('prompt section', () => {
    const selectPreset = (value) => {
        const select = document.getElementById('intercede_prompt_preset');
        select.value = value;
        select.dispatchEvent(new Event('change'));
        return select;
    };

    it('offers an option for every preset, so a stored value can round-trip', async () => {
        const { getSettings } = await mountPanel();
        const values = [...document.getElementById('intercede_prompt_preset').options].map(o => o.value);

        expect(values).toEqual(['scene-notes', 'direct', 'terse', 'custom']);
        // A select silently drops a value it has no option for; that would show
        // a customised install as though it sat on the default.
        expect(values).toContain(getSettings().promptPreset);
    });

    it('reveals the template box only for the custom preset', async () => {
        await mountPanel();
        const box = document.getElementById('intercede_prompt_custom');

        expect(box.hidden).toBe(true);
        selectPreset('custom');
        expect(box.hidden).toBe(false);
        selectPreset('direct');
        expect(box.hidden).toBe(true);
    });

    it('shows the default wording as a placeholder, never as a value', async () => {
        await mountPanel();
        const area = document.getElementById('intercede_prompt_mode_adaptive');

        // Storing the default as a value would freeze it: a later release could
        // not improve the wording for anyone who had opened the drawer once.
        expect(area.value).toBe('');
        expect(area.placeholder).toContain('Balance the two');
    });

    it('renders a preview that resolves the placeholders', async () => {
        await mountPanel();
        const preview = document.getElementById('intercede_prompt_preview').textContent;

        expect(preview).not.toContain('{{suffix}}');
        expect(preview).not.toContain('{{mode}}');
        expect(preview).toContain('<scene_notes>');
    });

    it('warns, and falls back, when a custom template loses its suffix marker', async () => {
        await mountPanel();
        selectPreset('custom');

        const area = document.getElementById('intercede_prompt_template');
        area.value = 'Continue the scene however you like.';
        area.dispatchEvent(new Event('change'));

        const warning = document.getElementById('intercede_prompt_warning');
        expect(warning.hidden).toBe(false);
        expect(warning.textContent).toMatch(/\{\{suffix\}\}/);
        // The preview must show what will actually be sent — the default.
        expect(document.getElementById('intercede_prompt_preview').textContent)
            .toContain('<scene_notes>');
    });

    it('tracks a usable custom template in the preview, with no warning', async () => {
        await mountPanel();
        selectPreset('custom');

        const area = document.getElementById('intercede_prompt_template');
        area.value = 'Notes:\n<plan>\n{{suffix}}\n</plan>\nContinue.';
        area.dispatchEvent(new Event('change'));

        expect(document.getElementById('intercede_prompt_warning').hidden).toBe(true);
        const preview = document.getElementById('intercede_prompt_preview').textContent;
        expect(preview).toContain('<plan>');
        expect(preview).not.toContain('<scene_notes>');
    });

    it('clears every prompt field when reset, and says so', async () => {
        const { getSettings } = await mountPanel();
        selectPreset('custom');
        const area = document.getElementById('intercede_prompt_mode_preserve');
        area.value = 'Verbatim, please.';
        area.dispatchEvent(new Event('change'));

        document.getElementById('intercede_prompt_reset').click();

        expect(getSettings().promptPreset).toBe('scene-notes');
        expect(getSettings().promptModePreserve).toBe('');
        expect(area.value).toBe('');
        expect(document.getElementById('intercede_prompt_preset').value).toBe('scene-notes');
        expect(document.getElementById('intercede_prompt_custom').hidden).toBe(true);
        expect(globalThis.toastr.info).toHaveBeenCalled();
    });
});

describe('settings panel layout contract', () => {
    it('groups the controls into headed sections', async () => {
        await mountPanel();

        const sections = document.querySelectorAll('.intercede-settings-section');
        expect(sections).toHaveLength(4);
        for (const section of sections) {
            expect(section.querySelector('.intercede-settings-heading')).toBeTruthy();
        }
    });

    it('keeps the day field in the row the width rule targets', async () => {
        await mountPanel();
        const ttl = document.getElementById('intercede_snapshot_ttl');

        // `.intercede-settings-row input[type="number"]` is what stops ST's
        // full-width .text_pole from spanning the drawer for a 1-4 digit value.
        expect(ttl.closest('.intercede-settings-row')).toBeTruthy();
        expect(ttl.getAttribute('type')).toBe('number');
    });

    it('keeps the button in the action row that aligns it', async () => {
        await mountPanel();
        const button = document.getElementById('intercede_cleanup_now');

        expect(button.closest('.intercede-settings-actions')).toBeTruthy();
    });
});
