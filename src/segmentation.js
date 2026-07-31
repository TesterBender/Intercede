/**
 * Boundary discovery over RAW message text (message.mes).
 *
 * @see docs/RATIONALE.md#SEG-01 raw source only, never the DOM
 * @see docs/RATIONALE.md#SEG-02 what counts as a protected range
 * @see docs/RATIONALE.md#SEG-03 KNOWN DEFECT in SEPARATOR_REGEX (deferred)
 */

import { BOUNDARY_TYPES } from './constants.js';

/**
 * @typedef {{ start: number, end: number, kind: string }} ProtectedRange
 * @typedef {{ offset: number, type: 'paragraph' | 'sentence' }} Boundary
 */

/**
 * Compute regions of the raw text that must not contain a cut.
 * @param {string} text
 * @returns {ProtectedRange[]} sorted, possibly overlapping ranges
 */
export function getProtectedRanges(text) {
    const ranges = [];

    // Fenced code blocks (``` or ~~~), including an unclosed trailing fence.
    const lines = text.split('\n');
    let offset = 0;
    let fenceStart = -1;
    let fenceMarker = null;
    for (const line of lines) {
        const match = line.match(/^\s*(`{3,}|~{3,})/);
        if (match) {
            if (fenceStart === -1) {
                fenceStart = offset;
                fenceMarker = match[1][0];
            } else if (match[1][0] === fenceMarker) {
                ranges.push({ start: fenceStart, end: offset + line.length, kind: 'fence' });
                fenceStart = -1;
                fenceMarker = null;
            }
        }
        offset += line.length + 1;
    }
    if (fenceStart !== -1) {
        ranges.push({ start: fenceStart, end: text.length, kind: 'fence' });
    }

    const addMatches = (regex, kind) => {
        for (const match of text.matchAll(regex)) {
            ranges.push({ start: match.index, end: match.index + match[0].length, kind });
        }
    };

    // Inline code spans.
    addMatches(/(`+)(?!`)[\s\S]*?\1/g, 'inline-code');
    // Markdown links and images (single-line forms).
    addMatches(/!?\[[^\]\n]*\]\([^)\n]*\)/g, 'link');
    // Raw HTML tags (the tag itself, not its content).
    addMatches(/<\/?[a-zA-Z][^<>\n]*>/g, 'html-tag');
    // Macro expressions.
    addMatches(/\{\{[^{}]*\}\}/g, 'macro');

    ranges.sort((a, b) => a.start - b.start);
    return ranges;
}

/** True when a cut at `offset` would land strictly inside a protected range. */
export function isOffsetProtected(offset, ranges) {
    return ranges.some(range => offset > range.start && offset < range.end);
}

/**
 * Separator runs: one or more newlines with optional horizontal whitespace.
 * @see docs/RATIONALE.md#SEG-03 — KNOWN DEFECT: a single newline reads as a
 * paragraph break, degrading getBlocks() into a line-splitter. Deferred.
 */
const SEPARATOR_REGEX = /\n[^\S\n]*(?:\n[^\S\n]*)*/g;

/**
 * Blocks of text between separator runs.
 * @returns {{ start: number, end: number }[]} half-open [start, end) ranges of block text
 */
function getBlocks(text) {
    const blocks = [];
    let cursor = 0;
    for (const match of text.matchAll(SEPARATOR_REGEX)) {
        if (match.index > cursor) blocks.push({ start: cursor, end: match.index });
        cursor = match.index + match[0].length;
    }
    if (cursor < text.length) blocks.push({ start: cursor, end: text.length });
    return blocks;
}

/** Abbreviations that must not end a sentence. @see docs/RATIONALE.md#SEG-04 */
const ABBREVIATION_REGEX = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Lt|Sgt|Capt|Col|Gen|Rev|Hon|vs|etc|approx|dept|est|Fig|No|Vol|Ch|pp?)\.|\be\.g\.|\bi\.e\.|\b[A-Z]\.)$/;

/** Characters a sentence must not begin with (continuation punctuation, closing quotes). */
const BAD_SENTENCE_START_REGEX = /^["'”’)\]}»,.;:!?…—–-]|^[a-z]/;

/**
 * True when `offset` (relative to the block) sits inside an unfinished quotation
 * within the block text.
 */
function insideOpenQuote(blockText, relOffset) {
    const before = blockText.slice(0, relOffset);
    const straight = (before.match(/"/g) ?? []).length;
    if (straight % 2 === 1) return true;
    const curlyOpen = (before.match(/[“«]/g) ?? []).length;
    const curlyClose = (before.match(/[”»]/g) ?? []).length;
    if (curlyOpen > curlyClose) return true;
    return false;
}

function segmentSentences(blockText) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        try {
            const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
            return Array.from(segmenter.segment(blockText), part => part.index).slice(1);
        } catch { /* fall through to regex */ }
    }
    const starts = [];
    const regex = /[.!?…]["'”’)\]]*\s+/g;
    for (const match of blockText.matchAll(regex)) {
        starts.push(match.index + match[0].length);
    }
    return starts;
}

/**
 * Find all safe insertion boundaries in raw message text.
 * @param {string} text raw message source (message.mes)
 * @param {'paragraph' | 'sentence'} granularity 'sentence' includes paragraph boundaries too
 * @returns {Boundary[]} sorted by offset; each offset marks the end of the preserved text
 */
export function getBoundaries(text, granularity = 'sentence') {
    const ranges = getProtectedRanges(text);
    /** @type {Boundary[]} */
    const boundaries = [];

    const isValidCut = (offset) => {
        if (offset <= 0 || offset >= text.length) return false;
        if (isOffsetProtected(offset, ranges)) return false;
        if (!text.slice(0, offset).trim() || !text.slice(offset).trim()) return false;
        return true;
    };

    // Paragraph boundaries: at the start of every separator run (end of the preceding block).
    for (const match of text.matchAll(SEPARATOR_REGEX)) {
        const offset = match.index;
        if (isValidCut(offset)) {
            boundaries.push({ offset, type: BOUNDARY_TYPES.PARAGRAPH });
        }
    }

    if (granularity === 'sentence') {
        for (const block of getBlocks(text)) {
            const blockText = text.slice(block.start, block.end);
            if (isOffsetProtected(block.start + 1, ranges) && isOffsetProtected(block.end - 1, ranges)) {
                continue; // block lives entirely inside a protected region
            }
            for (const relStart of segmentSentences(blockText)) {
                // Cut at the end of the sentence text, before separator whitespace.
                const prevText = blockText.slice(0, relStart);
                const trimmed = prevText.replace(/\s+$/, '');
                if (trimmed.length < 2) continue;
                const offset = block.start + trimmed.length;
                if (!isValidCut(offset)) continue;
                if (ABBREVIATION_REGEX.test(trimmed)) continue;
                const nextText = blockText.slice(relStart).replace(/^\s+/, '');
                if (!nextText || BAD_SENTENCE_START_REGEX.test(nextText)) continue;
                if (insideOpenQuote(blockText, trimmed.length)) continue;
                boundaries.push({ offset, type: BOUNDARY_TYPES.SENTENCE });
            }
        }
    }

    boundaries.sort((a, b) => a.offset - b.offset);

    // @see docs/RATIONALE.md#SEG-05
    /** @type {Boundary[]} */
    const deduped = [];
    for (const boundary of boundaries) {
        const previous = deduped[deduped.length - 1];
        if (previous && Math.abs(previous.offset - boundary.offset) <= 2) {
            if (previous.type !== BOUNDARY_TYPES.PARAGRAPH && boundary.type === BOUNDARY_TYPES.PARAGRAPH) {
                deduped[deduped.length - 1] = boundary;
            }
            continue;
        }
        deduped.push(boundary);
    }
    return deduped.filter((boundary, index) => {
        const next = deduped[index + 1];
        if (boundary.type === BOUNDARY_TYPES.SENTENCE && next && next.type === BOUNDARY_TYPES.PARAGRAPH) {
            return text.slice(boundary.offset, next.offset).trim() !== '';
        }
        return true;
    });
}

/**
 * Split raw text at a boundary offset.
 * @see docs/RATIONALE.md#SEG-06 what happens to the separator whitespace
 */
export function splitAtOffset(text, offset) {
    return {
        prefix: text.slice(0, offset).replace(/\s+$/, ''),
        suffix: text.slice(offset).replace(/^\s+/, ''),
    };
}
