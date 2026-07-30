/**
 * Entry-point dispatcher for the two selection interfaces.
 *
 * Invoking Intercede (wand menu, message button, Alt+I, /intercede) while a
 * mode is already open closes it and restores the message — activation is a
 * toggle. Otherwise the interface chosen in settings opens; if in-place mode
 * cannot attach to the message (formatting pipeline destroyed its markers),
 * the floating window opens instead.
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
    if (settings.selectionInterface === 'window') {
        openOverlayMode(index);
        return;
    }
    if (openInlineMode(index) === 'fallback') {
        notify('info', 'In-place mode could not attach to this message — using the floating window.');
        openOverlayMode(index);
    }
}
