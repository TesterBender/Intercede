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

import { JOURNAL_KEY, SCHEMA_VERSION, TERMINAL_JOURNAL_STAGES, VAULT_PREFIX } from './constants.js';
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

/**
 * Best-effort write, used where a failure is not worth aborting for (enriching
 * an already-committed record). The cache is still only populated after the
 * durable write resolves.
 */
export async function vaultPut(key, record) {
    const value = { schemaVersion: SCHEMA_VERSION, ...record };
    await getStore().setItem(key, value);
    cache.set(key, value);
    return value;
}

/**
 * Durable write with round-trip verification (§7.3, INV-07).
 *
 * Order matters. The cache must never be populated before the backend confirms,
 * or a quota failure leaves a phantom record that reads as present until the
 * page is reloaded — at which point the snapshot the user was promised is gone.
 * A backend that resolves without persisting is caught by reading the value
 * back.
 */
export async function vaultPutStrict(key, record) {
    const value = { schemaVersion: SCHEMA_VERSION, ...record };

    let roundTrip = null;
    try {
        await getStore().setItem(key, value);
        roundTrip = await getStore().getItem(key);
    } catch (error) {
        cache.delete(key);
        throw new Error(`Snapshot vault write failed: ${error?.message ?? error}`);
    }

    if (!roundTrip
        || roundTrip.transactionId !== value.transactionId
        || roundTrip.schemaVersion !== value.schemaVersion) {
        cache.delete(key);
        throw new Error('Snapshot vault verification failed: the record could not be read back.');
    }

    cache.set(key, roundTrip);
    return roundTrip;
}

/** Delete that reports failure instead of swallowing it. */
export async function vaultDeleteStrict(key) {
    await getStore().removeItem(key);
    cache.delete(key);
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
 *
 * A committed record that has not been explicitly finalized is the only copy of
 * the message Undo restores, so age alone must never remove it (IC-P1-004,
 * INV-10). Use finalizeVaultRecord() to give up undo deliberately.
 *
 * @returns {Promise<number>} number of records removed
 */
export async function cleanupVault(ttlDays) {
    if (!ttlDays || ttlDays <= 0) return 0;
    const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const key of await vaultKeys()) {
        const record = await vaultGet(key);
        if (!record?.createdAt || record.createdAt >= cutoff) continue;
        if (record.state === 'committed' && !record.finalizedAt) continue;

        await vaultDelete(key);
        removed++;
    }
    return removed;
}

/** True when the snapshot behind a committed transaction is still available. */
export async function vaultRecordExists(key) {
    if (!key) return false;
    return Boolean(await vaultGet(key));
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

// --- Strict variants, used on every path that precedes canonical mutation ----
//
// The journal is the only thing standing between a crash mid-transaction and an
// unrecoverable chat. A write that silently failed is worse than no journal at
// all, because the transaction proceeds believing it is protected. These throw.

/** True when this entry represents a transaction that still owns chat state. */
function isUnrecovered(entry) {
    return Boolean(entry) && !TERMINAL_JOURNAL_STAGES.includes(entry.stage);
}

/**
 * Write the journal, verifying it can be read back.
 *
 * There is a single journal slot for the whole application, so starting a
 * transaction would otherwise destroy an unrecovered record belonging to a
 * different chat and make that chat unrecoverable. Refuse instead — the caller
 * aborts before touching any message.
 */
export function writeJournalStrict(entry) {
    const existing = readJournal();
    if (isUnrecovered(existing) && existing.transactionId !== entry.transactionId) {
        throw new Error(
            `An unrecovered intercession (${existing.stage}) from chat "${existing.chatId}" is still journaled. Recover or dismiss it before starting another.`,
        );
    }

    const serialized = JSON.stringify(entry);
    try {
        localStorage.setItem(JOURNAL_KEY, serialized);
    } catch (error) {
        throw new Error(`Recovery journal could not be written: ${error?.message ?? error}`);
    }

    if (localStorage.getItem(JOURNAL_KEY) !== serialized) {
        throw new Error('Recovery journal verification failed.');
    }
}

export function updateJournalStrict(patch) {
    const current = readJournal();
    if (!current) {
        throw new Error('Recovery journal is missing — the transaction can no longer prove its state.');
    }

    const next = { ...current, ...patch };
    const serialized = JSON.stringify(next);
    try {
        localStorage.setItem(JOURNAL_KEY, serialized);
    } catch (error) {
        throw new Error(`Recovery journal could not be updated: ${error?.message ?? error}`);
    }

    if (localStorage.getItem(JOURNAL_KEY) !== serialized) {
        throw new Error('Recovery journal verification failed.');
    }
}

export function clearJournalStrict() {
    localStorage.removeItem(JOURNAL_KEY);
    if (localStorage.getItem(JOURNAL_KEY) !== null) {
        throw new Error('Recovery journal could not be cleared.');
    }
}
