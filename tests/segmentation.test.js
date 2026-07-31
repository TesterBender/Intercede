/**
 * Boundary detection over raw message source.
 *
 * Every case here is about where a cut is *refused*. Over-refusing costs the
 * user a boundary they might have liked; under-refusing hands them a broken
 * one — a half-open `**`, a truncated list, a quote that never closes.
 *
 * @see docs/RATIONALE.md#SEG-02 protected ranges are a one-way valve
 */

import { describe, expect, it } from 'vitest';
import { getBoundaries, getProtectedRanges, isOffsetProtected, splitAtOffset } from '../src/segmentation.js';

/** Offsets only, for readability. */
const offsets = (text, granularity = 'sentence') =>
    getBoundaries(text, granularity).map(boundary => boundary.offset);

const types = (text, granularity = 'sentence') =>
    getBoundaries(text, granularity).map(boundary => boundary.type);

/**
 * True when some boundary hands the remainder starting at `needle`. The offset
 * itself sits before the separator whitespace, so compare the split, not the
 * index.
 */
const offersCutBefore = (text, needle, granularity = 'sentence') =>
    getBoundaries(text, granularity)
        .some(boundary => splitAtOffset(text, boundary.offset).suffix.startsWith(needle));

describe('paragraph boundaries', () => {
    // @see docs/RATIONALE.md#SEG-03
    it('offers a boundary at a blank line', () => {
        const text = 'She opened the door.\n\nOutside, it was raining.';

        expect(offsets(text, 'paragraph')).toEqual([20]);
        expect(types(text, 'paragraph')).toEqual(['paragraph']);
    });

    it('does not treat a single newline as a paragraph break', () => {
        const text = 'She opened the door.\nOutside, it was raining.';

        expect(offsets(text, 'paragraph')).toEqual([]);
    });

    it('treats a run of blank lines as one break, not several', () => {
        const text = 'First.\n\n\n\nSecond.';

        expect(offsets(text, 'paragraph')).toEqual([6]);
    });

    it('ignores trailing horizontal whitespace on the blank line', () => {
        const text = 'First.\n   \nSecond.';

        expect(offsets(text, 'paragraph')).toEqual([6]);
    });

    it('keeps a single-newline message as one block, so its quote spans lines', () => {
        // With a single newline as a separator this block would be split in two,
        // each half seeing a balanced quote count, and the cut inside the
        // quotation would be offered.
        const text = '"I never said that,\nand you know it," she snapped. He looked away.';

        expect(offersCutBefore(text, 'and you know it')).toBe(false);
        expect(offersCutBefore(text, 'He looked away')).toBe(true);
    });
});

describe('emphasis protection', () => {
    // @see docs/RATIONALE.md#SEG-07
    it.each([
        ['**strong**', '**strong text** and more'],
        ['__strong__', '__strong text__ and more'],
        ['*emphasis*', '*emphasised text* and more'],
        ['_emphasis_', '_emphasised text_ and more'],
        ['~~strike~~', '~~struck text~~ and more'],
    ])('protects %s', (_label, text) => {
        const ranges = getProtectedRanges(text);
        const inside = text.indexOf(' text');

        expect(isOffsetProtected(inside, ranges)).toBe(true);
    });

    it('moves a sentence cut past the closing delimiter rather than dropping it', () => {
        // UAX #29 does not treat `*` as closing punctuation, so the segmenter
        // breaks between `.` and `*`. Protection rejects that offset; the cut
        // lands one character later, after the emphasis closes.
        const text = '*She walks in.*\n\n*He nods at her.*';

        expect(offsets(text)).toEqual([15]);
        expect(splitAtOffset(text, 15).prefix).toBe('*She walks in.*');
    });

    it('still finds the cut between two adjacent emphasis spans', () => {
        // Regression: testing the two ends of a block for protection separately
        // discarded the whole block here, because each end sat in a *different*
        // range while the offset between them was free.
        const text = '*She walks in.*\n*He nods at her.*\n\nThe door closes.';

        expect(offsets(text)).toEqual([15, 33]);
    });

    it('does not protect a delimiter inside a word', () => {
        const text = 'The snake_case_name is fine. So is another sentence.';
        const ranges = getProtectedRanges(text);

        expect(ranges.filter(range => range.kind === 'emphasis')).toEqual([]);
        expect(offersCutBefore(text, 'So is')).toBe(true);
    });

    it('does not treat spaced asterisks as emphasis', () => {
        const text = 'Compute 2 * 3 * 4 first. Then stop.';
        const ranges = getProtectedRanges(text);

        expect(ranges.filter(range => range.kind === 'emphasis')).toEqual([]);
        expect(offersCutBefore(text, 'Then stop')).toBe(true);
    });

    it('does not let an unclosed delimiter swallow the rest of the message', () => {
        const text = 'He said *something odd.\n\nThen he left. She stayed.';
        const ranges = getProtectedRanges(text);

        expect(ranges.filter(range => range.kind === 'emphasis')).toEqual([]);
        expect(offersCutBefore(text, 'She stayed')).toBe(true);
    });
});

describe('list protection', () => {
    // @see docs/RATIONALE.md#SEG-08
    it('protects a bullet list as one unit', () => {
        const text = 'Pack this:\n\n- rope\n- flint\n- a spare knife\n\nThen go.';
        const between = text.indexOf('- flint');

        expect(isOffsetProtected(between, getProtectedRanges(text))).toBe(true);
        // Before the list and after it — never between two of its items.
        expect(offsets(text, 'paragraph')).toEqual([10, 42]);
    });

    it('protects an ordered list, including indented continuations', () => {
        const text = 'Steps:\n\n1. Draw the bow.\n   Slowly.\n2. Loose.\n\nDone.';
        const ranges = getProtectedRanges(text).filter(range => range.kind === 'list');

        expect(ranges).toHaveLength(1);
        expect(text.slice(ranges[0].start, ranges[0].end)).toBe('1. Draw the bow.\n   Slowly.\n2. Loose.');
    });

    it('keeps a loose list together across the blank lines between its items', () => {
        const text = '- first\n\n- second\n\nAfter the list.';
        const ranges = getProtectedRanges(text).filter(range => range.kind === 'list');

        expect(ranges).toHaveLength(1);
        expect(text.slice(ranges[0].start, ranges[0].end)).toBe('- first\n\n- second');
    });

    it('leaves the boundary at the edge of the list available', () => {
        // Protection is a strict-inequality test, so a cut exactly at either end
        // of the run is still legal — the same trade as a fenced code block.
        const text = 'Pack this:\n\n- rope\n- flint\n\nThen go.';
        const listEnd = text.indexOf('- flint') + '- flint'.length;

        expect(isOffsetProtected(listEnd, getProtectedRanges(text))).toBe(false);
    });
});
