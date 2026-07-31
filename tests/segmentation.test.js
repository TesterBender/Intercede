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
import { describeCutRisks, getBoundaries, getProtectedRanges, isOffsetProtected, splitAtOffset } from '../src/segmentation.js';

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

    it('assesses a multi-line quotation as one block', () => {
        // A line-splitter would judge the risk of a cut against half a
        // paragraph. @see docs/RATIONALE.md#SEG-03
        const text = '"I never said that,\nand you know it," she snapped. He looked away.';

        expect(offersCutBefore(text, 'He looked away')).toBe(true);
        // A single newline does not close the quotation: the risk is assessed
        // across it, which a line-splitter would have missed.
        const midQuote = text.slice(0, text.indexOf('and you know it'));
        expect(describeCutRisks(midQuote)[0]).toMatch(/quotation/i);
    });
});

describe('dialogue boundaries', () => {
    // @see docs/RATIONALE.md#SEG-10
    it('offers the boundary before an opening quotation', () => {
        const text = 'A small shrug inside the sweater. "It\'s not going to work like that."';

        expect(offersCutBefore(text, '"It\'s not going')).toBe(true);
    });

    it('offers boundaries inside dialogue', () => {
        const text = '"Right now you don\'t have one. That\'s why people are nodding."';

        expect(offersCutBefore(text, 'That\'s why')).toBe(true);
    });

    it('still refuses a boundary before a closing quote', () => {
        // Here the segmenter breaks between the sentence and the quote mark that
        // ends the speech; cutting there strands the delimiter in the rewrite.
        const text = '"He said it plainly. I heard him." She looked away.';

        expect(offersCutBefore(text, '" She looked')).toBe(false);
        expect(offersCutBefore(text, 'She looked away')).toBe(true);
    });

    describe('cut risks', () => {
        it('reports an open quotation', () => {
            const risks = describeCutRisks('She turned. "This is not over.');

            expect(risks).toHaveLength(1);
            expect(risks[0]).toMatch(/quotation/i);
        });

        it('reports an unclosed emphasis delimiter', () => {
            const risks = describeCutRisks('He froze. *She did not.');

            expect(risks).toHaveLength(1);
            expect(risks[0]).toMatch(/delimiter/i);
        });

        it('says nothing about a clean cut', () => {
            expect(describeCutRisks('She turned. *"This is over,"* he said.')).toEqual([]);
        });

        it('ignores an escaped delimiter', () => {
            expect(describeCutRisks('The price is 5 \\* 3 dollars.')).toEqual([]);
        });

        it('only assesses the last paragraph', () => {
            // The quotation two paragraphs up is somebody else's problem.
            expect(describeCutRisks('"An open quote\n\nA clean closing paragraph.')).toEqual([]);
        });
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

    it('protects emphasis that opens inside a word', () => {
        // CommonMark allows intraword emphasis with `*` (not with `_`), so this
        // renders as emphasis and the sentence break inside it is not a cut.
        const text = 'foo*First sentence. Second sentence*bar';
        const ranges = getProtectedRanges(text);

        expect(isOffsetProtected(text.indexOf(' Second'), ranges)).toBe(true);
        expect(offsets(text)).toEqual([]);
    });

    it('treats an escaped delimiter as literal text, not as emphasis', () => {
        const text = 'He said \\*not emphasis\\* aloud. Then he stopped.';
        const ranges = getProtectedRanges(text);

        expect(ranges.filter(range => range.kind === 'emphasis')).toEqual([]);
        expect(offersCutBefore(text, 'Then he stopped')).toBe(true);
    });

    it('does not let an escaped delimiter close a span early', () => {
        // The span runs to the final `*`; a cut after "one." is inside it.
        const text = '*Escaped \\* here. Sentence one.* Sentence two.';
        const ranges = getProtectedRanges(text);
        const emphasis = ranges.filter(range => range.kind === 'emphasis');

        expect(emphasis).toHaveLength(1);
        expect(text.slice(emphasis[0].start, emphasis[0].end))
            .toBe('*Escaped \\* here. Sentence one.*');
        expect(isOffsetProtected(text.indexOf(' Sentence one.'), ranges)).toBe(true);
    });

    describe('backslash parity', () => {
        // `\*` is a literal asterisk; `\\*` is a literal backslash followed by a
        // live delimiter. Only an odd run escapes. @see docs/RATIONALE.md#SEG-07
        const BS = String.fromCharCode(92);

        it.each([
            [0, true],
            [1, false],
            [2, true],
            [3, false],
            [4, true],
        ])('%i backslashes before the opener → emphasis recognised: %s', (count, recognised) => {
            const text = `He said ${BS.repeat(count)}*one. two* aloud.`;
            const emphasis = getProtectedRanges(text).filter(range => range.kind === 'emphasis');

            expect(emphasis.length > 0).toBe(recognised);
        });

        it.each([
            [0, true],
            [1, false],
            [2, true],
        ])('%i backslashes before the closer → closes there: %s', (count, closesHere) => {
            const text = `*one. two${BS.repeat(count)}* and *more here*`;
            const emphasis = getProtectedRanges(text).filter(range => range.kind === 'emphasis');
            const firstSpan = text.slice(emphasis[0].start, emphasis[0].end);

            // When the closer is escaped the span runs on to a later delimiter,
            // which over-protects — the safe direction.
            expect(firstSpan === `*one. two${BS.repeat(count)}*`).toBe(closesHere);
        });

        it('keeps the cut after an even-run delimiter available', () => {
            const text = `A backslash ${BS}${BS}*and emphasis* here. Then more.`;

            expect(offersCutBefore(text, 'Then more')).toBe(true);
            expect(isOffsetProtected(text.indexOf('and emphasis'), getProtectedRanges(text))).toBe(true);
        });
    });

    it('protects a bold-italic run to its last delimiter', () => {
        const text = '***Both at once. And again.*** After the run.';
        const ranges = getProtectedRanges(text);

        expect(isOffsetProtected(text.indexOf(' And again'), ranges)).toBe(true);
        // A `**` match alone would end here and leave the third asterisk adrift.
        expect(isOffsetProtected(text.indexOf('*** After') + 2, ranges)).toBe(true);
        // No cut is offered anywhere in this message: UAX #29 puts its breaks
        // before the closing delimiters, and those offsets are all protected.
        expect(offsets(text)).toEqual([]);
    });

    it('protects a span whose text ends in punctuation', () => {
        const text = '**Stop! Now.** Then go.';
        const ranges = getProtectedRanges(text);

        expect(isOffsetProtected(text.indexOf(' Now.'), ranges)).toBe(true);
    });

    it('does not let an unclosed delimiter swallow the rest of the message', () => {
        const text = 'He said *something odd.\n\nThen he left. She stayed.';
        const ranges = getProtectedRanges(text);

        expect(ranges.filter(range => range.kind === 'emphasis')).toEqual([]);
        expect(offersCutBefore(text, 'She stayed')).toBe(true);
    });
});

describe('link protection', () => {
    // @see docs/RATIONALE.md#SEG-09
    it('protects an inline link', () => {
        const text = 'See [the map. it helps](http://example.test/a). Then go.';

        expect(isOffsetProtected(text.indexOf(' it helps'), getProtectedRanges(text))).toBe(true);
        expect(offersCutBefore(text, 'Then go')).toBe(true);
    });

    it.each([
        ['full reference', 'See [the map. it helps][map]. Then go.'],
        ['collapsed reference', 'See [the map. it helps][]. Then go.'],
    ])('protects a %s link', (_label, text) => {
        expect(isOffsetProtected(text.indexOf(' it helps'), getProtectedRanges(text))).toBe(true);
    });

    it('protects a reference definition line', () => {
        const text = 'Intro.\n\n[map]: http://example.test/a "A map. Of sorts."\n\nOutro.';
        const ranges = getProtectedRanges(text).filter(range => range.kind === 'link-definition');

        expect(ranges).toHaveLength(1);
        expect(text.slice(ranges[0].start, ranges[0].end))
            .toBe('[map]: http://example.test/a "A map. Of sorts."');
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

    it('keeps a continuation paragraph belonging to an item inside the run', () => {
        // The blank line does not end the list: the indented paragraph below it
        // is still part of the first item.
        const text = '- First paragraph.\n\n  Continuation sentence. Another sentence.\n- Second item\n\nAfter.';
        const ranges = getProtectedRanges(text).filter(range => range.kind === 'list');

        expect(ranges).toHaveLength(1);
        expect(text.slice(ranges[0].start, ranges[0].end))
            .toBe('- First paragraph.\n\n  Continuation sentence. Another sentence.\n- Second item');
        expect(isOffsetProtected(text.indexOf(' Another sentence'), getProtectedRanges(text))).toBe(true);
    });

    it('leaves the boundary at the edge of the list available', () => {
        // Protection is a strict-inequality test, so a cut exactly at either end
        // of the run is still legal — the same trade as a fenced code block.
        const text = 'Pack this:\n\n- rope\n- flint\n\nThen go.';
        const listEnd = text.indexOf('- flint') + '- flint'.length;

        expect(isOffsetProtected(listEnd, getProtectedRanges(text))).toBe(false);
    });
});
