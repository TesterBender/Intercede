/**
 * Error taxonomy (§5.7).
 *
 * The transaction distinguishes three outcomes, because rollback must behave
 * differently for each:
 *
 *   Error                   — an ordinary failure; rollback can restore exactly.
 *   RecoveryRequiredError   — ownership can no longer be proven. Nothing is
 *                             deleted, evidence (journal + vault) is preserved,
 *                             and the user is asked to decide.
 *   PreflightError          — nothing was mutated, so there is nothing to undo.
 */

export class RecoveryRequiredError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'RecoveryRequiredError';
        this.details = details;
    }
}

export class PreflightError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PreflightError';
    }
}

export function isRecoveryRequired(error) {
    return error instanceof RecoveryRequiredError;
}
