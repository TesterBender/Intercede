/**
 * In-place selection interface: intercession mode rendered directly over the
 * assistant message where it sits in the chat.
 *
 * @see docs/RATIONALE.md#UI-01 the marker design and the fallback rule
 * @see docs/RATIONALE.md#UI-02 sentinels that formed their own block
 * @see docs/RATIONALE.md#VIS-01 how boundaries are classified first
 */

import { BOUNDARY_TYPES } from '../constants.js';
import { getCtx } from '../stcontext.js';
import { el, notify } from '../utils.js';
import { findDraftBoundaryIndex, getDraft } from './commit-flow.js';
import { buildComposer, commitFromState, resolveSelectionTarget, saveDraftFromState } from './selection.js';
import { classifyBoundaries, renderInstrumented, SENTINEL_REGEX } from './visibility.js';

export { instrumentRaw } from './visibility.js';

const MARKER_GLYPH = '⤷';

let inlineState = null;

export function isInlineModeOpen() {
    return inlineState !== null;
}

/**
 * Open in-place mode on a message (defaults to the latest).
 * @returns {'ok' | 'fallback'} 'fallback' when the floating window should be used instead
 */
export function openInlineMode(index = undefined) {
    const target = resolveSelectionTarget(index);
    if (!target.ok) return 'ok';

    const { raw, boundaries, message, targetIndex } = target;
    const mesNode = document.querySelector(`#chat .mes[mesid="${targetIndex}"]`);
    const mesTextNode = mesNode?.querySelector('.mes_text');
    if (!mesNode || !mesTextNode) {
        return 'fallback';
    }

    const container = renderInstrumented(raw, boundaries, message, targetIndex);
    if (!container) return 'fallback';
    // @see docs/RATIONALE.md#VIS-01
    const statuses = classifyBoundaries(raw, boundaries, container);

    closeInlineMode();
    inlineState = {
        targetIndex,
        chatId: target.chatId,
        message,
        settings: target.settings,
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
    removeGhostMarkers(container, statuses);

    const survivors = inlineState.markers.size;
    const failedCount = statuses.filter(status => status === 'failed').length;
    if (failedCount > survivors) {
        // @see docs/RATIONALE.md#UI-01 ('failed' triggers the window fallback)
        inlineState = null;
        return 'fallback';
    }
    if (survivors === 0) {
        inlineState = null;
        notify('warning', 'No insertion points found in the visible text of this message.');
        return 'ok';
    }

    // Moving nodes keeps marker listeners alive. @see docs/RATIONALE.md#UI-01
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
        // @see docs/RATIONALE.md#UI-10
        if (event.target.closest('#intercede_wand_item, .mes_intercede')) return;
        if (!inlineState.mesNode.contains(event.target)) {
            closeInlineMode();
        }
    };
    document.addEventListener('keydown', inlineState.onKeydown, true);
    document.addEventListener('mousedown', inlineState.onDocMousedown, true);

    // Restore a draft from a failed/cancelled attempt on this same message.
    const draft = getDraft(inlineState.chatId, targetIndex);
    const draftIndex = findDraftBoundaryIndex(draft, boundaries);
    if (draftIndex !== null && inlineState.markers.has(draftIndex)) {
        selectInlineBoundary(draftIndex, draft);
    }
    return 'ok';
}

export function closeInlineMode() {
    const state = inlineState;
    if (!state) return;
    saveDraftFromState(state);
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
            marker.appendChild(el('span', 'intercede-imarker-glyph', MARKER_GLYPH));
            marker.addEventListener('click', (event) => {
                event.stopPropagation();
                selectInlineBoundary(index);
            });

            const host = isParagraph ? hostBlockOf(node, container) : null;
            if (host) {
                // Absolute, so spacing never shifts. @see docs/RATIONALE.md#UI-01
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

/**
 * Drop markers whose sentinel formed its own block.
 * @see docs/RATIONALE.md#UI-02
 */
function removeGhostMarkers(container, statuses) {
    for (const [index, marker] of [...inlineState.markers]) {
        // Still detached here — membership, not isConnected. @see docs/RATIONALE.md#UI-02
        if (!container.contains(marker)) {
            inlineState.markers.delete(index);
            statuses[index] = 'hidden';
            continue;
        }
        const host = marker.dataset.hosted ? marker.parentElement : hostBlockOf(marker, container);
        if (!host || host === container) continue;
        if (host.textContent.split(MARKER_GLYPH).join('').trim()) continue;
        inlineState.markers.delete(index);
        statuses[index] = 'hidden';
        host.remove();
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

    saveDraftFromState(state);
    state.undoDim?.();
    state.undoDim = null;
    state.composer?.remove();
    state.composer = null;
    state.selectedIndex = index;

    for (const [, node] of state.markers) node.classList.remove('intercede-imarker-selected');
    marker.classList.add('intercede-imarker-selected');

    // @see docs/RATIONALE.md#UI-11
    const startNode = marker.dataset.hosted ? marker.parentElement : marker;
    state.undoDim = dimAfter(startNode, state.mesTextNode);

    const composer = buildComposer({
        state,
        draft: draft ?? getDraft(state.chatId, state.targetIndex),
        variant: 'intercede-composer-inline',
        onCommit: commitInlineSelection,
        onCancel: () => {
            saveDraftFromState(inlineState);
            clearInlineSelection();
        },
    });
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

async function commitInlineSelection() {
    await commitFromState(inlineState, closeInlineMode);
}
