/**
 * Import-time smoke tests.
 *
 * The module tests exercise the transaction graph, but the UI modules and the
 * entry point are only ever loaded by SillyTavern itself. A broken import or a
 * module-scope reference to a missing global would not surface until the
 * extension failed to load in the browser, so load them here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeSillyTavern, uninstallFakeSillyTavern } from './helpers/fake-context.js';

beforeEach(() => {
    uninstallFakeSillyTavern();
    vi.resetModules();
    document.body.innerHTML = '';
});

const UI_MODULES = [
    '../src/ui/open.js',
    '../src/ui/modal.js',
    '../src/ui/compare.js',
    '../src/ui/overlay.js',
    '../src/ui/inline-mode.js',
    '../src/ui/message-button.js',
    '../src/ui/settings.js',
    '../src/ui/visibility.js',
    '../src/ui/commit-flow.js',
];

describe('module loading', () => {
    it.each(UI_MODULES)('loads %s without side effects', async (path) => {
        installFakeSillyTavern();
        await expect(import(path)).resolves.toBeTruthy();
    });

    it('exposes the public API after the entry point initializes', async () => {
        const { ctx } = installFakeSillyTavern();
        document.body.innerHTML = '<div id="extensions_settings2"></div><div id="chat"></div><div id="extensionsMenu"></div>';

        await import('../index.js');
        // The bootstrap polls for SillyTavern before initializing.
        await vi.waitFor(() => expect(globalThis.Intercede).toBeDefined(), { timeout: 3000 });

        expect(typeof globalThis.Intercede.open).toBe('function');
        expect(typeof globalThis.Intercede.undo).toBe('function');
        expect(typeof globalThis.Intercede.recover).toBe('function');
        expect(ctx.setExtensionPrompt).toHaveBeenCalled();
    });
});

describe('capability check', () => {
    it('names the assistant-capture event when the host cannot provide one', async () => {
        const { ctx } = installFakeSillyTavern();
        delete ctx.eventTypes.MESSAGE_RECEIVED;
        delete ctx.eventTypes.CHARACTER_MESSAGE_RENDERED;

        const { checkCapabilities } = await import('../src/stcontext.js');
        const result = checkCapabilities();

        expect(result.ok).toBe(false);
        expect(result.missing.join(' ')).toMatch(/MESSAGE_RECEIVED/);
    });

    it('passes against a complete context', async () => {
        installFakeSillyTavern();
        const { checkCapabilities } = await import('../src/stcontext.js');

        expect(checkCapabilities()).toMatchObject({ ok: true, missing: [] });
    });
});
