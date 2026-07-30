/**
 * Shared constants for the Intercede extension.
 */

export const MODULE_NAME = 'intercede';

/** Key used with setExtensionPrompt() for the one-generation suffix instruction. */
export const EXTENSION_PROMPT_KEY = 'INTERCEDE';

/** localStorage key for the crash-recovery journal. */
export const JOURNAL_KEY = 'intercede_journal_v1';

/** Property name inside chatMetadata for compact transaction records. */
export const METADATA_KEY = 'intercede';

/** Prefix for vault (localforage) keys: intercede:<chatId>:<transactionId> */
export const VAULT_PREFIX = 'intercede';

export const SCHEMA_VERSION = 1;

export const REWRITE_MODES = Object.freeze({
    PRESERVE: 'preserve',
    ADAPTIVE: 'adaptive',
    REIMAGINE: 'reimagine',
});

export const REWRITE_MODE_LABELS = Object.freeze({
    preserve: 'Preserve closely',
    adaptive: 'Adapt naturally',
    reimagine: 'Reimagine remainder',
});

export const TX_STATE = Object.freeze({
    IDLE: 'idle',
    SELECTING: 'selecting',
    ARMED: 'armed',
    SNAPSHOTTED: 'snapshotted',
    MUTATED: 'mutated',
    GENERATING: 'generating',
    VALIDATING: 'validating',
    COMMITTED: 'committed',
    ROLLING_BACK: 'rolling-back',
    ROLLED_BACK: 'rolled-back',
});

/** Journal stage names (subset of the transaction lifecycle, written before/after risky steps). */
export const JOURNAL_STAGE = Object.freeze({
    ABOUT_TO_MUTATE: 'about-to-mutate',
    SNAPSHOTTED: 'snapshotted',
    PREFIX_APPLIED: 'prefix-applied',
    USER_INSERTED: 'user-inserted',
    GENERATION_STARTED: 'generation-started',
    GENERATION_RETURNED: 'generation-returned',
    COMMITTED: 'committed',
    ROLLED_BACK: 'rolled-back',
});

/** Custom events emitted through the SillyTavern eventSource for other extensions. */
export const INTERCEDE_EVENTS = Object.freeze({
    BEFORE_COMMIT: 'intercede_before_commit',
    COMMITTED: 'intercede_committed',
    ROLLED_BACK: 'intercede_rolled_back',
    INVALIDATED: 'intercede_invalidated',
    UNDONE: 'intercede_undone',
});

export const BOUNDARY_TYPES = Object.freeze({
    PARAGRAPH: 'paragraph',
    SENTENCE: 'sentence',
});

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    /** 'paragraph' = paragraph boundaries only; 'sentence' = paragraphs and sentences. */
    boundaries: 'sentence',
    defaultMode: REWRITE_MODES.ADAPTIVE,
    confirmBeforeCommit: true,
    compareAfterCommit: false,
    keepSnapshots: true,
    /** 0 = keep snapshots indefinitely. */
    snapshotTtlDays: 30,
    showButton: true,
    warnExtensions: true,
});

/** Anchor context window (characters kept on each side of the cut for rebasing). */
export const ANCHOR_CONTEXT_CHARS = 48;

/** Generation is abandoned (and rolled back) after this many milliseconds without completion. */
export const GENERATION_TIMEOUT_MS = 10 * 60 * 1000;

/** A lease that was armed but never consumed expires after this long. */
export const LEASE_TTL_MS = 2 * 60 * 1000;
