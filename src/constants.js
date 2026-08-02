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

/**
 * Built-in rewrite-instruction presets, plus `CUSTOM` for a user-authored template.
 * The texts themselves live in `src/prompt-presets.js`.
 * @see docs/RATIONALE.md#PROMPT-02
 */
export const PROMPT_PRESETS = Object.freeze({
    SCENE_NOTES: 'scene-notes',
    DIRECT: 'direct',
    TERSE: 'terse',
    CUSTOM: 'custom',
});

export const TX_STATE = Object.freeze({
    ARMED: 'armed',
    SNAPSHOTTED: 'snapshotted',
    MUTATED: 'mutated',
    GENERATING: 'generating',
    VALIDATING: 'validating',
    COMMITTING: 'committing',
    COMMITTED: 'committed',
    ROLLING_BACK: 'rolling-back',
    ROLLED_BACK: 'rolled-back',
    RECOVERY_REQUIRED: 'recovery-required',
});

/** Journal stage names (subset of the transaction lifecycle, written before/after risky steps). */
export const JOURNAL_STAGE = Object.freeze({
    ABOUT_TO_MUTATE: 'about-to-mutate',
    SNAPSHOTTED: 'snapshotted',
    PREFIX_APPLIED: 'prefix-applied',
    USER_INSERTED: 'user-inserted',
    GENERATION_STARTED: 'generation-started',
    GENERATION_RETURNED: 'generation-returned',
    COMMITTING: 'committing',
    COMMITTED: 'committed',
    ROLLED_BACK: 'rolled-back',
    /** Ownership could not be proven. No automatic destructive action is allowed. */
    RECOVERY_REQUIRED: 'recovery-required',
});

/**
 * Stages after which the transaction owns nothing further.
 * @see docs/RATIONALE.md#JRN-03
 */
export const TERMINAL_JOURNAL_STAGES = Object.freeze([
    JOURNAL_STAGE.COMMITTED,
    JOURNAL_STAGE.ROLLED_BACK,
]);

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
    /** 'inline' = markers rendered on the live message; 'window' = floating reading overlay. */
    selectionInterface: 'inline',
    /** 'paragraph' = paragraph boundaries only; 'sentence' = paragraphs and sentences. */
    boundaries: 'sentence',
    defaultMode: REWRITE_MODES.ADAPTIVE,
    confirmBeforeCommit: true,
    compareAfterCommit: false,
    /** 0 = keep snapshots indefinitely. @see docs/RATIONALE.md#CFG-01 */
    snapshotTtlDays: 0,
    showButton: true,
    warnExtensions: true,
    /** Preset id, or PROMPT_PRESETS.CUSTOM to use `promptTemplate`. @see docs/RATIONALE.md#CFG-04 */
    promptPreset: PROMPT_PRESETS.SCENE_NOTES,
    /** Empty = the built-in text, never an empty prompt. @see docs/RATIONALE.md#CFG-04 */
    promptTemplate: '',
    promptModePreserve: '',
    promptModeAdaptive: '',
    promptModeReimagine: '',
    /**
     * Include the always-collected lifecycle event log in `/intercede diagnostics`.
     * Exposure, not collection. @see docs/RATIONALE.md#LEASE-14
     */
    debugLifecycle: false,
});

/** Anchor context window (characters kept on each side of the cut for rebasing). */
export const ANCHOR_CONTEXT_CHARS = 48;

/** Generation is abandoned (and rolled back) after this many milliseconds without completion. */
export const GENERATION_TIMEOUT_MS = 10 * 60 * 1000;

/** A lease that was armed but never consumed expires after this long. */
export const LEASE_TTL_MS = 2 * 60 * 1000;
