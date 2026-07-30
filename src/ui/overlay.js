/**
 * Floating-window selection interface (§8): a reading overlay over the raw
 * message with clickable insertion boundaries and an inline composer. The
 * overlay never mutates the underlying chat message — all mutation happens
 * inside the transaction after an explicit commit.
 */

import { BOUNDARY_TYPES, REWRITE_MODES, REWRITE_MODE_LABELS } from '../constants.js';
import { getBoundaries } from '../segmentation.js';
import { getCtx, getCurrentChatId, getSettings } from '../stcontext.js';
import { isEligibleTarget } from '../transaction.js';
import { el, notify } from '../utils.js';
import { confirmAndCommit, getDraft, setDraft } from './commit-flow.js';

let overlayState = null;

export function isOverlayOpen() {
    return overlayState !== null;
}

export function closeOverlay() {
    if (!overlayState) return;
    saveDraftFromComposer();
    document.removeEventListener('keydown', overlayState.onKeydown, true);
    overlayState.backdrop.remove();
    overlayState = null;
}

function saveDraftFromComposer() {
    const state = overlayState;
    const textarea = state?.composer?.querySelector('textarea');
    if (!state || !textarea) return;
    setDraft(state.chatId, state.targetIndex, {
        text: textarea.value,
        mode: state.composer.querySelector('select')?.value,
        boundaryIndex: state.selectedIndex,
    });
}

/**
 * Open the floating-window interface on a message (defaults to the latest).
 */
export function openOverlayMode(index = undefined) {
    const ctx = getCtx();
    const settings = getSettings(ctx);
    const eligible = isEligibleTarget(ctx, index);
    if (!eligible.ok) {
        notify('warning', eligible.reason);
        return;
    }
    const raw = String(eligible.message.mes ?? '');
    const boundaries = getBoundaries(raw, settings.boundaries);
    if (!boundaries.length) {
        notify('warning', 'No safe insertion points were found in this message.');
        return;
    }
    closeOverlay();
    buildOverlay({ ctx, settings, raw, boundaries, targetIndex: eligible.targetIndex, message: eligible.message });
}

function buildOverlay({ ctx, settings, raw, boundaries, targetIndex, message }) {
    const chatId = getCurrentChatId(ctx);
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
    const closeButton = el('button', 'menu_button fa-solid fa-xmark intercede-close');
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
        // Display-only tidy-up: the separating whitespace is represented by the
        // boundary control itself, so drop it from the following slice's display.
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
            // §8.2 — hovering or focusing a boundary previews what would be rewritten.
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
        // A confirm/compare dialog is stacked on top — let it own the keyboard.
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
        targetIndex, chatId, message, settings, onKeydown,
        selectedIndex: null, composer: null,
    };

    // Restore a draft from a failed/cancelled attempt on this same message.
    const draft = getDraft(chatId, targetIndex);
    if (draft && Number.isInteger(draft.boundaryIndex) && draft.boundaryIndex < boundaries.length) {
        selectBoundary(draft.boundaryIndex, draft);
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
    saveDraftFromComposer();
    state.composer?.remove();
    state.composer = null;
    state.selectedIndex = index;

    state.boundaryNodes.forEach((node, i) => node.classList.toggle('intercede-boundary-selected', i === index));
    state.sliceNodes.forEach((node, i) => {
        node.classList.remove('intercede-preview-cut');
        node.classList.toggle('intercede-kept', i <= index);
        node.classList.toggle('intercede-cut', i > index);
    });

    const stored = draft ?? getDraft(state.chatId, state.targetIndex);
    const composer = buildComposer(stored);
    state.boundaryNodes[index].after(composer);
    state.composer = composer;
    const textarea = composer.querySelector('textarea');
    textarea.focus();
    composer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function buildComposer(draft) {
    const state = overlayState;
    const composer = el('div', 'intercede-composer');

    const textarea = document.createElement('textarea');
    textarea.className = 'text_pole intercede-composer-text';
    textarea.placeholder = 'Your response at this point…';
    textarea.rows = 3;
    if (draft?.text) textarea.value = draft.text;
    textarea.addEventListener('input', saveDraftFromComposer);

    const controls = el('div', 'intercede-composer-controls');

    const select = document.createElement('select');
    select.className = 'text_pole intercede-mode-select';
    for (const mode of Object.values(REWRITE_MODES)) {
        const option = document.createElement('option');
        option.value = mode;
        option.textContent = REWRITE_MODE_LABELS[mode];
        select.appendChild(option);
    }
    select.value = draft?.mode ?? state.settings.defaultMode ?? REWRITE_MODES.ADAPTIVE;

    const commitButton = el('button', 'menu_button intercede-primary', 'Intercede');
    commitButton.type = 'button';
    commitButton.title = 'Commit (Ctrl+Enter)';
    commitButton.addEventListener('click', commitSelection);

    const cancelButton = el('button', 'menu_button', 'Cancel');
    cancelButton.type = 'button';
    cancelButton.addEventListener('click', () => {
        saveDraftFromComposer();
        clearSelection();
    });

    controls.append(select, commitButton, cancelButton);
    composer.append(textarea, controls);
    composer.appendChild(el('div', 'intercede-composer-hint',
        'Everything above stays exactly as written. Everything dimmed below is rewritten around your response.'));
    return composer;
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
    const state = overlayState;
    if (!state || state.selectedIndex === null || !state.composer) return;

    const textarea = state.composer.querySelector('textarea');
    const insertionText = textarea.value.trim();
    if (!insertionText) {
        notify('warning', 'Write your response first.');
        textarea.focus();
        return;
    }
    const rewriteMode = state.composer.querySelector('select').value;
    const boundary = state.boundaries[state.selectedIndex];
    saveDraftFromComposer();

    await confirmAndCommit({
        chatId: state.chatId,
        targetIndex: state.targetIndex,
        raw: state.raw,
        boundary,
        insertionText,
        rewriteMode,
        message: state.message,
        settings: state.settings,
        closeMode: closeOverlay,
    });
}
