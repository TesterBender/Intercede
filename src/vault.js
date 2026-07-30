/**
 * Discarded-suffix vault (§13.2) and crash-recovery journal (§19).
 *
 * The vault holds large snapshots (the complete original message object, the
 * discarded suffix, anchors) in browser-side storage, keyed
 * `intercede:<chatId>:<transactionId>`, keeping canonical chat metadata small.
 *
 * The journal is a tiny synchronous localStorage record written before and after
 * every risky step, so a refresh or crash mid-transaction can be detected and
 * recovered on the next load.
 */

import { JOURNAL_KEY, SCHEMA_VERSION, VAULT_PREFIX } from './constants.js';
import { getStorageBackend } from './stcontext.js';

let store = null;
function getStore() {
    if (!store) store = getStorageBackend();
    return store;
}

/** In-memory cache so the generation-lease path can read records without awaiting IndexedDB. */
const cache = new Map();

export function vaultKeyFor(chatId, transactionId) {
    return `${VAULT_PREFIX}:${chatId}:${transactionId}`;
}

/**
 * @typedef {object} VaultRecord
 * @property {number} schemaVersion
 * @property {string} transactionId
 * @property {string} chatId
 * @property {number} targetIndex
 * @property {object} completeOriginalMessage structuredClone of the pre-mutation message
 * @property {string} discardedSuffix
 * @property {string} prefix
 * @property {string} insertion
 * @property {string} rewriteMode
 * @property {object} anchor
 * @property {number} createdAt
 * @property {string} [revisedSuffix] filled in at commit
 */

export async function vaultPut(key, record) {
    const value = { schemaVersion: SCHEMA_VERSION, ...record };
    cache.set(key, value);
    await getStore().setItem(key, value);
    return value;
}

export async function vaultGet(key) {
    if (cache.has(key)) return cache.get(key);
    try {
        const value = await getStore().getItem(key);
        if (value) cache.set(key, value);
        return value ?? null;
    } catch {
        return null;
    }
}

/** Synchronous cache-only read for hot paths (GENERATION_STARTED handlers). */
export function vaultGetCached(key) {
    return cache.get(key) ?? null;
}

export async function vaultDelete(key) {
    cache.delete(key);
    try {
        await getStore().removeItem(key);
    } catch { /* non-fatal */ }
}

export async function vaultKeys() {
    try {
        const keys = await getStore().keys();
        return keys.filter(key => key.startsWith(VAULT_PREFIX + ':'));
    } catch {
        return [];
    }
}

/**
 * Delete vault records older than ttlDays. ttlDays <= 0 keeps everything.
 * @returns {Promise<number>} number of records removed
 */
export async function cleanupVault(ttlDays) {
    if (!ttlDays || ttlDays <= 0) return 0;
    const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const key of await vaultKeys()) {
        const record = await vaultGet(key);
        if (record?.createdAt && record.createdAt < cutoff) {
            await vaultDelete(key);
            removed++;
        }
    }
    return removed;
}

// ---------------------------------------------------------------------------
// Recovery journal
// ---------------------------------------------------------------------------

/**
 * @typedef {object} JournalEntry
 * @property {string} transactionId
 * @property {string} chatId
 * @property {string} stage one of JOURNAL_STAGE
 * @property {string} vaultKey
 * @property {number} targetIndex
 * @property {string} expectedTargetHash hash of the original message text
 * @property {number} startedAt
 */

export function readJournal() {
    try {
        const raw = localStorage.getItem(JOURNAL_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

export function writeJournal(entry) {
    try {
        localStorage.setItem(JOURNAL_KEY, JSON.stringify(entry));
    } catch { /* storage full — journal is best-effort */ }
}

export function updateJournal(patch) {
    const current = readJournal();
    if (!current) return;
    writeJournal({ ...current, ...patch });
}

export function clearJournal() {
    try {
        localStorage.removeItem(JOURNAL_KEY);
    } catch { /* ignore */ }
}
