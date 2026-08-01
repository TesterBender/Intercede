/**
 * Floating-window selection interface (§8).
 * @see docs/RATIONALE.md#UI-03 the overlay never mutates the chat message
 */

import { BOUNDARY_TYPES } from '../constants.js';
import { el, notify } from '../utils.js';
import { findDraftBoundaryIndex, getDraft } from './commit-flow.js';
import { buildComposer, commitFromState, resolveSelectionTarget, saveDraftFromState } from './selection.js';
import { classifyBoundaries, renderInstrumented } from './visibility.js';

let overlayState = null;

export function isOverlayOpen() {
    return overlayState !== null;
}

export function closeOverlay() {
    if (!overlayState) return;
    saveDraftFromState(overlayState);
    document.removeEventListener('keydown', overlayState.onKeydown, true);
    overlayState.backdrop.remove();
    overlayState = null;
}

/**
 * Open the floating-window interface on a message (defaults to the latest).
 */
export function openOverlayMode(index = undefined) {
    const target = resolveSelectionTarget(index);
    if (!target.ok) return;

    const { raw, message, targetIndex } = target;
    let boundaries = target.boundaries;
    // @see docs/RATIONALE.md#VIS-01
    const container = renderInstrumented(raw, boundaries, message, targetIndex);
    if (container) {
        const statuses = classifyBoundaries(raw, boundaries, container);
        boundaries = boundaries.filter((_, i) => statuses[i] !== 'hidden');
    }
    if (!boundaries.length) {
        notify('warning', 'No insertion points found in the visible text of this message.');
        return;
    }
    closeOverlay();
    buildOverlay({ ...target, boundaries });
}

function buildOverlay({ settings, raw, sourceHash, boundaries, targetIndex, chatId, message }) {
    const backdrop = el('div', 'intercede-backdrop');
    const panel = el('div', 'intercede-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Intercede — choose where to respond');

    // Header
    const header = el('div', 'intercede-header');
    const title = el('div', 'intercede-title');
    title.append(
        el('i', 'fa-solid fa-reply intercede-title-icon'),
        el('span', 'intercede-title-name', 'Intercede'),
        el('span', 'intercede-title-hint', 'pick the point where your character responds'),
    );
    // Deliberately not a .menu_button. @see docs/RATIONALE.md#UI-13
    const closeButton = el('button', 'fa-solid fa-xmark intercede-close');
    closeButton.type = 'button';
    closeButton.title = 'Close (Esc)';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.addEventListener('click', closeOverlay);
    header.append(title, closeButton);

    // Body: raw text slices with boundary buttons between them.
    const body = el('div', 'intercede-body');
    const reader = el('div', 'intercede-reader');
    const sliceNodes = [];
    const boundaryNodes = [];

    let cursor = 0;
    for (let i = 0; i <= boundaries.length; i++) {
        const end = i < boundaries.length ? boundaries[i].offset : raw.length;
        let sliceText = raw.slice(cursor, end);
        // @see docs/RATIONALE.md#UI-03
        if (i > 0) sliceText = sliceText.replace(/^\s+/, '');
        const slice = el('span', 'intercede-slice', sliceText);
        if (i > 0 && boundaries[i - 1].type === BOUNDARY_TYPES.PARAGRAPH) {
            slice.classList.add('intercede-slice-block');
        }
        reader.appendChild(slice);
        sliceNodes.push(slice);

        if (i < boundaries.length) {
            const boundary = boundaries[i];
            const isParagraph = boundary.type === BOUNDARY_TYPES.PARAGRAPH;
            const button = el(
                'button',
                'intercede-boundary ' + (isParagraph ? 'intercede-boundary-paragraph' : 'intercede-boundary-sentence'),
            );
            button.type = 'button';
            button.dataset.index = String(i);
            button.title = isParagraph ? 'Respond here (paragraph break)' : 'Respond here (sentence break)';
            button.appendChild(el('span', 'intercede-boundary-label', isParagraph ? '⤷ respond here' : '⤷'));
            button.addEventListener('click', () => selectBoundary(i));
            // §8.2 — @see docs/RATIONALE.md#UI-03
            button.addEventListener('mouseenter', () => previewBoundary(i, true));
            button.addEventListener('mouseleave', () => previewBoundary(i, false));
            button.addEventListener('focus', () => previewBoundary(i, true));
            button.addEventListener('blur', () => previewBoundary(i, false));
            reader.appendChild(button);
            boundaryNodes.push(button);
        }
        cursor = end;
    }
    body.appendChild(reader);

    // Footer
    const footer = el('div', 'intercede-footer',
        'Click a marker to respond there · ↑/↓ move between markers · Enter select · Ctrl+Enter commit · Esc close');

    const onKeydown = (event) => {
        if (!overlayState) return;
        // @see docs/RATIONALE.md#UI-03 (stacked dialog owns the keyboard)
        if (document.querySelector('.intercede-modal-backdrop')) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeOverlay();
            return;
        }
        const inTextarea = event.target instanceof HTMLTextAreaElement;
        if (inTextarea && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            commitSelection();
            return;
        }
        if (!inTextarea && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            const focused = document.activeElement?.classList?.contains('intercede-boundary')
                ? Number(document.activeElement.dataset.index)
                : (overlayState.selectedIndex ?? -1);
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            const next = Math.min(boundaryNodes.length - 1, Math.max(0, (Number.isNaN(focused) ? -1 : focused) + delta));
            boundaryNodes[next]?.focus();
            boundaryNodes[next]?.scrollIntoView({ block: 'nearest' });
        }
    };
    document.addEventListener('keydown', onKeydown, true);

    panel.append(header, body, footer);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);

    overlayState = {
        backdrop, reader, sliceNodes, boundaryNodes, boundaries, raw,
        targetIndex, chatId, message, settings, onKeydown, sourceHash,
        selectedIndex: null, composer: null,
    };

    // Restore a draft from a failed/cancelled attempt on this same message.
    const draft = getDraft(overlayState);
    const draftIndex = findDraftBoundaryIndex(draft, boundaries);
    if (draftIndex !== null) {
        selectBoundary(draftIndex, draft);
    } else {
        boundaryNodes[0]?.focus();
    }
}

/** Dim the region that would be rewritten while a boundary is hovered/focused. */
function previewBoundary(index, on) {
    const state = overlayState;
    if (!state || state.selectedIndex !== null) return;
    state.sliceNodes.forEach((node, i) => node.classList.toggle('intercede-preview-cut', on && i > index));
}

function selectBoundary(index, draft = null) {
    const state = overlayState;
    if (!state) return;
    saveDraftFromState(state);
    state.composer?.remove();
    state.composer = null;
    state.selectedIndex = index;

    state.boundaryNodes.forEach((node, i) => node.classList.toggle('intercede-boundary-selected', i === index));
    state.sliceNodes.forEach((node, i) => {
        node.classList.remove('intercede-preview-cut');
        node.classList.toggle('intercede-kept', i <= index);
        node.classList.toggle('intercede-cut', i > index);
    });

    const composer = buildComposer({
        state,
        draft: draft ?? getDraft(state),
        onCommit: commitSelection,
        onCancel: () => {
            saveDraftFromState(overlayState);
            clearSelection();
        },
    });
    state.boundaryNodes[index].after(composer);
    state.composer = composer;
    const textarea = composer.querySelector('textarea');
    textarea.focus();
    composer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function clearSelection() {
    const state = overlayState;
    if (!state) return;
    state.composer?.remove();
    state.composer = null;
    state.selectedIndex = null;
    state.boundaryNodes.forEach(node => node.classList.remove('intercede-boundary-selected'));
    state.sliceNodes.forEach(node => node.classList.remove('intercede-kept', 'intercede-cut'));
}

async function commitSelection() {
    await commitFromState(overlayState, closeOverlay);
}
