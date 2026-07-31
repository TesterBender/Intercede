/**
 * The rationale document is a set of pointers, and a pointer that no longer
 * resolves is worse than no pointer at all: it reads as a promise that the
 * reasoning was written down. These checks keep that promise mechanical.
 *
 * @see docs/RATIONALE.md — "How this document is organised"
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RATIONALE_PATH = path.join(ROOT, 'docs', 'RATIONALE.md');
const rationale = fs.readFileSync(RATIONALE_PATH, 'utf8');

const RULE_HEADING = /^### ([A-Z]{2,6}-\d{2}) — /gm;
const RULE_ANCHOR = /^<a id="([A-Z]{2,6}-\d{2})"><\/a>$/gm;
const POINTER = /RATIONALE\.md#([A-Z]{2,6}-\d{2})/g;
const CROSS_REF = /\[([A-Z]{2,6}-\d{2})\]/g;

const headingIds = [...rationale.matchAll(RULE_HEADING)].map(match => match[1]);
const anchorIds = new Set([...rationale.matchAll(RULE_ANCHOR)].map(match => match[1]));
const ruleIds = new Set(headingIds);

/** Every .js file the extension actually ships. */
function sourceFiles(dir = path.join(ROOT, 'src'), found = [path.join(ROOT, 'index.js')]) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) sourceFiles(full, found);
        else if (entry.name.endsWith('.js')) found.push(full);
    }
    return found;
}

const relative = file => path.relative(ROOT, file).replaceAll('\\', '/');

describe('rationale rule ids', () => {
    it('defines at least one rule', () => {
        expect(headingIds.length).toBeGreaterThan(0);
    });

    it('never reuses an id', () => {
        const seen = headingIds.filter((id, index) => headingIds.indexOf(id) !== index);
        expect(seen).toEqual([]);
    });

    // GitHub derives heading fragments from the full heading text, so
    // `#LEASE-05` only resolves because of the explicit anchor above it.
    it('gives every rule an explicit anchor', () => {
        expect(headingIds.filter(id => !anchorIds.has(id))).toEqual([]);
    });

    it('has no anchor without a rule', () => {
        const invariant = /^INV-\d{2}$/;
        const orphans = [...anchorIds].filter(id => !ruleIds.has(id) && !invariant.test(id));
        expect(orphans).toEqual([]);
    });
});

describe('rationale pointers', () => {
    it('resolves every @see pointer in the source', () => {
        const broken = [];
        for (const file of sourceFiles()) {
            const source = fs.readFileSync(file, 'utf8');
            for (const [, id] of source.matchAll(POINTER)) {
                if (!ruleIds.has(id)) broken.push(`${relative(file)} → ${id}`);
            }
        }
        expect(broken).toEqual([]);
    });

    it('resolves every cross-reference inside the document', () => {
        const invariant = /^INV-\d{2}$/;
        const broken = [...rationale.matchAll(CROSS_REF)]
            .map(match => match[1])
            .filter(id => !ruleIds.has(id) && !invariant.test(id));
        expect([...new Set(broken)]).toEqual([]);
    });

    // A rule nothing points at is either dead or documenting behaviour that
    // was deleted. PROMPT-01 is the deliberate exception: src/prompt.js is
    // fenced off and carries no pointers by policy.
    it('leaves no rule unreachable from the source', () => {
        const cited = new Set();
        for (const file of sourceFiles()) {
            for (const [, id] of fs.readFileSync(file, 'utf8').matchAll(POINTER)) cited.add(id);
        }
        const exempt = new Set(['PROMPT-01']);
        expect([...ruleIds].filter(id => !cited.has(id) && !exempt.has(id))).toEqual([]);
    });
});
