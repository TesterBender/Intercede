/**
 * The documentation is now a set of pages that point at each other, and a
 * pointer that no longer resolves is worse than no pointer at all: it reads as
 * a promise that the answer was written down. Same reasoning as
 * tests/rationale.test.js, applied to the prose instead of the rules.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every Markdown file the repository publishes. */
function markdownFiles(dir = ROOT, found = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) markdownFiles(full, found);
        else if (entry.name.endsWith('.md')) found.push(full);
    }
    return found;
}

const relative = file => path.relative(ROOT, file).replaceAll('\\', '/');

/** Code blocks are full of bracket-and-paren text that is not a link. */
function prose(markdown) {
    return markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

/**
 * GitHub's heading fragment: lowercased, punctuation dropped, spaces hyphenated.
 * Explicit `<a id="…">` anchors keep their case, which is how the rule ids resolve.
 */
function headingSlug(heading) {
    return heading.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-');
}

function anchorsIn(markdown) {
    const body = prose(markdown);
    const anchors = new Set();
    for (const [, id] of body.matchAll(/<a id="([^"]+)"><\/a>/g)) anchors.add(id);
    for (const [, heading] of body.matchAll(/^#{1,6}\s+(.+)$/gm)) anchors.add(headingSlug(heading));
    return anchors;
}

const files = markdownFiles();
const anchorCache = new Map();

function anchorsFor(file) {
    if (!anchorCache.has(file)) anchorCache.set(file, anchorsIn(fs.readFileSync(file, 'utf8')));
    return anchorCache.get(file);
}

/** Every internal link, resolved against the file it was written in. */
function internalLinks() {
    const links = [];
    for (const file of files) {
        for (const [, target] of prose(fs.readFileSync(file, 'utf8')).matchAll(LINK)) {
            if (/^(https?:|mailto:)/i.test(target)) continue;
            const [pathPart, fragment] = target.split('#');
            links.push({
                file,
                target,
                fragment,
                // A bare "#anchor" points inside the file it is written in.
                resolved: pathPart ? path.resolve(path.dirname(file), pathPart) : file,
            });
        }
    }
    return links;
}

const links = internalLinks();

describe('documentation links', () => {
    it('finds links to check', () => {
        expect(links.length).toBeGreaterThan(0);
    });

    it('resolves every linked file', () => {
        const broken = links
            .filter(link => !fs.existsSync(link.resolved))
            .map(link => `${relative(link.file)} → ${link.target}`);
        expect(broken).toEqual([]);
    });

    it('resolves every linked anchor', () => {
        const broken = links
            .filter(link => link.fragment && fs.existsSync(link.resolved))
            .filter(link => link.resolved.endsWith('.md'))
            .filter(link => !anchorsFor(link.resolved).has(link.fragment))
            .map(link => `${relative(link.file)} → ${link.target}`);
        expect(broken).toEqual([]);
    });

    // A page nothing links to is a page nobody finds.
    it('leaves no documentation page unreachable', () => {
        const linked = new Set(links.map(link => link.resolved));
        const orphans = files
            .filter(file => relative(file).startsWith('docs/'))
            .filter(file => !linked.has(file))
            .map(relative);
        expect(orphans).toEqual([]);
    });
});
