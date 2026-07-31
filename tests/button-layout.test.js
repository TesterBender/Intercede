/**
 * Button width contract.
 *
 * SillyTavern styles `.menu_button` as `width: min-content`, which wraps any
 * multi-word label one word per line. The stylesheet corrects that, but only
 * for the containers it names — so a button rendered anywhere else silently
 * stacks. That is exactly how "Clean up now" shipped as three lines: the fix
 * existed, scoped to the composer, and the settings drawer was not covered.
 *
 * Rather than restate the container list here (where it would drift from the
 * stylesheet), these tests parse it out of style.css and assert that every
 * button the extension actually renders is matched by it.
 *
 * @see docs/RATIONALE.md#UI-13
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeSillyTavern, uninstallFakeSillyTavern } from './helpers/fake-context.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

/** The selector list of the rule that undoes ST's `width: min-content`. */
const COVERED = (() => {
    // Comments first: they sit directly above the rule and contain commas.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = bare.match(/([^{}]+)\{[^{}]*width:\s*auto;[^{}]*white-space:\s*nowrap;[^{}]*\}/);
    if (!rule) throw new Error('style.css no longer contains the menu_button width rule');
    return rule[1].split(',').map(selector => selector.trim()).filter(Boolean);
})();

/** Every `.menu_button` currently in the document, and whether the rule reaches it. */
function uncoveredButtons() {
    return [...document.querySelectorAll('.menu_button')]
        .filter(button => !COVERED.some(selector => button.matches(selector)))
        .map(button => `"${button.textContent.trim()}" in .${[...button.parentElement.classList].join('.')}`);
}

beforeEach(() => {
    uninstallFakeSillyTavern();
    vi.resetModules();
    document.body.innerHTML = '';
});

describe('menu_button width rule', () => {
    it('names at least the three containers that render buttons', () => {
        expect(COVERED.length).toBeGreaterThanOrEqual(3);
        for (const selector of COVERED) {
            expect(selector).toMatch(/\.menu_button$/);
        }
    });

    it('covers the settings drawer button', async () => {
        installFakeSillyTavern();
        document.body.innerHTML = '<div id="extensions_settings2"></div><div id="chat"></div>';
        const { initSettingsPanel } = await import('../src/ui/settings.js');

        initSettingsPanel();

        expect(document.querySelectorAll('.menu_button').length).toBeGreaterThan(0);
        expect(uncoveredButtons()).toEqual([]);
    });

    it('covers dialog buttons, including multi-word labels', async () => {
        const { showConfirm } = await import('../src/ui/modal.js');

        // The finalize dialog's real labels — both would stack unstyled.
        const pending = showConfirm('Finalize intercession?', 'body text', {
            confirmLabel: 'Delete snapshot',
            cancelLabel: 'Keep it',
        });

        const labels = [...document.querySelectorAll('.menu_button')].map(node => node.textContent);
        expect(labels).toEqual(['Delete snapshot', 'Keep it']);
        expect(uncoveredButtons()).toEqual([]);

        document.querySelector('.menu_button:not(.intercede-primary)').click();
        await expect(pending).resolves.toBe(false);
    });

    it('covers the composer buttons', async () => {
        installFakeSillyTavern();
        const { buildComposer } = await import('../src/ui/selection.js');

        const state = { settings: { defaultMode: 'adaptive' } };
        const composer = buildComposer({
            state,
            draft: null,
            onCommit: () => {},
            onCancel: () => {},
        });
        document.body.appendChild(composer);

        expect(document.querySelectorAll('.menu_button')).toHaveLength(2);
        expect(uncoveredButtons()).toEqual([]);
    });

    it('leaves the overlay dismiss out of it, being no menu_button at all', async () => {
        const source = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'overlay.js'), 'utf8');

        // A quiet dismiss must not regain ST's button chrome. @see UI-13
        expect(source).toMatch(/el\('button', 'fa-solid fa-xmark intercede-close'\)/);
    });
});
