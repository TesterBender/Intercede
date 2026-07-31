/**
 * Boundary visibility against the rendered message (§9.5).
 *
 * @see docs/RATIONALE.md#VIS-01 the visible / hidden / failed classification
 * @see docs/RATIONALE.md#VIS-02 the private-use sentinel technique
 */

import { getCtx } from '../stcontext.js';

export const S_START = String.fromCharCode(0xE000);
export const S_END = String.fromCharCode(0xE001);
export const SENTINEL_REGEX = new RegExp(S_START + '([0-9]+)' + S_END);

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
 * Render the instrumented raw text through SillyTavern's own formatting
 * pipeline into a detached container.
 * @returns {HTMLElement | null} null when the pipeline is unavailable or throws
 */
export function renderInstrumented(raw, boundaries, message, targetIndex) {
    const ctx = getCtx();
    if (typeof ctx?.messageFormatting !== 'function') return null;
    try {
        const rendered = ctx.messageFormatting(
            instrumentRaw(raw, boundaries),
            message.name,
            Boolean(message.is_system),
            Boolean(message.is_user),
            targetIndex,
        );
        const container = document.createElement('div');
        container.innerHTML = rendered; // messageFormatting output is already sanitized by ST
        return container;
    } catch (error) {
        console.warn('[Intercede] instrumented render failed', error);
        return null;
    }
}

/** Comparable text: letters and digits only, case-folded (markdown/punctuation-proof). */
function normalize(text) {
    return String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const CONTEXT_CHARS = 48;
const MIN_CONTEXT = 6;

/**
 * Classify each boundary against an instrumented render.
 * @param {string} raw original message source
 * @param {{ offset: number }[]} boundaries
 * @param {HTMLElement} container result of renderInstrumented()
 * @returns {('visible' | 'hidden' | 'failed')[]} status per boundary index
 */
export function classifyBoundaries(raw, boundaries, container) {
    const renderedText = container.textContent ?? '';
    const renderedNorm = normalize(renderedText);
    return boundaries.map((boundary, index) => {
        if (renderedText.includes(S_START + index + S_END)) return 'visible';
        // @see docs/RATIONALE.md#VIS-03
        const afterEnd = Math.min(boundary.offset + CONTEXT_CHARS, boundaries[index + 1]?.offset ?? raw.length);
        const beforeStart = Math.max(boundary.offset - CONTEXT_CHARS, boundaries[index - 1]?.offset ?? 0);
        const after = normalize(raw.slice(boundary.offset, afterEnd));
        const before = normalize(raw.slice(beforeStart, boundary.offset));
        const contextVisible =
            (after.length >= MIN_CONTEXT && renderedNorm.includes(after)) ||
            (before.length >= MIN_CONTEXT && renderedNorm.includes(before));
        return contextVisible ? 'failed' : 'hidden';
    });
}
