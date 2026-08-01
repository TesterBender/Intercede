/**
 * Generation-lifecycle adapter: what the host actually emits.
 *
 * `tests/lease.test.js` pins the counting rules. This file pins the *host
 * contract* they are counting against — how a start type is classified, what a
 * slash-command-aborted generation looks like, and the single reconciled
 * snapshot that eligibility and diagnostics both read.
 *
 * @see docs/RATIONALE.md#LEASE-13 start-kind classification
 * @see docs/RATIONALE.md#LEASE-15 slash-command aborted starts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    emitHostSlashCommand,
    emitHostStart,
    freshModules,
    installFakeSillyTavern,
    uninstallFakeSillyTavern,
} from './helpers/fake-context.js';

async function setup() {
    vi.resetModules();
    const harness = installFakeSillyTavern();
    const modules = await freshModules();
    modules.lease.initLease();
    return { ...harness, ...modules };
}

beforeEach(() => {
    uninstallFakeSillyTavern();
});

/**
 * `Generate(type)` leaves `type` undefined for an ordinary send, so absence is
 * `normal` by the host's own contract. Everything the contract does not cover is
 * opaque — calling an unrecognised value a kind is how a foreign generation gets
 * mistaken for the intended one.
 */
describe('start-kind classification', () => {
    const cases = [
        ['undefined (an ordinary send)', undefined, 'normal', 'defaulted'],
        ['an empty string', '', 'normal', 'defaulted'],
        ['an explicit "normal"', 'normal', 'normal', 'named'],
        ['a quiet generation', 'quiet', 'quiet', 'named'],
        ['a swipe', 'swipe', 'swipe', 'named'],
        ['an unknown string', 'telemetry_probe', 'unknown', 'opaque'],
        ['an integer', 42, 'unknown', 'opaque'],
        ['an object', { type: 'quiet' }, 'unknown', 'opaque'],
    ];

    it.each(cases)('classifies %s', async (_label, payload, kind, kindSource) => {
        const { ctx, lease } = await setup();

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, payload, {}, false);

        const [record] = lease.getGenerationSnapshot({ reconcile: false }).openAfter;
        expect(record).toMatchObject({ kind, kindSource });
    });

    // The dangerous direction: an unclassifiable generation must never be
    // allowed to consume a lease armed for a normal one.
    it('never lets an opaque start claim the lease', async () => {
        const { ctx, lease } = await setup();
        lease.armLease({ transactionId: 'tx', prompt: 'REWRITE', chatId: 'chat-1' });

        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'telemetry_probe', {}, false);

        expect(lease.isLeaseArmed()).toBe(false);
        expect(ctx.setExtensionPrompt.mock.calls.at(-1)?.[1]).toBe('');
        expect(lease.getLeaseReceipt('tx')).toMatchObject({ applied: false });
        expect(lease.getLeaseReceipt('tx').interferingStarts).toHaveLength(1);
    });
});

/**
 * Typing `/intercede …` reaches `Generate()`, which emits GENERATION_STARTED
 * *before* running slash commands and then returns without ever showing the stop
 * button — so neither GENERATION_AFTER_COMMANDS nor GENERATION_ENDED arrives.
 */
describe('slash-command aborted starts', () => {
    it('confirms a start that survives command processing', async () => {
        const { ctx, lease } = await setup();

        await emitHostStart(ctx);

        const [record] = lease.getGenerationSnapshot({ reconcile: false }).openAfter;
        expect(record.confirmed).toBe(true);
        expect(lease.getLeaseDiagnostics().events.confirmedStarts).toBe(1);
    });

    it('leaves a command-aborted start unconfirmed and open', async () => {
        const { ctx, lease } = await setup();

        await emitHostSlashCommand(ctx);

        const snapshot = lease.getGenerationSnapshot({ reconcile: false });
        expect(snapshot.openAfter).toHaveLength(1);
        expect(snapshot.openAfter[0]).toMatchObject({ kind: 'normal', confirmed: false });
        expect(lease.getLeaseDiagnostics().events.confirmedStarts).toBe(0);
    });

    it('reconciles the abandoned start away once the host answers idle', async () => {
        const { ctx, lease } = await setup();

        await emitHostSlashCommand(ctx);
        ctx.isGenerating = false;

        const diagnostics = lease.getLeaseDiagnostics();
        expect(diagnostics.openCount).toBe(0);
        expect(diagnostics.reconciledNow).toBe(1);
        expect(diagnostics.events.reconciledUnconfirmed).toBe(1);
    });

    // The acceptance criterion: repeated diagnostics must not climb.
    it('does not accumulate open records across repeated commands', async () => {
        const { ctx, lease } = await setup();
        ctx.isGenerating = false;

        const seen = [];
        for (let i = 0; i < 3; i++) {
            await emitHostSlashCommand(ctx, () => seen.push(lease.getLeaseDiagnostics().openCount));
        }

        expect(seen).toEqual([0, 0, 0]);
        expect(lease.getLeaseDiagnostics().openCount).toBe(0);
    });

    /**
     * The correctness failure the leak actually caused: a stale abandoned start
     * baselined as a live overlap, rejecting a perfectly good intercession.
     */
    it('does not baseline an abandoned start as an overlap', async () => {
        const { ctx, lease } = await setup();
        ctx.isGenerating = false;

        await emitHostSlashCommand(ctx);
        lease.armLease({ transactionId: 'tx', prompt: 'REWRITE', chatId: 'chat-1' });

        expect(lease.getLeaseReceipt('tx')).toMatchObject({
            baselineOpenGenerations: 0,
            baselineReconciled: 1,
        });

        await emitHostStart(ctx);

        expect(lease.getLeaseReceipt('tx')).toMatchObject({
            applied: true,
            matchingStarts: 1,
            promptIntegrityLost: false,
        });
        expect(ctx.setExtensionPrompt.mock.calls.at(-1)?.[1]).toBe('REWRITE');
    });

    // The protection that must survive the fix: a genuinely concurrent
    // generation still spoils prompt integrity. @see docs/RATIONALE.md#LEASE-04
    it('still detects a real overlap the host confirms is running', async () => {
        const { ctx, lease } = await setup();

        await emitHostStart(ctx, 'quiet');
        ctx.isGenerating = true;

        lease.armLease({ transactionId: 'tx', prompt: 'REWRITE', chatId: 'chat-1' });
        expect(lease.getLeaseReceipt('tx').baselineOpenGenerations).toBe(1);

        await emitHostStart(ctx);
        expect(lease.getLeaseReceipt('tx').promptIntegrityLost).toBe(true);
    });
});

/**
 * One probe, one reconciliation, one reported truth.
 * @see docs/RATIONALE.md#LEASE-10
 */
describe('generation snapshot', () => {
    it('reports the state left after reconciliation, not before it', async () => {
        const { ctx, lease } = await setup();

        await emitHostSlashCommand(ctx);
        ctx.isGenerating = false;

        const snapshot = lease.getGenerationSnapshot();
        expect(snapshot.openBefore).toHaveLength(1);
        expect(snapshot.openAfter).toHaveLength(0);
        expect(snapshot.reconciledNow).toBe(1);
        expect(snapshot.reason).toBe('host-idle-reconciled');
        expect(snapshot.active).toBe(false);
    });

    it('observes without dropping anything when asked not to reconcile', async () => {
        const { ctx, lease } = await setup();

        await emitHostSlashCommand(ctx);
        ctx.isGenerating = false;

        const snapshot = lease.getGenerationSnapshot({ reconcile: false });
        expect(snapshot.openAfter).toHaveLength(1);
        expect(snapshot.reconciledNow).toBe(0);
        expect(snapshot.reason).toBe('observation-only');
        expect(lease.getGenerationSnapshot({ reconcile: false }).openAfter).toHaveLength(1);
    });

    it('keeps records while a lease is armed, whatever the host says', async () => {
        const { ctx, lease } = await setup();

        await emitHostStart(ctx, 'quiet');
        lease.armLease({ transactionId: 'tx', prompt: 'p', chatId: 'chat-1' });
        ctx.isGenerating = false;

        const snapshot = lease.getGenerationSnapshot();
        expect(snapshot.openAfter).toHaveLength(1);
        expect(snapshot.reconciledNow).toBe(0);
        expect(snapshot.reason).toBe('lease-armed-records-kept');
    });

    // A signal that disagrees with itself is not evidence.
    it('refuses to reconcile on an unstable probe, and says so', async () => {
        const { ctx, lease } = await setup();

        await emitHostSlashCommand(ctx);

        let flip = false;
        Object.defineProperty(ctx, 'isGenerating', {
            get() { flip = !flip; return flip; },
            configurable: true,
        });

        const snapshot = lease.getGenerationSnapshot();
        expect(snapshot.host.stable).toBe(false);
        expect(snapshot.reconciledNow).toBe(0);
        expect(snapshot.reason).toBe('probe-unstable');
        expect(snapshot.openAfter).toHaveLength(1);
        // Unstable is not "idle": the records still decide.
        expect(snapshot.active).toBe(true);
    });

    it('lets the records decide when the host cannot answer', async () => {
        const { ctx, lease } = await setup();

        await emitHostStart(ctx);

        const snapshot = lease.getGenerationSnapshot();
        expect(snapshot.host.state).toBe('unknown');
        expect(snapshot.reason).toBe('host-cannot-answer-records-decide');
        expect(snapshot.active).toBe(true);
    });
});

/** @see docs/RATIONALE.md#LEASE-14 — counters are not safety state, and vice versa */
describe('diagnostic reset', () => {
    it('clears tallies and the log but no safety state', async () => {
        const { ctx, lease } = await setup();

        await emitHostStart(ctx, 'quiet');
        lease.armLease({ transactionId: 'tx', prompt: 'REWRITE', chatId: 'chat-1' });
        const sequenceBefore = lease.getGenerationStartSequence();

        const result = lease.resetLeaseTallies();

        expect(result.cleared.starts).toBe(1);
        expect(lease.getLeaseDiagnostics().events.starts).toBe(0);
        expect(lease.getLifecycleLog()).toEqual([]);

        // Everything a transaction in flight depends on survives.
        expect(lease.isLeaseArmed()).toBe(true);
        expect(lease.getGenerationSnapshot({ reconcile: false }).openAfter).toHaveLength(1);
        expect(lease.getGenerationStartSequence()).toBe(sequenceBefore);
        expect(lease.getLeaseReceipt('tx')).toBeTruthy();
    });
});

/** @see docs/RATIONALE.md#LEASE-14 — evidence without content */
describe('lifecycle log', () => {
    it('records argument shape without copying content out', async () => {
        const { ctx, lease } = await setup();
        const secret = 'Continue the scene where she finally admits everything.';

        await ctx.eventSource.emit(
            ctx.eventTypes.GENERATION_STARTED,
            'quiet',
            { quiet_prompt: secret, quietToLoud: false },
            false,
        );

        const log = lease.getLifecycleLog();
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({ event: 'GENERATION_STARTED', kind: 'quiet', openAfter: 1 });
        // The kind survives; the prompt does not appear anywhere.
        expect(log[0].args[0]).toEqual({ type: 'string', value: 'quiet' });
        expect(log[0].args[1]).toEqual({ type: 'object', keys: ['quiet_prompt', 'quietToLoud'] });
        expect(JSON.stringify(log)).not.toContain('admits everything');
        expect(JSON.stringify(log)).not.toContain(secret.slice(0, 20));
    });

    it('stays bounded', async () => {
        const { ctx, lease } = await setup();

        for (let i = 0; i < 80; i++) {
            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, undefined, {}, true);
        }

        expect(lease.getLifecycleLog().length).toBeLessThanOrEqual(64);
    });
});
