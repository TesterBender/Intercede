/**
 * Error taxonomy (§5.7).
 * @see docs/RATIONALE.md#ERR-01 — the three outcomes and why rollback differs
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
