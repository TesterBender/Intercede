/**
 * Advisory quality heuristics.
 *
 * None of these can roll a transaction back or edit prose, so the only way they
 * can do damage is by crying wolf: a warning on a perfectly good continuation
 * teaches the user to dismiss the next one unread. The false-positive cases
 * below are therefore the point of this file, not padding around it.
 *
 * @see docs/RATIONALE.md#VAL-05
 * @see docs/RATIONALE.md#VAL-01
 */

import { describe, expect, it } from 'vitest';
import {
    computePreservation,
    describeMetaCommentary,
    detectMetaCommentary,
    detectPrefixOverlap,
    qualityWarnings,
} from '../src/validator.js';

describe('meta-commentary — what it must catch', () => {
    it.each([
        ['assistant register', 'As an AI, I should note the scene continues.', 'as-an-ai'],
        ['first-person rewrite', 'I have rewritten the passage to fit your reply.', 'first-person-rewrite'],
        ['contracted first person', "I've revised this scene as asked.", 'first-person-rewrite'],
        ['prompt vocabulary', 'The scene notes said she would leave.', 'scene-notes'],
        ['prompt vocabulary', 'That was planning material, not events.', 'planning-material'],
        ['internal vocabulary', 'The discarded suffix has been adapted.', 'discarded-suffix'],
        ['internal vocabulary', 'Here is the rewritten continuation.', 'rewritten-continuation'],
        ['internal vocabulary', "Following the user's insertion, the scene resumes.", 'user-insertion'],
    ])('flags %s', (_label, text, expected) => {
        expect(describeMetaCommentary(text)).toBe(expected);
    });
});

describe('meta-commentary — what it must not catch', () => {
    /**
     * Both of these fired on ordinary in-character prose in a live session and
     * were removed. They are kept here as the regression, not as trivia.
     */
    it.each([
        ['orders acknowledged in character', 'Per your instructions, my lord, the gate is sealed.'],
        ['a writer in the scene', 'She read the original draft aloud, then burned it.'],
        ['ordinary narration', 'He continued the response he had been drafting for hours.'],
        ['the word rewrite in scene', 'The scribe would rewrite the whole ledger by dawn.'],
        ['notes as objects in the world', 'She left notes across the table, a scene of quiet panic.'],
        ['an AI character described from outside', 'The machine spoke as an oracle, not as an equal.'],
    ])('stays quiet on %s', (_label, text) => {
        expect(detectMetaCommentary(text)).toBe(false);
    });

    it('carries a label rather than the matched prose', () => {
        const label = describeMetaCommentary('As an AI, I cannot describe what happened next.');
        expect(label).toBe('as-an-ai');
        expect(label).not.toMatch(/cannot describe/);
    });
});

describe('warnings are advisory, and say so', () => {
    const base = {
        prefix: 'She set the cup down and waited for an answer.',
        insertion: 'I already told you what I saw that night.',
        suffix: 'He said nothing at all, and the room grew colder.',
        mode: 'adaptive',
    };

    it('asks for a read-through rather than implying corruption', () => {
        const { warnings, meta } = qualityWarnings({
            ...base,
            generated: 'As an AI, I have rewritten the passage for you.',
        });

        expect(meta).toBe('as-an-ai');
        expect(warnings.some(warning => /re-reading/.test(warning))).toBe(true);
        expect(warnings.join(' ')).not.toMatch(/corrupt|invalid|failed/i);
    });

    it('returns no meta label for a clean continuation', () => {
        const { warnings, meta } = qualityWarnings({
            ...base,
            generated: 'He turned away, unwilling to admit she had been right.',
        });

        expect(meta).toBeNull();
        expect(warnings).toEqual([]);
    });
});

describe('exact repetition is detected; ambiguity stays visible', () => {
    it('reports a continuation that re-opens with the tail of the prefix', () => {
        const prefix = 'The corridor ran on far past the last of the working lights.';
        const overlap = detectPrefixOverlap(prefix, 'past the last of the working lights. She kept walking.');

        expect(overlap).not.toBeNull();
        expect(overlap.overlapChars).toBeGreaterThanOrEqual(30);
    });

    it('ignores an overlap too short to be a repetition', () => {
        expect(detectPrefixOverlap('She waited by the door.', 'She waited for the kettle.')).toBeNull();
    });

    // An overlapping continuation is reported, never silently trimmed:
    // the text the user gets is exactly the text the model produced.
    it('warns about near-identical output instead of editing it', () => {
        const suffix = 'He said nothing at all, and the room grew colder by the minute.';
        const { warnings, preservation } = qualityWarnings({
            prefix: 'She set the cup down.',
            insertion: 'Say something, please.',
            suffix,
            generated: suffix,
            mode: 'adaptive',
        });

        expect(preservation).toBe(100);
        expect(warnings.some(warning => /nearly identical/.test(warning))).toBe(true);
    });

    it('scores preservation as overlap, not as a verdict', () => {
        expect(computePreservation('one two three four', 'one two three four')).toBe(100);
        expect(computePreservation('one two three four', 'nothing alike whatsoever here')).toBe(0);
    });
});
