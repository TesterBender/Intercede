/**
 * Entry-point dispatcher for the two selection interfaces.
 * @see docs/RATIONALE.md#UI-10 activation is a toggle, and the fallback rule
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
