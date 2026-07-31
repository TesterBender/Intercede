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

        for (const [id] of [...CHECKBOXES, ...SELECTS]) {
            expect(document.getElementById(id), id).toBeTruthy();
        }
        expect(document.getElementById('intercede_snapshot_ttl')).toBeTruthy();
        expect(document.getElementById('intercede_cleanup_now')).toBeTruthy();
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

describe('settings panel layout contract', () => {
    it('groups the controls into headed sections', async () => {
        await mountPanel();

        const sections = document.querySelectorAll('.intercede-settings-section');
        expect(sections).toHaveLength(3);
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
