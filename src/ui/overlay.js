/**
 * Intercession mode (§8): a reading overlay over the raw message with clickable
 * insertion boundaries and an inline composer. The overlay never mutates the
 * underlying chat message — all mutation happens inside the transaction after
 * an explicit commit.
 */

import { createAnchor } from '../anchors.js';
import { BOUNDARY_TYPES, REWRITE_MODES, REWRITE_MODE_LABELS } from '../constants.js';
import { getBoundaries, splitAtOffset } from '../segmentation.js';
import { getCtx, getCurrentChatId, getSettings } from '../stcontext.js';
import { IntercedeTransaction, isEligibleTarget } from '../transaction.js';
import { el, notify, truncate } from '../utils.js';
import { showCompare } from './compare.js';
import { showConfirm } from './modal.js';

/** Drafts survive a failed or cancelled intercession so the user can retry (§18). */
const drafts = new Map();

function draftKey(chatId, targetIndex) {
    return `${chatId}::${targetIndex}`;
}

let overlayState = null;

const KNOWN_MESSAGE_KEYS = new Set([
    'name', 'is_user', 'is_system', 'is_name', 'send_date', 'mes', 'extra',
    'swipe_id', 'swipes', 'swipe_info', 'gen_started', 'gen_finished',
    'force_avatar', 'original_avatar', 'title', 'variables',
]);

/** Best-effort detection of another extension's continuation/branch metadata (§16.4). */
function detectForeignContinuationData(message) {
    const suspicious = [];
    for (const key of Object.keys(message ?? {})) {
        if (!KNOWN_MESSAGE_KEYS.has(key) && /continu|branch|tree/i.test(key)) suspicious.push(key);
    }
    for (const key of Object.keys(message?.extra ?? {})) {
        if (/continu|branch|tree/i.test(key)) suspicious.push(`extra.${key}`);
    }
    return suspicious;
}

const MEMORY_EXTENSION_KEYS = ['memory', 'vectors', 'vectors_enhanced', 'smart_memory', 'qvink_memory'];

function detectMemoryExtensions(ctx) {
    const store = ctx?.extensionSettings ?? ctx?.extension_settings ?? {};
    return MEMORY_EXTENSION_KEYS.filter(key => store[key] && typeof store[key] === 'object');
}

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
    const key = draftKey(state.chatId, state.targetIndex);
    const text = textarea.value;
    const mode = state.composer.querySelector('select')?.value;
    if (text.trim()) {
        drafts.set(key, { text, mode, boundaryIndex: state.selectedIndex });
    } else {
        drafts.delete(key);
    }
}

/**
 * Open intercession mode on a message (defaults to the latest).
 */
export function openIntercede(index = undefined) {
    const ctx = getCtx();
    const settings = getSettings(ctx);
    if (!settings.enabled) {
        notify('info', 'Intercede is disabled in its settings panel.');
        return;
    }
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
        el('span', 'intercede-title-name', 'Intercede'),
        el('span', 'intercede-title-hint', ' — pick the point where your character responds'),
    );
    const closeButton = el('button', 'menu_button intercede-close', '✕');
    closeButton.type = 'button';
    closeButton.title = 'Close (Esc)';
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
    const draft = drafts.get(draftKey(chatId, targetIndex));
    if (draft && Number.isInteger(draft.boundaryIndex) && draft.boundaryIndex < boundaries.length) {
        selectBoundary(draft.boundaryIndex, draft);
    } else {
        boundaryNodes[0]?.focus();
    }
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
        node.classList.toggle('intercede-kept', i <= index);
        node.classList.toggle('intercede-cut', i > index);
    });

    const stored = draft ?? drafts.get(draftKey(state.chatId, state.targetIndex));
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
    const anchor = createAnchor(state.raw, boundary.offset, boundary.type);
    const { prefix, suffix } = splitAtOffset(state.raw, boundary.offset);

    // §8.4 confirmation preview with compatibility warnings.
    if (state.settings.confirmBeforeCommit) {
        const ctx = getCtx();
        const warnings = [];
        if (state.settings.warnExtensions) {
            const foreign = detectForeignContinuationData(state.message);
            if (foreign.length) {
                warnings.push(`This message carries continuation metadata from another extension (${foreign.join(', ')}). Only the visible text becomes the prefix; the full message is preserved for undo.`);
            }
            const memory = detectMemoryExtensions(ctx);
            if (memory.length) {
                warnings.push(`Memory-related extensions are active (${memory.join(', ')}). Memories already derived from this message are not automatically recalculated.`);
            }
        }

        const preview = el('div', 'intercede-confirm');
        const addSection = (heading, text, className) => {
            const section = el('div', 'intercede-compare-section');
            section.appendChild(el('div', 'intercede-compare-heading', heading));
            section.appendChild(el('div', `intercede-compare-text ${className}`, text));
            preview.appendChild(section);
        };
        addSection('Preserved (ends with)', '…' + prefix.slice(-240), 'intercede-compare-revised');
        addSection('Your response', insertionText, 'intercede-compare-insertion');
        addSection('Rewritten from here (originally)', truncate(suffix, 300), 'intercede-compare-original');
        preview.appendChild(el('div', 'intercede-compare-heading', `Rewrite mode: ${REWRITE_MODE_LABELS[rewriteMode]}`));
        for (const warning of warnings) {
            preview.appendChild(el('div', 'intercede-confirm-warning', '⚠ ' + warning));
        }

        const confirmed = await showConfirm('Commit this intercession?', preview, {
            confirmLabel: 'Intercede',
            cancelLabel: 'Back',
        });
        if (!confirmed) return;
    }

    saveDraftFromComposer();
    const key = draftKey(state.chatId, state.targetIndex);
    const { targetIndex, settings } = state;
    closeOverlay();

    notify('info', 'Interceding — rewriting the continuation…');
    const transaction = new IntercedeTransaction({ targetIndex, anchor, insertionText, rewriteMode });
    try {
        const result = await transaction.run();
        drafts.delete(key);
        notify('success', 'Intercession committed. Swipe the new continuation for other adaptations; /intercede undo restores the original.');
        for (const warning of result.warnings) {
            notify('warning', warning, { timeOut: 8000 });
        }
        if (settings.compareAfterCommit) {
            await showCompare();
        }
    } catch (error) {
        notify('error', `Intercession failed and was rolled back: ${error?.message ?? error}. Your response text was kept — open Intercede again to retry.`);
    }
}
