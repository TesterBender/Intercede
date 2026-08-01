/**
 * Boundary discovery over RAW message text (message.mes).
 *
 * @see docs/RATIONALE.md#SEG-01 raw source only, never the DOM
 * @see docs/RATIONALE.md#SEG-02 what counts as a protected range
 * @see docs/RATIONALE.md#SEG-03 a paragraph break is a blank line
 */

import { BOUNDARY_TYPES } from './constants.js';

/**
 * @typedef {{ start: number, end: number, kind: string }} ProtectedRange
 * @typedef {{ offset: number, type: 'paragraph' | 'sentence' }} Boundary
 */

/**
 * One character that cannot start a blank line, so no match spans a paragraph
 * break. @see docs/RATIONALE.md#SEG-07
 */
const WITHIN_BLOCK = String.raw`(?:(?!\n[^\S\n]*\n)[\s\S])`;

/** A backslash-escaped character, consumed as one unit. @see docs/RATIONALE.md#SEG-07 */
const ESCAPED = String.raw`\\[^\n]`;

/**
 * Zero-width assertion: this position is not preceded by an *odd* run of
 * backslashes, i.e. the delimiter starting here is not escaped.
 * @see docs/RATIONALE.md#SEG-07 why parity, and not `(?<!\\)`
 */
const NOT_ESCAPED = String.raw`(?<!(?<!\\)(?:\\\\)*\\)`;

/** Body of an emphasis span: escapes first, then anything that is not `delim`. */
const spanBody = (delim) => String.raw`(?:${ESCAPED}|(?!${delim})${WITHIN_BLOCK})+?`;

/**
 * Paired Markdown emphasis.
 * @see docs/RATIONALE.md#SEG-07 the three CommonMark rules these encode, and why
 */
const EMPHASIS_PATTERNS = [
    // ~~strikethrough~~
    String.raw`${NOT_ESCAPED}~~(?!\s)${spanBody('~~')}(?<!\s)${NOT_ESCAPED}~~`,
    // ***bold italic***, matched before `**`. @see docs/RATIONALE.md#SEG-07
    String.raw`(?<!\*)${NOT_ESCAPED}\*\*\*(?!\s)${spanBody(String.raw`\*\*\*`)}(?<!\s)${NOT_ESCAPED}\*\*\*`,
    // **strong** and __strong__
    String.raw`(?<!\*)${NOT_ESCAPED}\*\*(?!\s)${spanBody(String.raw`\*\*`)}(?<!\s)${NOT_ESCAPED}\*\*`,
    String.raw`(?<![\w_])${NOT_ESCAPED}__(?!\s)${spanBody('__')}(?<!\s)${NOT_ESCAPED}__(?![\w_])`,
    // *emphasis* and _emphasis_
    String.raw`(?<!\*)${NOT_ESCAPED}\*(?!\s)${spanBody(String.raw`\*`)}(?<!\s)${NOT_ESCAPED}\*(?!\*)`,
    String.raw`(?<![\w_])${NOT_ESCAPED}_(?!\s)${spanBody('_')}(?<!\s)${NOT_ESCAPED}_(?![\w_])`,
].map(source => new RegExp(source, 'g'));

/** A line that opens a bullet or ordered list item. */
const LIST_ITEM_REGEX = /^[^\S\n]{0,3}(?:[-*+]|\d{1,9}[.)])[^\S\n]+\S/;
/** An indented line continuing the item above it. */
const LIST_CONTINUATION_REGEX = /^[^\S\n]{2,}\S/;

/** True when this line keeps a list run open across a blank line. */
const resumesList = (line) => LIST_ITEM_REGEX.test(line) || LIST_CONTINUATION_REGEX.test(line);

/**
 * Protect each run of list items as one unit.
 * @see docs/RATIONALE.md#SEG-08 what a cut between two items costs, and where the run ends
 */
function addListRanges(text, ranges) {
    const lines = text.split('\n');
    const lineStarts = [];
    let offset = 0;
    for (const line of lines) {
        lineStarts.push(offset);
        offset += line.length + 1;
    }

    let start = -1;
    let end = 0;
    const flush = () => {
        if (start !== -1) ranges.push({ start, end, kind: 'list' });
        start = -1;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (LIST_ITEM_REGEX.test(line)) {
            if (start === -1) start = lineStarts[i];
            end = lineStarts[i] + line.length;
        } else if (start === -1) {
            continue;
        } else if (LIST_CONTINUATION_REGEX.test(line)) {
            end = lineStarts[i] + line.length;
        } else if (!line.trim() && resumesList(lines[i + 1] ?? '')) {
            // A loose list keeps the blank line inside the run.
            // @see docs/RATIONALE.md#SEG-08
        } else {
            flush();
        }
    }
    flush();
}

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
    // Reference-style links, and the definitions they resolve against.
    // @see docs/RATIONALE.md#SEG-09 why the shortcut form `[label]` is excluded
    addMatches(/!?\[[^\]\n]*\]\[[^\]\n]*\]/g, 'link');
    addMatches(/^[^\S\n]{0,3}\[[^\]\n]+\]:[^\n]*/gm, 'link-definition');
    // Raw HTML tags (the tag itself, not its content).
    addMatches(/<\/?[a-zA-Z][^<>\n]*>/g, 'html-tag');
    // Macro expressions.
    addMatches(/\{\{[^{}]*\}\}/g, 'macro');
    // @see docs/RATIONALE.md#SEG-07
    for (const pattern of EMPHASIS_PATTERNS) addMatches(pattern, 'emphasis');
    // @see docs/RATIONALE.md#SEG-08
    addListRanges(text, ranges);

    ranges.sort((a, b) => a.start - b.start);
    return ranges;
}

/** True when a cut at `offset` would land strictly inside a protected range. */
export function isOffsetProtected(offset, ranges) {
    return ranges.some(range => offset > range.start && offset < range.end);
}

/**
 * A paragraph break: a blank line, i.e. two or more newlines separated by at
 * most horizontal whitespace. A single newline is a line break within a
 * paragraph and is deliberately not one of these.
 * @see docs/RATIONALE.md#SEG-03
 */
const PARAGRAPH_SEPARATOR_REGEX = /\n[^\S\n]*(?:\n[^\S\n]*)+/g;

/**
 * Blocks of text between paragraph separators.
 * @returns {{ start: number, end: number }[]} half-open [start, end) ranges of block text
 */
function getBlocks(text) {
    const blocks = [];
    let cursor = 0;
    for (const match of text.matchAll(PARAGRAPH_SEPARATOR_REGEX)) {
        if (match.index > cursor) blocks.push({ start: cursor, end: match.index });
        cursor = match.index + match[0].length;
    }
    if (cursor < text.length) blocks.push({ start: cursor, end: text.length });
    return blocks;
}

/** Abbreviations that must not end a sentence. @see docs/RATIONALE.md#SEG-04 */
const ABBREVIATION_REGEX = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Lt|Sgt|Capt|Col|Gen|Rev|Hon|vs|etc|approx|dept|est|Fig|No|Vol|Ch|pp?)\.|\be\.g\.|\bi\.e\.|\b[A-Z]\.)$/;

/**
 * Characters a sentence must not begin with: continuation punctuation and
 * *closing* quotes.
 * @see docs/RATIONALE.md#SEG-10 why opening quotes are deliberately absent
 */
const BAD_SENTENCE_START_REGEX = /^[”’)\]}»,.;:!?…—–-]|^[a-z]/;

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

    // Paragraph boundaries: at the start of every blank line (end of the preceding block).
    for (const match of text.matchAll(PARAGRAPH_SEPARATOR_REGEX)) {
        const offset = match.index;
        if (isValidCut(offset)) {
            boundaries.push({ offset, type: BOUNDARY_TYPES.PARAGRAPH });
        }
    }

    if (granularity === 'sentence') {
        for (const block of getBlocks(text)) {
            const blockText = text.slice(block.start, block.end);
            // One range must swallow the whole block, not one range per end.
            // @see docs/RATIONALE.md#SEG-02
            if (ranges.some(range => range.start <= block.start && range.end >= block.end)) {
                continue;
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
                // A cut inside dialogue is offered, not suppressed.
                // @see docs/RATIONALE.md#SEG-10
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
 * What a cut here leaves dangling in the preserved prefix. Only the final block
 * is assessed.
 *
 * @see docs/RATIONALE.md#SEG-10 the other half of offering dialogue boundaries
 * @param {string} prefix the preserved text, as `splitAtOffset()` returns it
 * @returns {string[]} human-readable descriptions, empty when the cut is clean
 */
export function describeCutRisks(prefix) {
    const risks = [];
    const separators = [...String(prefix ?? '').matchAll(PARAGRAPH_SEPARATOR_REGEX)];
    const last = separators[separators.length - 1];
    const block = last ? prefix.slice(last.index + last[0].length) : String(prefix ?? '');
    if (!block) return risks;

    if (insideOpenQuote(block, block.length)) {
        risks.push('This cut leaves a quotation open — the closing quote mark is in the rewritten part.');
    }

    // Blank out everything that closed properly, then see what delimiters are
    // left over. Escapes go first so `\*` is never counted as one.
    let residue = block.replace(new RegExp(ESCAPED, 'g'), '');
    for (const range of getProtectedRanges(residue)) {
        if (range.kind === 'emphasis' || range.kind === 'inline-code' || range.kind === 'fence') {
            residue = residue.slice(0, range.start) + ' '.repeat(range.end - range.start) + residue.slice(range.end);
        }
    }
    if (/\*\*|~~|[*_`]/.test(residue)) {
        risks.push('This cut leaves a Markdown delimiter unclosed, so the preserved text may render oddly.');
    }
    return risks;
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
