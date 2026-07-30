/**
 * In-place selection interface: intercession mode rendered directly over the
 * assistant message where it sits in the chat.
 *
 * The message keeps its native Markdown rendering and spacing. Insertion
 * points appear as faded, zero-layout-impact markers — hairlines floating in
 * the existing paragraph gaps, small translucent chips at sentence breaks —
 * that light up on hover. Esc, clicking away, or invoking Intercede again
 * restores the original rendering untouched.
 *
 * Implementation is the §9.5 source-offset sentinel technique: private-use
 * Unicode sentinels are inserted at raw-text boundary offsets, the copy is
 * rendered through SillyTavern's own messageFormatting pipeline, and the
 * surviving sentinels are swapped for interactive markers. The chat data is
 * never touched; exit re-renders natively via updateMessageBlock. If the
 * formatting pipeline destroys too many sentinels (aggressive regex scripts),
 * the caller falls back to the floating window.
 */

import { BOUNDARY_TYPES, REWRITE_MODES, REWRITE_MODE_LABELS } from '../constants.js';
import { getBoundaries } from '../segmentation.js';
import { getCtx, getCurrentChatId, getSettings } from '../stcontext.js';
import { isEligibleTarget } from '../transaction.js';
import { el, notify } from '../utils.js';
import { confirmAndCommit, getDraft, setDraft } from './commit-flow.js';

const S_START = String.fromCharCode(0xE000);
const S_END = String.fromCharCode(0xE001);
const SENTINEL_REGEX = new RegExp(S_START + '(\\d+)' + S_END);

let inlineState = null;

export function isInlineModeOpen() {
    return inlineState !== null;
}

/** Insert sentinel tokens at boundary offsets (pure; exported for tests). */
export function instrumentRaw(raw, boundaries) {
    let out = raw;
    for (let i = boundaries.length - 1; i >= 0; i--) {
        const offset = boundaries[i].offset;
        out = out.slice(0, offset) + S_START + i + S_END + out.slice(offset);
    }
    return out;
}

/**
 * Open in-place mode on a message (defaults to the latest).
 * @returns {'ok' | 'fallback'} 'fallback' when the floating window should be used instead
 */
export function openInlineMode(index = undefined) {
    const ctx = getCtx();
    const settings = getSettings(ctx);
    const eligible = isEligibleTarget(ctx, index);
    if (!eligible.ok) {
        notify('warning', eligible.reason);
        return 'ok';
    }
    const targetIndex = eligible.targetIndex;
    const mesNode = document.querySelector(`#chat .mes[mesid="${targetIndex}"]`);
    const mesTextNode = mesNode?.querySelector('.mes_text');
    if (!mesNode || !mesTextNode || typeof ctx.messageFormatting !== 'function') {
        return 'fallback';
    }

    const raw = String(eligible.message.mes ?? '');
    const boundaries = getBoundaries(raw, settings.boundaries);
    if (!boundaries.length) {
        notify('warning', 'No safe insertion points were found in this message.');
        return 'ok';
    }

    let rendered;
    try {
        rendered = ctx.messageFormatting(
            instrumentRaw(raw, boundaries),
            eligible.message.name,
            Boolean(eligible.message.is_system),
            Boolean(eligible.message.is_user),
            targetIndex,
        );
    } catch (error) {
        console.warn('[Intercede] messageFormatting failed for in-place mode', error);
        return 'fallback';
    }

    const container = document.createElement('div');
    container.innerHTML = rendered; // messageFormatting output is already sanitized by ST

    closeInlineMode();
    inlineState = {
        targetIndex,
        chatId: getCurrentChatId(ctx),
        message: eligible.message,
        settings,
        raw,
        boundaries,
        mesNode,
        mesTextNode,
        markers: new Map(),
        selectedIndex: null,
        composer: null,
        undoDim: null,
        onKeydown: null,
        onDocMousedown: null,
    };

    placeMarkers(container, boundaries);
    if (inlineState.markers.size < Math.max(1, Math.ceil(boundaries.length / 2))) {
        // The formatting pipeline ate the sentinels — this message can't host markers.
        inlineState = null;
        return 'fallback';
    }

    // Swap the rendered content in (moving nodes keeps marker listeners alive).
    mesTextNode.replaceChildren(...container.childNodes);
    mesNode.classList.add('intercede-inline-active');

    inlineState.onKeydown = (event) => {
        if (!inlineState) return;
        if (document.querySelector('.intercede-modal-backdrop')) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeInlineMode();
            return;
        }
        if (event.target instanceof HTMLTextAreaElement && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            commitInlineSelection();
        }
    };
    inlineState.onDocMousedown = (event) => {
        if (!inlineState || !(event.target instanceof Element)) return;
        if (document.querySelector('.intercede-modal-backdrop')) return;
        // Trigger controls toggle the mode themselves — don't double-handle.
        if (event.target.closest('#intercede_wand_item, .mes_intercede')) return;
        if (!inlineState.mesNode.contains(event.target)) {
            closeInlineMode();
        }
    };
    document.addEventListener('keydown', inlineState.onKeydown, true);
    document.addEventListener('mousedown', inlineState.onDocMousedown, true);

    // Restore a draft from a failed/cancelled attempt on this same message.
    const draft = getDraft(inlineState.chatId, targetIndex);
    if (draft && Number.isInteger(draft.boundaryIndex) && inlineState.markers.has(draft.boundaryIndex)) {
        selectInlineBoundary(draft.boundaryIndex, draft);
    }
    return 'ok';
}

export function closeInlineMode() {
    const state = inlineState;
    if (!state) return;
    saveDraftFromComposer();
    document.removeEventListener('keydown', state.onKeydown, true);
    document.removeEventListener('mousedown', state.onDocMousedown, true);
    inlineState = null;

    state.mesNode.classList.remove('intercede-inline-active');
    // Restore the untouched native rendering from canonical chat data.
    try {
        const ctx = getCtx();
        const message = ctx?.chat?.[state.targetIndex];
        if (ctx && message) {
            ctx.updateMessageBlock(state.targetIndex, message);
        }
    } catch (error) {
        console.warn('[Intercede] native re-render on close failed', error);
    }
}

function saveDraftFromComposer() {
    const state = inlineState;
    const textarea = state?.composer?.querySelector('textarea');
    if (!state || !textarea) return;
    setDraft(state.chatId, state.targetIndex, {
        text: textarea.value,
        mode: state.composer.querySelector('select')?.value,
        boundaryIndex: state.selectedIndex,
    });
}

/** Nearest block-level host of a node, stopping below the container. */
function hostBlockOf(node, container) {
    let current = node instanceof Element ? node : node.parentElement;
    while (current && current !== container) {
        if (/^(P|LI|BLOCKQUOTE|PRE|DIV|H[1-6])$/.test(current.tagName) && current.parentElement) {
            return current;
        }
        current = current.parentElement;
    }
    return null;
}

/** Find surviving sentinels in the rendered DOM and replace them with markers. */
function placeMarkers(container, boundaries) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (SENTINEL_REGEX.test(node.textContent)) textNodes.push(node);
    }

    for (const textNode of textNodes) {
        let node = textNode;
        let match;
        while (node && (match = SENTINEL_REGEX.exec(node.textContent))) {
            const index = Number(match[1]);
            const boundary = boundaries[index];
            const after = node.splitText(match.index);
            after.textContent = after.textContent.slice(match[0].length);

            if (!boundary || inlineState.markers.has(index)) {
                node = after;
                continue;
            }

            const isParagraph = boundary.type === BOUNDARY_TYPES.PARAGRAPH;
            const marker = el('button',
                'intercede-imarker ' + (isParagraph ? 'intercede-imarker-para' : 'intercede-imarker-sentence'));
            marker.type = 'button';
            marker.dataset.index = String(index);
            marker.title = 'Respond here';
            marker.appendChild(el('span', 'intercede-imarker-glyph', '⤷'));
            marker.addEventListener('click', (event) => {
                event.stopPropagation();
                selectInlineBoundary(index);
            });

            const host = isParagraph ? hostBlockOf(node, container) : null;
            if (host) {
                // Paragraph markers become a hairline floating in the existing
                // gap below the host block — absolute, so spacing never shifts.
                host.classList.add('intercede-ipara-host');
                host.appendChild(marker);
                marker.dataset.hosted = '1';
            } else {
                node.parentNode.insertBefore(marker, after);
            }
            inlineState.markers.set(index, marker);
            node = after;
        }
    }
}

/** Dim everything after `startNode` in document order, up to the message root. */
function dimAfter(startNode, rootNode) {
    const dimmed = [];
    const wrappers = [];
    let node = startNode;
    while (node && node !== rootNode) {
        let sibling = node.nextSibling;
        while (sibling) {
            if (sibling.nodeType === Node.TEXT_NODE) {
                if (sibling.textContent.trim()) {
                    const wrapper = el('span', 'intercede-idim');
                    sibling.before(wrapper);
                    wrapper.appendChild(sibling);
                    wrappers.push(wrapper);
                    sibling = wrapper.nextSibling;
                    continue;
                }
            } else if (sibling instanceof Element && !sibling.classList.contains('intercede-composer')) {
                sibling.classList.add('intercede-idim');
                dimmed.push(sibling);
            }
            sibling = sibling.nextSibling;
        }
        node = node.parentNode;
    }
    return () => {
        for (const element of dimmed) element.classList.remove('intercede-idim');
        for (const wrapper of wrappers) wrapper.replaceWith(...wrapper.childNodes);
    };
}

function selectInlineBoundary(index, draft = null) {
    const state = inlineState;
    if (!state) return;
    const marker = state.markers.get(index);
    if (!marker) return;

    saveDraftFromComposer();
    state.undoDim?.();
    state.undoDim = null;
    state.composer?.remove();
    state.composer = null;
    state.selectedIndex = index;

    for (const [, node] of state.markers) node.classList.remove('intercede-imarker-selected');
    marker.classList.add('intercede-imarker-selected');

    // Paragraph markers are appended to their host block, so dimming starts at
    // the host; sentence markers dim from their own position.
    const startNode = marker.dataset.hosted ? marker.parentElement : marker;
    state.undoDim = dimAfter(startNode, state.mesTextNode);

    const stored = draft ?? getDraft(state.chatId, state.targetIndex);
    const composer = buildInlineComposer(stored);
    const anchorBlock = marker.dataset.hosted
        ? marker.parentElement
        : (hostBlockOf(marker, state.mesTextNode) ?? marker);
    anchorBlock.after(composer);
    state.composer = composer;
    const textarea = composer.querySelector('textarea');
    textarea.focus();
    composer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function clearInlineSelection() {
    const state = inlineState;
    if (!state) return;
    state.undoDim?.();
    state.undoDim = null;
    state.composer?.remove();
    state.composer = null;
    state.selectedIndex = null;
    for (const [, node] of state.markers) node.classList.remove('intercede-imarker-selected');
}

function buildInlineComposer(draft) {
    const state = inlineState;
    const composer = el('div', 'intercede-composer intercede-composer-inline');

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
    commitButton.addEventListener('click', commitInlineSelection);

    const cancelButton = el('button', 'menu_button', 'Cancel');
    cancelButton.type = 'button';
    cancelButton.addEventListener('click', () => {
        saveDraftFromComposer();
        clearInlineSelection();
    });

    controls.append(select, commitButton, cancelButton);
    composer.append(textarea, controls);
    composer.appendChild(el('div', 'intercede-composer-hint',
        'Everything above stays exactly as written. Everything dimmed below is rewritten around your response.'));
    return composer;
}

async function commitInlineSelection() {
    const state = inlineState;
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
        closeMode: closeInlineMode,
    });
}
