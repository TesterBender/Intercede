/**
 * Entry-point dispatcher for the two selection interfaces.
 * @see docs/RATIONALE.md#UI-10 activation is a toggle, and the fallback rule
 * @see docs/RATIONALE.md#CFG-03 every way in passes through here
 */

import { getSettings } from '../stcontext.js';
import { notify } from '../utils.js';
import { closeInlineMode, isInlineModeOpen, openInlineMode } from './inline-mode.js';
import { closeOverlay, isOverlayOpen, openOverlayMode } from './overlay.js';

export function closeAllModes() {
    closeOverlay();
    closeInlineMode();
}

export function openIntercede(index = undefined) {
    if (isOverlayOpen() || isInlineModeOpen()) {
        closeAllModes();
        return;
    }
    const settings = getSettings();
    // @see docs/RATIONALE.md#CFG-03 — the switch stops new intercessions here,
    // and only here, so undo and recovery keep working for existing ones.
    if (!settings.enabled) {
        notify('info', 'Intercede is switched off — enable it in the extension settings to respond inside a message.');
        return;
    }
    if (settings.selectionInterface === 'window') {
        openOverlayMode(index);
        return;
    }
    if (openInlineMode(index) === 'fallback') {
        notify('info', 'In-place mode could not attach to this message — using the floating window.');
        openOverlayMode(index);
    }
}
