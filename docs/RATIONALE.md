# Intercede — Design Rationale

Intercede rewrites canonical chat history. Almost every non-obvious line in this
codebase exists because some ordering, some host quirk, or some other extension can
turn a routine operation into silent data loss. This document holds that reasoning.

The source keeps only pointers. A line like

```js
// @see docs/RATIONALE.md#LEASE-05
```

means: before you change this, read that rule. If you change the behaviour, update the
rule. If you delete the behaviour, delete the rule.

## How this document is organised

Every rule has a stable ID (`LEASE-05`, `TX-08`). IDs are permanent — code points at
them, and other rules cross-reference them. Never renumber; retire an ID instead.

**Sites** name the file and symbol, not a line number, so they survive edits.

**Guards** names the invariant a rule enforces. The invariants are defined below, in this
document — nothing normative lives outside the repository.

**Related** links rules that constrain each other. Where two rules must be changed
together, they say so explicitly.

Every rule ID has an explicit HTML anchor, so `docs/RATIONALE.md#LEASE-05` resolves on
GitHub regardless of how the heading is later worded. Adding a rule means adding its
anchor; `tests/rationale.test.js` fails if one is missing, if an ID is duplicated, or if
any pointer — in the source or in this document — names a rule that does not exist.

## Authority

1. **Runtime behaviour and the test suite** establish what the code currently does.
2. **The invariants below** are the normative safety requirements. Code that violates one
   is wrong even if every test passes.
3. **Rationale rules** explain how the code upholds an invariant, and what breaks if it
   stops. They are descriptive of intent, not themselves normative.
4. **The original architecture document** is historical product context, not a
   specification of current behaviour.

Where these conflict, the lower number wins — except that a conflict between (1) and (2)
is a bug report, not a resolution.

## Invariants

Enumerated by the IDs the code and its rules actually reference. Gaps in the numbering
are invariants from the original specification that this codebase does not cite; they are
not omissions of anything the source depends on.

<a id="INV-02"></a>
**INV-02 — Structural validity before commit.** The three messages a transaction produces
must match their expected roles, order, and content before any record says the commit
happened. Structural mismatch is fatal; stylistic deficiency is not.
*Enforced by* [VAL-01](#VAL-01), [VAL-02](#VAL-02).

<a id="INV-03"></a>
**INV-03 — Identity, never position.** A message is identified by the event that
announced it and by object reference, never by its index in the chat array. Array
position is a coincidence that another extension can change at any time.
*Enforced by* [OWN-01](#OWN-01), [CAP-01](#CAP-01), [TX-05](#TX-05).

<a id="INV-04"></a>
**INV-04 — The preserved prefix is byte-identical.** Text above the cut must survive the
transaction unchanged, byte for byte. Anything that rewrites it — including a
well-meaning normalisation — has destroyed the thing the user chose to keep.
*Enforced by* [VAL-03](#VAL-03).

<a id="INV-05"></a>
**INV-05 — Nothing unprovable is deleted.** A message is removed only when the
transaction can prove it created it. Unprovable ownership stops the operation; it never
resolves to "probably ours".
*Enforced by* [TX-08](#TX-08), [REC-04](#REC-04).

<a id="INV-06"></a>
**INV-06 — Metadata is restored exactly.** After a failed transaction, chat metadata is
byte-identical to its pre-transaction state, including the case where the transaction's
own container did not previously exist.
*Enforced by* [TX-12](#TX-12).

<a id="INV-07"></a>
**INV-07 — Backup proven durable before mutation.** No canonical chat state is mutated
until the snapshot and journal that would undo it have been written *and read back*. A
write that was merely issued is not a backup.
*Enforced by* [VAULT-01](#VAULT-01), [JRN-01](#JRN-01).

<a id="INV-10"></a>
**INV-10 — An offered undo is deliverable.** Undo and Compare are shown only when the
snapshot behind them has been confirmed to exist, and automatic cleanup never deletes a
snapshot that can still be undone.
*Enforced by* [TX-15](#TX-15), [VAULT-02](#VAULT-02).

<a id="INV-11"></a>
**INV-11 — The instruction reaches exactly one generation.** The rewrite instruction is
present for the generation it was armed for and for no other — and its presence must hold
until that generation's prompt is assembled, not merely until it is installed.
*Enforced by* [LEASE-01](#LEASE-01), [LEASE-04](#LEASE-04), [LEASE-05](#LEASE-05).

<a id="INV-12"></a>
**INV-12 — Evidence outlives the failure.** Journal and snapshot survive any failure that
leaves canonical state modified, so a later session can finish or diagnose the job.
Declining a restore never discards the only copy of the original text.
*Enforced by* [JRN-02](#JRN-02), [TX-09](#TX-09), [REC-02](#REC-02).

---

# Transaction lifecycle — `TX-*`

The canonical shape of every intercession:

```
Original assistant message
    →  Assistant prefix  /  User insertion  /  Assistant revised suffix
```

<a id="TX-01"></a>
### TX-01 — Atomic three-message transaction
**Sites:** `src/transaction.js` › module header, `IntercedeTransaction.run()`
**Related:** [TX-08](#TX-08), [JRN-01](#JRN-01)

Every step is journaled; any failure restores the complete original message, its
swipes, and its metadata from the snapshot. Rollback is idempotent and refuses to touch
messages it cannot prove belong to the transaction.

<a id="TX-02"></a>
### TX-02 — `_mutated` gates rollback, not the snapshot
**Sites:** `src/transaction.js` › `IntercedeTransaction` constructor, `rollback()`
**Related:** [JRN-02](#JRN-02)

Rollback keys off whether canonical chat state was actually changed, not off whether a
snapshot exists. A transaction that aborted while arming its own journal must never
clear or restore state belonging to somebody else's unrecovered transaction.

<a id="TX-03"></a>
### TX-03 — Preconditions checked immediately before mutation
**Sites:** `src/transaction.js` › `preflight()`, `isEligibleTarget()`
**Related:** [LEASE-04](#LEASE-04), [ANC-02](#ANC-02)

Version-one eligibility: the latest, completed, non-system assistant message in a
non-group chat, while nothing is generating. A revised continuation left by an earlier
intercession qualifies like any other assistant message.

"While nothing is generating" is answered by the open-generation count
([LEASE-04](#LEASE-04)), not by a flag that the most recent event happened to set. This
check is the first line of defence against overlap, and the only one that stops it before
any mutation — but it is not the last, because several `await`s separate it from
`armLease()` and a generation can start inside that window.

<a id="TX-04"></a>
### TX-04 — Chained intercession
**Sites:** `src/transaction.js` › `getChainPosition()`, `getChainAncestry()`, `applyPrefix()`
**Related:** [OWN-02](#OWN-02), [TX-13](#TX-13)

Interceding the revised continuation of an earlier intercession is a normal operation:
the continuation is an ordinary assistant message that happens to carry a `suffix`
marker, and cutting it starts a new transaction whose prefix is that continuation.
`depth` counts how many intercessions deep the new one would be (0 = interceding a
message no intercession produced).

A chained target already carries its own marker, so `markOwnedMessage` keeps that
provenance beside the new one ([OWN-02](#OWN-02)) — the earlier transaction stays identifiable
from the message itself, not only from the snapshot that undo restores.

`getChainAncestry` walks `parentTransactionId` links and stops on a missing or repeated
link rather than looping.

<a id="TX-05"></a>
### TX-05 — Attribution before ownership is claimed
**Sites:** `src/transaction.js` › `generateSuffix()`
**Guards:** INV-03 **Related:** [LEASE-03](#LEASE-03), [CAP-01](#CAP-01), [CAP-05](#CAP-05)

Structural position is not enough when more than one matching generation ran: the
single message that arrived at the expected index may well be the other one's.
Attribution is therefore settled *before* anything is marked, so an unattributable
message is never claimed and never deleted.

The reply is attributable only when exactly one matching generation started and the
lease was applied at a sequence later than the one recorded before `generate()` was
called.

<a id="TX-06"></a>
### TX-06 — Claim whenever ownership is provable, including on failure
**Sites:** `src/transaction.js` › `generateSuffix()` (`finally` block)
**Related:** [TX-08](#TX-08)

Capture is finalised in `finally`, and ownership is claimed even when generation threw
afterwards. A message this transaction created must be removable by its own rollback,
or it is stranded in the chat — a backend that explodes after the reply lands would
otherwise leave three messages where two belong.

<a id="TX-07"></a>
### TX-07 — Emit `BEFORE_COMMIT`, then re-prove
**Sites:** `src/transaction.js` › `commit()`
**Guards:** INV-02 **Related:** [VAL-01](#VAL-01)

Listeners of `BEFORE_COMMIT` can mutate history, so nothing may be trusted across it.
Emit first, then validate ownership again before writing any record that says the
commit happened. A failure here is recovery-required, not a plain rollback: the chat
changed underneath a transaction that was already committing.

<a id="TX-08"></a>
### TX-08 — Selective rollback
**Sites:** `src/transaction.js` › `removeOwnedMessages()`, `rollback()`
**Guards:** INV-05 **Related:** [OWN-01](#OWN-01), [TX-06](#TX-06), [REC-04](#REC-04)

Each candidate must satisfy two independent proofs: the object reference captured when
the transaction created it is still present in the chat, *and* that object still carries
this transaction's marker in an expected role.

A reference that has already gone is fine — that is what makes repeated rollbacks
idempotent. A reference that is present but no longer marked is not fine, and stops the
rollback rather than removing a message somebody else may now own.

Deletion runs in descending index order so earlier indices stay valid.

<a id="TX-09"></a>
### TX-09 — Restored in memory but not on disk
**Sites:** `src/transaction.js` › `rollback()` (save failure branch)
**Guards:** INV-12 **Related:** [REC-01](#REC-01), [REC-02](#REC-02)

When the post-rollback save fails, the chat is correct in memory and wrong on disk. The
journal and vault must survive so the next load can finish the job. This escalates to
recovery-required with a persistent notice rather than reporting success.

<a id="TX-10"></a>
### TX-10 — Chat switched mid-transaction
**Sites:** `src/transaction.js` › `rollback()`
**Related:** [REC-05](#REC-05)

Never touch the active chat when the user has switched away. The journal stays behind so
recovery runs when the original chat is reopened.

<a id="TX-11"></a>
### TX-11 — The recovery-required latch
**Sites:** `src/transaction.js` › `recoveryRequired`, `enterRecoveryRequired()`, `isEligibleTarget()`
**Related:** [ERR-01](#ERR-01), [REC-01](#REC-01)

Set when a transaction could not prove ownership of its own messages. New intercessions
are blocked until the user resolves it, because starting another one on top of an
ambiguous chat compounds the problem.

Entering this state keeps every message, keeps the evidence, and hands the decision to
the user. Nothing is deleted.

<a id="TX-12"></a>
### TX-12 — Metadata snapshot must not materialise
**Sites:** `src/transaction.js` › `snapshotIntercedeMetadata()`, `restoreIntercedeMetadata()`, `readTransactions()`
**Guards:** INV-06

This deliberately does not go through `getMetaContainer()`, which materialises the
container as a side effect of reading. Whether the property existed at all is part of
the state being preserved: a chat that had no Intercede metadata must still have none
after a rollback.

<a id="TX-13"></a>
### TX-13 — Undo unwinds chains newest-first
**Sites:** `src/transaction.js` › `undoIntercession()`, `getCommittedTipRecord()`
**Related:** [TX-04](#TX-04), [TX-15](#TX-15)

Undo works only while the committed intercession is still the chat tail. Restoring the
snapshot puts back the message the cut was made in, marker and all — so if that message
was an earlier intercession's revised continuation, the tail becomes that intercession
again and undo can be run once more.

`getCommittedTipRecord` proves all three tail messages carry this transaction's markers,
which is what licenses deleting the two above the prefix without further checks.

On save failure the snapshot stays in the vault: the chat on disk still describes the
intercession, so undo must remain possible after a reload.

<a id="TX-14"></a>
### TX-14 — Finalize gives up undo deliberately
**Sites:** `src/transaction.js` › `finalizeIntercession()`
**Related:** [VAULT-02](#VAULT-02), [CFG-01](#CFG-01)

The canonical messages are left exactly as they are; only the ability to restore the
pre-intercession original is discarded. This is the sanctioned way to reclaim vault
space, and the only thing that lets age-based cleanup touch a committed record.

<a id="TX-15"></a>
### TX-15 — Offer undo only when it can be delivered
**Sites:** `src/transaction.js` › `canUndoTip()`; `src/ui/message-button.js` › `verifyUndoAvailability()`
**Guards:** INV-10 **Related:** [UI-08](#UI-08), [VAULT-02](#VAULT-02)

The metadata record alone is not enough: it names a vault key, and the snapshot behind
that key is what makes an exact undo possible. Offering the controls without checking
means the user learns the snapshot is gone only after clicking.

<a id="TX-17"></a>
### TX-17 — Generation is settled by event, not by promise
**Sites:** `src/transaction.js` › `generateSuffix()`
**Related:** [CAP-01](#CAP-01), [LEASE-04](#LEASE-04)

Some backends resolve the `generate()` promise slightly before the reply is appended to
the chat, so the transaction additionally waits for the generation to go inactive. Without
it, capture can finish before the message it was watching for arrives.

The wait is on `isGenerationActive()`, which counts *every* open generation ([LEASE-04](#LEASE-04)),
so a foreign generation overlapping ours makes it wait for that one too — up to its
timeout, after which it proceeds anyway. That is only reachable on a path already
destined to reject on `promptIntegrityLost`, so the cost is a delay before a failure, not
a delay before a commit.

<a id="TX-16"></a>
### TX-16 — Measure the proven message, never the tail
**Sites:** `src/transaction.js` › `validate()`
**Related:** [VAL-01](#VAL-01), [CAP-01](#CAP-01)

Quality heuristics run against `structure.suffixMessage` — the message ownership proved
we generated — not `chat[chat.length - 1]`. The tail may belong to another extension.

---

# Ownership — `OWN-*`

<a id="OWN-01"></a>
### OWN-01 — Two independent proofs
**Sites:** `src/ownership.js` › module header, `isOwnedMessage()`, `findOwned()`
**Guards:** INV-03 **Related:** [TX-08](#TX-08), [CAP-01](#CAP-01)

Array position is not proof. Another extension can append, insert, or reorder messages
while Intercede is generating, so every message the transaction intends to rewrite or
delete must be identifiable by two independent means: the object reference captured when
the transaction created it, and a marker written into `message.extra`.

<a id="OWN-02"></a>
### OWN-02 — Markers merge, never overwrite
**Sites:** `src/ownership.js` › `markOwnedMessage()`
**Related:** [TX-04](#TX-04), [OWN-03](#OWN-03)

A revised continuation can itself be interceded, so the message may already carry an
earlier transaction's marker. That earlier link is folded into `parent` rather than
discarded — undo relies on it to identify the intercession the current one was cut from.

Re-marking a message this transaction already owns (`suffix-pending` → `suffix`) keeps
whatever parent it had.

> A helper that replaced `extra[METADATA_KEY]` wholesale would silently break chained
> undo. This is the single most load-bearing line in the file.

<a id="OWN-03"></a>
### OWN-03 — Clearing a marker restores the link it displaced
**Sites:** `src/ownership.js` › `clearOwnedMarker()`
**Related:** [REC-03](#REC-03), [OWN-02](#OWN-02)

Used when an interrupted transaction is abandoned rather than restored: the messages
stay, but they must stop claiming to belong to a transaction that never completed. A
chained message goes back to advertising its parent, so the intercession below it
remains identifiable.

<a id="OWN-04"></a>
### OWN-04 — Expected and actual positions are compared, never assumed equal
**Sites:** `src/ownership.js` › `createOwnership()`
**Related:** [CAP-05](#CAP-05)

`expectedSuffixIndex` is where the continuation should land; `suffixIndex` is where it
actually landed, filled in by generation capture.

---

# Generation capture — `CAP-*`

<a id="CAP-01"></a>
### CAP-01 — Observed candidate ≠ owned message
**Sites:** `src/generation-capture.js` › module header, `beginAssistantCapture()`
**Guards:** INV-03 **Related:** [TX-05](#TX-05), [CAP-05](#CAP-05), [OWN-01](#OWN-01)

Taking `chat[chat.length - 1]` after generation is unsafe: another extension can append
between the reply landing and generation ending, and the tail is then somebody else's
message. Instead we watch the assistant-message event.

The event handler only records what it saw; **it writes nothing**. A candidate becomes
owned only once `proveGeneratedSuffix` has checked it against the transaction's expected
shape.

> Marking inside the handler would make the marker self-justifying — Intercede would tag
> the first assistant message to arrive, then later treat its own tag as evidence of
> ownership, which is exactly the inference INV-03 exists to forbid.

<a id="CAP-02"></a>
### CAP-02 — The one place coupled to a SillyTavern version
**Sites:** `src/generation-capture.js` › `getCaptureEventName()`, `normalizeMessageIndex()`
**Related:** [HOST-04](#HOST-04)

The event name and payload shape are the only host-version coupling in this file. If
1.18.x differs from the normalisation here, fix it *here* and record the observed payload
in tests — **never** by relaxing the ownership proof downstream.

> Unverified against a live 1.18.x profile. See "Open questions" at the end.

<a id="CAP-03"></a>
### CAP-03 — Payload normalisation accepts several shapes
**Sites:** `src/generation-capture.js` › `normalizeMessageIndex()`

SillyTavern has passed the message id as a bare integer historically; some builds pass an
object. Accept both, and fall back to identity lookup.

<a id="CAP-04"></a>
### CAP-04 — Untyped builds are treated as ordinary generation
**Sites:** `src/generation-capture.js` › capture handler
**Related:** [LEASE-08](#LEASE-08)

Builds that pass no generation type are treated as `normal` rather than filtered out, so
capture does not silently observe nothing. The same message announced twice is one
candidate, not two.

<a id="CAP-05"></a>
### CAP-05 — The proof is structural only, by design
**Sites:** `src/generation-capture.js` › `proveGeneratedSuffix()`
**Related:** [TX-05](#TX-05), [LEASE-05](#LEASE-05)

This answers "is this message the one this transaction created?" — not "was it generated
with the right instruction", which the lease receipt answers separately.

Keeping them apart matters for rollback: a continuation produced without the rewrite
prompt is still *ours* to remove, whereas an ambiguous tail is nobody's to touch.

Promotion requires all of: exactly one candidate, the chat at its expected length, the
candidate at its expected index, reference identity still holding, and an assistant role.

---

# One-generation lease — `LEASE-*`

The suffix-revision instruction must reach exactly one generation: ours.

<a id="LEASE-01"></a>
### LEASE-01 — The instruction cannot leak
**Sites:** `src/lease.js` › module header, `onGenerationStarted()`
**Guards:** INV-11 **Related:** [LEASE-07](#LEASE-07), [PROMPT-01](#PROMPT-01)

The instruction is installed only from inside a `GENERATION_STARTED` handler whose type,
chat, and timing match an explicitly armed lease — and cleared again on every generation
end, stop, chat change, and in the caller's `finally`. It therefore cannot leak into
summaries, quiet prompts, impersonation, or any later unrelated generation.

<a id="LEASE-02"></a>
### LEASE-02 — The audit outlives the lease
**Sites:** `src/lease.js` › `leaseAudit`, `getLeaseReceipt()`, `closeLeaseAudit()`

`GENERATION_ENDED` clears the lease itself, so the audit is a separate object. It is what
the transaction reads after generation returns.

Armed is not the same as applied; applied is not the same as applied *to our generation*;
and neither is the same as *still installed when the prompt was assembled*. Three
distinct failures hide here — [LEASE-03](#LEASE-03), [LEASE-04](#LEASE-04), [LEASE-05](#LEASE-05).

<a id="LEASE-03"></a>
### LEASE-03 — Counting matching starts
**Sites:** `src/lease.js` › `onGenerationStarted()`
**Related:** [TX-05](#TX-05)

Every start that could plausibly be the one the transaction is waiting for is counted,
whether or not the lease is still armed — the generation that stole it has already
cleared `currentLease` by the time the real one begins, which is precisely the case this
catches.

Two failures it exposes:

- A generation Intercede did not start arrives first and consumes the lease. Intercede's
  own generation then runs with no rewrite instruction and produces an ordinary
  continuation that looks perfectly valid.
- Any second matching generation while the lease is open makes it impossible to say which
  one carried the instruction.

<a id="LEASE-04"></a>
### LEASE-04 — Open-generation count
**Sites:** `src/lease.js` › `openGenerations`, `isGenerationActive()`, `armLease()`, `onGenerationStarted()`, `onGenerationEnded()`
**Guards:** INV-11 **Related:** [LEASE-05](#LEASE-05), [LEASE-09](#LEASE-09), [TX-03](#TX-03), [TX-17](#TX-17)

An interfering *start* is not the only way the instruction gets pulled. A generation
already running when it is installed will clear the prompt at its own `GENERATION_ENDED`
— and that event carries nothing identifying whose end it is.

Counting instead lets the apply step notice that it is not alone, which is the same fact
one step earlier, at a moment when identity is still known.

**`openGenerations` is the only record of what is running.** There is no companion
boolean, and `isGenerationActive()` derives from the count. A boolean cannot represent
two overlapping generations, so any end sets it false while another is still open:

```
foreign A starts      active = true    open = 1
foreign B starts      active = true    open = 2
foreign A ends        active = false   open = 1   ← B is still running
```

At that moment a boolean says idle. Preflight ([TX-03](#TX-03)) passes, the instruction is
installed with `open === 1`, the apply-time `open > 1` check sees nothing wrong, and B's
`GENERATION_ENDED` strips the instruction from our pending generation — the [LEASE-05](#LEASE-05)
failure reached by a route [LEASE-05](#LEASE-05) cannot see, because B's *start* predates the audit
and its *end* names no owner.

Deriving the count from that boolean at arm time is the same defect one step further on:
it rewrites a true 1 to 0 and erases B entirely. The count is therefore **never reset
from anything except an explicit chat change** ([LEASE-09](#LEASE-09)).

`baselineOpenGenerations` records what was already open when the lease was armed. It is
carried in the receipt for diagnostics only and does not itself trigger rejection: if the
baselined generation is still open at apply time, `open > 1` already catches it, and if
it ended first it cleared the prompt *before* installation, which is harmless.

> **The trade this accepts.** A start whose end never arrives leaves the count high, and
> `isGenerationActive()` then reports a generation forever: preflight refuses every
> intercession and the settle wait in [TX-17](#TX-17) burns its full timeout. That is bad, but it
> is loud, and it clears on a chat change or a reload. A false *zero* is silent and
> commits a continuation the instruction never reached. When the count can only be wrong
> in one direction, it must be this one.

<a id="LEASE-09"></a>
### LEASE-09 — Only an end decrements
**Sites:** `src/lease.js` › `onGenerationEnded()`, `onGenerationStopped()`, `initLease()`
**Related:** [LEASE-04](#LEASE-04), [LEASE-07](#LEASE-07)

`GENERATION_STOPPED` clears the prompt and the lease like any other exit path, but it
does **not** decrement. SillyTavern emits it from `stopGeneration()` while the aborted
`Generate()` still runs its own `finally`, so the stopped generation emits
`GENERATION_ENDED` too. Decrementing on both would drop the count below what is actually
running — the one direction [LEASE-04](#LEASE-04) cannot tolerate.

`CHAT_CHANGED` is the single place the count is reset, and it resets to zero: nothing
that was running before the chat changed can still be assembling a prompt for this one.
It is also the user-reachable escape hatch if the count ever does drift high.

<a id="LEASE-05"></a>
### LEASE-05 — Prompt integrity after installation
**Sites:** `src/lease.js` › `onGenerationStarted()`; `src/transaction.js` › `generateSuffix()`
**Guards:** INV-11 **Related:** [LEASE-04](#LEASE-04), [CAP-05](#CAP-05), [TX-08](#TX-08)

Installing the instruction is not the same as it surviving until SillyTavern assembles
the prompt.

SillyTavern awaits `GENERATION_STARTED` and runs its listeners sequentially, and
extension prompts are collected substantially later in prompt preparation. A listener
that calls `generateQuietPrompt()` therefore runs a whole nested generation *inside* the
start event of ours. Refusing to let the instruction enter that foreign request is
correct ([LEASE-01](#LEASE-01)) — but clearing it is exactly what strips it from our own pending
generation, while the audit still reports a clean `applied: true`.

```
Intercede calls generate()
  → normal GENERATION_STARTED → instruction installed, applied = true
    → a listener calls generateQuietPrompt()
      → quiet GENERATION_STARTED → non-matching → prompt cleared
  → our generation assembles its prompt — without the instruction
  → an ordinary continuation commits silently
```

Every non-matching start after installation sets `promptIntegrityLost`. The transaction
rejects on it *after* proving ownership, so rollback can selectively remove Intercede's
own continuation rather than escalating to recovery-required — the reply is genuinely
ours ([CAP-05](#CAP-05)).

**Ordering is deliberate.** Interference *before* the instruction is applied disarms the
lease instead, so `applied` stays false and the diagnosis is "never applied", which is
more actionable. `promptIntegrityLost` and `!applied` are jointly exhaustive: an
interfering start nulls `currentLease`, and only `armLease()` re-arms it, so `applied`
can never subsequently become true. A bare `interferingStarts.length > 0` check would be
redundant and would replace the precise message with a vaguer one.

<a id="LEASE-06"></a>
### LEASE-06 — Swipe and regenerate re-lease
**Sites:** `src/lease.js` › `getTipSuffixRecord()`, `onGenerationStarted()`
**Related:** [TX-13](#TX-13)

When the user swipes or regenerates a committed revised suffix, the same editorial
instruction is re-installed from the committed transaction record, so every native swipe
is another adaptation of the same intercession.

<a id="LEASE-07"></a>
### LEASE-07 — Clear on every exit path
**Sites:** `src/lease.js` › `onGenerationEnded()`, `onGenerationStopped()`, `initLease()`
**Related:** [LEASE-01](#LEASE-01), [LEASE-04](#LEASE-04)

Generation end, stop, and chat change all clear the prompt; `initLease()` clears it at
startup so a session never begins with a stale instruction installed. Chat change also
zeroes the open-generation count.

<a id="LEASE-08"></a>
### LEASE-08 — Dry runs are deliberately exempt
**Sites:** `src/lease.js` › `onGenerationStarted()`
**Related:** [CAP-04](#CAP-04)

A dry run is a prompt-assembly probe, not a generation: the handler returns before any
sequencing or counting. This exemption is pinned by a test so it stays deliberate rather
than incidental.

---

# Validation — `VAL-*`

<a id="VAL-01"></a>
### VAL-01 — Structural is fatal, stylistic warns
**Sites:** `src/validator.js` › module header, `validateOwnedStructure()`, `qualityWarnings()`
**Guards:** INV-02, INV-03, INV-04 **Related:** [TX-16](#TX-16)

Structural corruption triggers rollback. Stylistic problems — prefix repetition, ignored
insertion, meta-commentary — produce warnings only: ambiguous prose is shown to the user,
never silently rejected or rewritten.

Every message is checked twice: the object reference the transaction captured must still
be where it belongs, and its marker must still name this transaction.

<a id="VAL-02"></a>
### VAL-02 — An over-long chat is fatal, not a warning
**Sites:** `src/validator.js` › `validateOwnedStructure()`
**Guards:** INV-02 **Related:** [CAP-01](#CAP-01)

Previous behaviour downgraded this to a warning, which let a foreign message be adopted
as the continuation.

> Consequence worth knowing: an extension that appends during generation now causes a
> clean rollback where it previously produced a silent wrong commit. That is the intended
> trade.

<a id="VAL-03"></a>
### VAL-03 — Prefix compared with strict equality
**Sites:** `src/validator.js` › `validateOwnedStructure()`
**Guards:** INV-04

The preserved prefix must be byte-identical. Any macro substitution or regex-extension
touch is therefore fatal — which is also why the selective rollback in [TX-08](#TX-08) is easy to
reach, not a remote edge case. The inserted user message is compared normalised instead,
and a transformation there is only a warning.

<a id="VAL-04"></a>
### VAL-04 — Preservation is textual overlap, not fidelity
**Sites:** `src/validator.js` › `computePreservation()`

A Sørensen–Dice coefficient over word trigrams, as a rounded percentage. This measures
textual overlap only — it is **not** a claim about semantic fidelity, and should never be
presented as one.

---

# Snapshot vault — `VAULT-*`

<a id="VAULT-01"></a>
### VAULT-01 — Write, verify, *then* cache
**Sites:** `src/vault.js` › `vaultPutStrict()`
**Guards:** INV-07 **Related:** [JRN-01](#JRN-01)

Order matters. The cache must never be populated before the backend confirms, or a quota
failure leaves a phantom record that reads as present until the page is reloaded — at
which point the snapshot the user was promised is gone.

A backend that resolves without persisting is caught by reading the value back.

<a id="VAULT-02"></a>
### VAULT-02 — Age alone never removes a live snapshot
**Sites:** `src/vault.js` › `cleanupVault()`
**Guards:** INV-10 **Related:** [TX-14](#TX-14), [TX-15](#TX-15), [REC-03](#REC-03), [CFG-01](#CFG-01)

A committed record that has not been explicitly finalized is the only copy of the message
Undo restores. An `abandoned` record holds the only copy of the original text of a
message the chat still shows half-applied. Neither may be removed by age alone; use
[TX-14](#TX-14) to give up undo deliberately.

<a id="VAULT-03"></a>
### VAULT-03 — Best-effort vs strict writes
**Sites:** `src/vault.js` › `vaultPut()`, `vaultDelete()`, `vaultDeleteStrict()`

`vaultPut`/`vaultDelete` are for paths where failure is not worth aborting for (enriching
an already-committed record). Even there, the cache is only populated after the durable
write resolves. Anything preceding a canonical mutation uses the strict variants.

<a id="VAULT-04"></a>
### VAULT-04 — Synchronous cache for hot paths
**Sites:** `src/vault.js` › `vaultGetCached()`
**Related:** [LEASE-06](#LEASE-06)

`GENERATION_STARTED` handlers cannot await IndexedDB, so the swipe re-lease path reads
the in-memory cache first.

---

# Recovery journal — `JRN-*`

<a id="JRN-01"></a>
### JRN-01 — Strict variants throw instead of swallowing
**Sites:** `src/vault.js` › `writeJournalStrict()`, `updateJournalStrict()`, `clearJournalStrict()`
**Guards:** INV-07 **Related:** [VAULT-01](#VAULT-01)

The journal is the only thing standing between a crash mid-transaction and an
unrecoverable chat. A write that silently failed is worse than no journal at all, because
the transaction proceeds believing it is protected. Every path preceding canonical
mutation verifies the write by reading it back.

The best-effort readers stay available for diagnostics.

<a id="JRN-02"></a>
### JRN-02 — One global slot, so collisions must be refused
**Sites:** `src/vault.js` › `writeJournalStrict()`, `isUnrecovered()`
**Guards:** INV-12 **Related:** [TX-02](#TX-02), [REC-05](#REC-05)

`JOURNAL_KEY` is a single localStorage slot for the whole application, not one per chat.
Starting a transaction in chat B would otherwise destroy chat A's unrecovered journal and
make A unrecoverable. Refuse instead — the caller aborts before touching any message.

<a id="JRN-03"></a>
### JRN-03 — Terminal stages
**Sites:** `src/constants.js` › `TERMINAL_JOURNAL_STAGES`
**Related:** [REC-01](#REC-01)

Only `committed` and `rolled-back` mean the transaction owns nothing further, so a new
journal may replace the record. Every other stage means an interrupted transaction whose
evidence must survive.

---

# Recovery — `REC-*`

<a id="REC-01"></a>
### REC-01 — What each journal stage licenses
**Sites:** `src/transaction.js` › `checkRecoveryInner()`, `STAGES_BEFORE_MUTATION`
**Related:** [JRN-03](#JRN-03), [TX-11](#TX-11)

The distinction that matters:

| Stage | Meaning |
|-------|---------|
| `about-to-mutate`, `snapshotted` | Nothing canonical changed — a leftover journal is litter |
| `prefix-applied` onward | The chat was modified; the snapshot is the only way back |
| `committing` | The commit may or may not have reached disk |
| `recovery-required` | A previous run already found ownership ambiguous — **no automatic destructive action is permitted** |

<a id="REC-02"></a>
### REC-02 — A missing snapshot does not resolve the transaction
**Sites:** `src/transaction.js` › `checkRecoveryInner()`
**Guards:** INV-12 **Related:** [TX-09](#TX-09)

The journal is the only durable evidence that canonical history was mid-change. Losing
the snapshot makes automatic restoration impossible — it does not make the interruption
imaginary. Keep the record, switch it to `recovery-required`, block new intercessions,
change nothing, and show a persistent error.

Clearing the journal here would erase the only record that a canonical mutation was
interrupted.

<a id="REC-03"></a>
### REC-03 — "Keep chat as it is" must not discard evidence
**Sites:** `src/transaction.js` › `abandonInterruptedTransaction()`
**Related:** [OWN-03](#OWN-03), [VAULT-02](#VAULT-02)

"Keep chat as it is" cannot mean "delete the journal and walk away": that leaves messages
still marked as belonging to a transaction that never finished, and a vault snapshot
nothing references. Worse, when the target is half-applied the snapshot holds the *only*
copy of the original text, so discarding it destroys the very thing recovery exists to
protect.

So: markers are cleared ([OWN-03](#OWN-03)), an `abandoned` metadata record keeps the snapshot
referenced and findable, and the snapshot itself is retained ([VAULT-02](#VAULT-02) protects it from
cleanup). If any marker cannot be accounted for, nothing is touched and the transaction
stays in recovery-required.

<a id="REC-04"></a>
### REC-04 — Proof during snapshot restoration
**Sites:** `src/transaction.js` › `restoreFromVaultRecord()`
**Guards:** INV-05 **Related:** [TX-08](#TX-08)

Only messages that can be proven to belong to the interrupted transaction are removed;
the loop stops the moment anything else is found.

Proof is either the transaction's own marker, or — for the inserted user message, which
may have been added before the marker was written — an exact text match against the
snapshot. Position alone is never proof: an unmarked assistant message sitting where the
continuation would have gone may equally be another extension's, so recovery stops and
asks.

The target itself must match the transaction marker, the prefix hash, or the original
hash; otherwise recovery aborts without changing anything.

<a id="REC-05"></a>
### REC-05 — Cross-chat journals are reported, not acted on
**Sites:** `src/transaction.js` › `checkRecoveryInner()`
**Related:** [TX-10](#TX-10), [JRN-02](#JRN-02)

An unfinished intercession belonging to another chat prompts the user to open that chat.
Recovery never operates on a chat the journal does not name.

---

# Host adapter — `HOST-*`

<a id="HOST-01"></a>
### HOST-01 — Everything through `getContext()`
**Sites:** `src/stcontext.js` › module header

No internal SillyTavern client modules are imported, per the official extension guidance.
Names that have shifted between releases (`eventTypes`/`event_types`,
`extensionPromptTypes`/…) are resolved here with fallbacks so the rest of the extension
stays clean.

<a id="HOST-02"></a>
### HOST-02 — `persistChatAndMetadata` avoids a double save
**Sites:** `src/stcontext.js` › `saveMetadata()`, `persistChatAndMetadata()`

`saveMetadata()` falls back to `saveChat()`, so calling both in sequence can save the chat
twice. Callers that have already saved the chat use `persistChatAndMetadata` instead,
which makes the second call a no-op when the host has no separate metadata save.

<a id="HOST-03"></a>
### HOST-03 — Deletion prefers the host's own path
**Sites:** `src/stcontext.js` › `deleteMessageAt()`
**Related:** [TX-08](#TX-08)

The host's deletion reindexes and notifies other extensions. The fallback splices and
reprints, because removing a DOM node by `mesid` only stays coherent when deleting
strictly from the tail — and [TX-08](#TX-08) does not always delete from the tail.

<a id="HOST-04"></a>
### HOST-04 — Capability check names the events it needs
**Sites:** `src/stcontext.js` › `checkCapabilities()`
**Related:** [CAP-02](#CAP-02)

Naming the events we actually depend on, rather than checking that the map is merely
non-empty: a host missing the assistant-message event cannot support ownership capture,
and must not start a transaction.

<a id="HOST-05"></a>
### HOST-05 — Storage backend with a localStorage shim
**Sites:** `src/stcontext.js` › `getStorageBackend()`, `localStorageShim`

localforage bundled with SillyTavern when available, otherwise a localStorage-backed
stand-in with the same async surface.

---

# Text model — `SEG-*`, `ANC-*`

<a id="SEG-01"></a>
### SEG-01 — Raw source only, never the DOM
**Sites:** `src/segmentation.js` › module header
**Related:** [VIS-01](#VIS-01)

Markdown, regex scripts, and macros can all reshape the visible message, so every
boundary is an offset into the raw source (`message.mes`). Display visibility is a
separate concern, handled by [VIS-01](#VIS-01).

<a id="SEG-02"></a>
### SEG-02 — Protected ranges
**Sites:** `src/segmentation.js` › `getProtectedRanges()`, `isOffsetProtected()`

Boundaries are only offered between safe textual units — never inside fenced or inline
code, Markdown links/images, raw HTML tags, macro expressions, or an unfinished
quotation. An unclosed trailing fence protects to end of text.

<a id="SEG-03"></a>
### SEG-03 — Separator regex treats a single newline as a paragraph break
**Sites:** `src/segmentation.js` › `SEPARATOR_REGEX`
**Status:** ⚠ **Known defect — deferred, not fixed**

```js
const SEPARATOR_REGEX = /\n[^\S\n]*(?:\n[^\S\n]*)*/g;
```

The trailing `*` makes the second newline optional, so a single newline is treated as a
paragraph boundary and `getBlocks` degrades into a line-splitter. That in turn defeats
`insideOpenQuote`'s multi-line quote detection, since a quote spanning lines is split
across blocks.

Deferred to a later phase by an explicit scoping decision. Recorded here so it is not
mistaken for intended behaviour.

<a id="SEG-04"></a>
### SEG-04 — Sentence heuristics
**Sites:** `src/segmentation.js` › `segmentSentences()`, `ABBREVIATION_REGEX`, `BAD_SENTENCE_START_REGEX`, `insideOpenQuote()`

`Intl.Segmenter` when available, a punctuation regex otherwise. A candidate is rejected
when it follows an abbreviation or single initial, when the next sentence starts with
continuation punctuation, a closing quote, or a lowercase letter, or when it sits inside
an unfinished quotation.

<a id="SEG-05"></a>
### SEG-05 — Deduplication prefers paragraphs
**Sites:** `src/segmentation.js` › `getBoundaries()`

Boundaries within two characters of each other collapse to one, preferring the paragraph.
Sentence cuts immediately before a paragraph separator duplicate the paragraph cut and are
dropped.

<a id="SEG-06"></a>
### SEG-06 — The split drops separator whitespace
**Sites:** `src/segmentation.js` › `splitAtOffset()`

The prefix keeps its exact source text minus trailing separator whitespace; the suffix
drops its leading separator whitespace. Each becomes its own message, so the whitespace
that used to join them has no owner.

<a id="ANC-01"></a>
### ANC-01 — A cut is never just an offset
**Sites:** `src/anchors.js` › `createAnchor()`

An anchor records hashes of the whole message and both halves, plus a context window on
each side, so a stale selection can be detected instead of cutting at the wrong place.

<a id="ANC-02"></a>
### ANC-02 — Conservative rebase
**Sites:** `src/anchors.js` › `resolveAnchor()`
**Related:** [TX-03](#TX-03)

Byte-identical text returns the offset unchanged. If the message changed, the exact
context window (before + after) must appear exactly **once** in the new text. Anything
ambiguous fails — a wrong cut is worse than no cut.

---

# Display visibility — `VIS-*`

<a id="VIS-01"></a>
### VIS-01 — Three-way boundary classification
**Sites:** `src/ui/visibility.js` › module header, `classifyBoundaries()`
**Related:** [SEG-01](#SEG-01), [UI-01](#UI-01)

Display-only transforms — regex scripts set to "Alter Chat Display", macro expansion,
prompt-bias hiding — can delete whole regions of the raw text at render time. A common
example is a script that strips `<response_consideration>…</response_consideration>`
planning blocks the model was told to emit.

Such text exists in `message.mes` but the reader never sees it, and a cut inside it would
be meaningless — it would split the hidden block across two messages, breaking the very
script that hides it.

One offscreen instrumented render classifies every boundary:

| Status | Meaning |
|--------|---------|
| `visible` | Its sentinel survived rendering; a marker can attach and a cut there is safe |
| `hidden` | Sentinel *and* surrounding raw context are both absent from the rendered text — invisible by design, excluded from every interface |
| `failed` | The surrounding context IS visible but the sentinel was destroyed: the pipeline mangles private-use characters, so in-place marker positions cannot be trusted for this message |

The `hidden`/`failed` split is what decides whether the in-place interface falls back to
the floating window ([UI-01](#UI-01)).

<a id="VIS-02"></a>
### VIS-02 — Private-use sentinels
**Sites:** `src/ui/visibility.js` › `S_START`, `S_END`, `instrumentRaw()`, `renderInstrumented()`

Sentinels are inserted at raw offsets back-to-front so earlier offsets stay valid, then
rendered through SillyTavern's own `messageFormatting` pipeline into a detached container.
That output is already sanitised by the host.

<a id="VIS-03"></a>
### VIS-03 — Context windows truncate at neighbouring boundaries
**Sites:** `src/ui/visibility.js` › `classifyBoundaries()`

A partially surviving sentinel at an adjacent boundary (e.g. only its digits) must not
pollute the text being matched, so each context window stops at the neighbouring boundary.
Comparison is letters and digits only, case-folded, which makes it markdown- and
punctuation-proof.

---

# User interface — `UI-*`

<a id="UI-01"></a>
### UI-01 — In-place mode and its fallback
**Sites:** `src/ui/inline-mode.js` › module header, `openInlineMode()`
**Related:** [VIS-01](#VIS-01)

Intercession mode is rendered directly over the assistant message where it sits. The
message keeps its native Markdown rendering and spacing; insertion points appear as
faded, zero-layout-impact markers — hairlines floating in existing paragraph gaps, small
translucent chips at sentence breaks — that light up on hover.

The chat data is never touched; exit re-renders natively via `updateMessageBlock`.

Boundaries whose text is display-hidden are classified and dropped, **not** counted as
failures — the floating-window fallback fires only when sentinels die inside text the
reader can see.

Rendered content is swapped in by moving nodes, which keeps marker listeners alive.

<a id="UI-02"></a>
### UI-02 — Sentinels that formed their own block
**Sites:** `src/ui/inline-mode.js` › empty-block cleanup
**Related:** [VIS-01](#VIS-01)

A sentinel that formed its own block — typically at the edge of a display-hidden region —
leaves an empty paragraph behind once swapped for a marker. Native rendering has no such
block, so keeping it would shift the layout. Drop the marker and its host block, and
reclassify the boundary as hidden so it does not count toward the fallback decision.

The container is still detached at that point, so membership is tested rather than
`isConnected`.

<a id="UI-03"></a>
### UI-03 — Floating overlay never mutates
**Sites:** `src/ui/overlay.js` › module header, `openOverlay()`

A reading overlay over the raw message with clickable boundaries and an inline composer.
All mutation happens inside the transaction after an explicit commit.

Separating whitespace is represented by the boundary control itself, so it is dropped from
the following slice's display. Hovering or focusing a boundary previews what would be
rewritten. When a confirm or compare dialog is stacked on top, the overlay yields the
keyboard to it.

<a id="UI-04"></a>
### UI-04 — Drafts survive failure
**Sites:** `src/ui/commit-flow.js` › `drafts`, `getDraft()`, `setDraft()`

A failed or cancelled intercession keeps the user's response text so they can retry.

<a id="UI-05"></a>
### UI-05 — Drafts store offsets, not indices
**Sites:** `src/ui/commit-flow.js` › `findDraftBoundaryIndex()`

Drafts store the raw-text offset, which is stable across the two interfaces — they may
filter their boundary lists differently, so a positional index would resolve to a
different boundary depending on which interface reopened.

> Draft keys are `chatId::targetIndex` with no source hash, so an edited message can
> resurface a stale draft. Deferred, not fixed.

<a id="UI-06"></a>
### UI-06 — Foreign continuation metadata is surfaced, not blocked
**Sites:** `src/ui/commit-flow.js` › `detectForeignContinuationData()`, `detectMemoryExtensions()`

Best-effort detection of another extension's continuation/branch metadata, and of active
memory extensions. Both produce warnings in the confirmation preview: only the visible
text becomes the prefix, the full message is preserved for undo, and memories already
derived from the message are not automatically recalculated.

<a id="UI-07"></a>
### UI-07 — Modals are deliberately self-contained
**Sites:** `src/ui/modal.js` › module header

Independent of SillyTavern's popup API so core flows (recovery, cancel-confirmation)
cannot break if that surface shifts between releases.

<a id="UI-08"></a>
### UI-08 — Button visibility and the async undo check
**Sites:** `src/ui/message-button.js` › `refreshButtonVisibility()`, `verifyUndoAvailability()`
**Guards:** INV-10 **Related:** [TX-15](#TX-15)

Undo and Compare both need the vault snapshot, not just the metadata record that names
it. That check is asynchronous, so the result is cached per transaction and the buttons
appear once it confirms — better a brief delay than a control that fails when clicked.

Buttons are injected into the message template so every future message carries them, and
into already-rendered messages on init. Visibility is kept in sync with chat life-cycle
events.

<a id="UI-09"></a>
### UI-09 — Chain-aware wording
**Sites:** `src/ui/message-button.js` › `refreshButtonVisibility()`, `onUndoClick()`; `src/ui/compare.js`
**Related:** [TX-04](#TX-04), [TX-13](#TX-13)

In a chain the message that gets restored is the previous intercession's continuation, not
the character's untouched original, and the "original continuation" shown in Compare is
that earlier revision. Both say so explicitly rather than claiming to restore "the
original".

<a id="UI-10"></a>
### UI-10 — Activation is a toggle
**Sites:** `src/ui/open.js` › module header; `src/ui/inline-mode.js` › outside-click handler; `index.js` › generation listener

Invoking Intercede (wand menu, message button, Alt+I, `/intercede`) while a mode is
already open closes it and restores the message. Otherwise the interface chosen in
settings opens; if in-place mode cannot attach ([VIS-01](#VIS-01) `failed`), the floating window
opens instead.

Two consequences elsewhere:

- The trigger controls toggle the mode themselves, so the outside-click handler must
  ignore them or the mode closes and immediately reopens.
- A generation moves the chat on, so any open selection mode is restored first — its
  boundaries refer to a message that is no longer the tail.

<a id="UI-11"></a>
### UI-11 — Dimming starts from different nodes per marker type
**Sites:** `src/ui/inline-mode.js` › dim helper
**Related:** [UI-01](#UI-01)

Paragraph markers are appended to their host block, so dimming starts at the host;
sentence markers dim from their own position. Using one rule for both either leaves the
paragraph's own text undimmed or dims a sentence's preceding text.

---

# Errors and configuration — `ERR-*`, `CFG-*`

<a id="ERR-01"></a>
### ERR-01 — Three outcomes, because rollback differs for each
**Sites:** `src/errors.js`
**Related:** [TX-08](#TX-08), [TX-11](#TX-11)

| Type | Meaning |
|------|---------|
| `Error` | An ordinary failure; rollback can restore exactly |
| `RecoveryRequiredError` | Ownership can no longer be proven. Nothing is deleted, evidence (journal + vault) is preserved, and the user is asked to decide |
| `PreflightError` | Nothing was mutated, so there is nothing to undo |

<a id="CFG-01"></a>
### CFG-01 — Snapshots are kept indefinitely by default
**Sites:** `src/constants.js` › `DEFAULT_SETTINGS.snapshotTtlDays`
**Related:** [VAULT-02](#VAULT-02), [TX-14](#TX-14)

`0` = keep indefinitely. An undo snapshot must never disappear on its own. Age cleanup,
when enabled, still refuses to delete a committed snapshot that has not been explicitly
finalized.

<a id="CFG-02"></a>
### CFG-02 — Event contract
**Sites:** `src/constants.js` › `INTERCEDE_EVENTS`; `src/events.js`

Custom events are emitted through the shared SillyTavern eventSource so memory, summary,
timeline, and analytics extensions can invalidate derived state after a history rewrite.
Handler errors are caught and logged — a misbehaving listener must not fail a commit.

> `intercede_invalidated` is declared and documented but never emitted. Deferred.

---

# Prompt — `PROMPT-*`

> **`src/prompt.js` is not modified by this document.** It is tuned, and its comments
> remain in the file. They are reproduced here for cross-reference only. Behaviour
> requests against it are plumbing changes elsewhere, not prompt edits.

<a id="PROMPT-01"></a>
### PROMPT-01 — Scene-notes framing
**Sites:** `src/prompt.js` (source unchanged)
**Related:** [LEASE-01](#LEASE-01)

The suffix-revision instruction is worded as in-fiction scene notes so backend ToS
filters do not mistake it for output-reuse.

---

# Open questions

Things this document asserts that have **not** been verified against a live SillyTavern
1.18.x profile. Each is a place where a wrong assumption would matter.

1. **[CAP-02](#CAP-02) — assistant-message event payload.** The capture adapter accepts an integer
   id, an object with `messageId`/`index`, or a message object. If 1.18.x passes something
   else, capture observes nothing and every intercession fails closed. Fix the adapter,
   record the real shape in tests, and do not loosen [CAP-05](#CAP-05).

2. **[LEASE-05](#LEASE-05) — nested generation ordering.** The nested-quiet failure depends on
   SillyTavern awaiting `GENERATION_STARTED` before assembling extension prompts. The
   regression tests encode that model rather than prove it. If the host does not behave
   that way, the guards are harmless but the path was never reachable.

3. **[LEASE-04](#LEASE-04) — unpaired `GENERATION_ENDED`.** Nothing bounds drift any more: the count
   is authoritative and only `CHAT_CHANGED` resets it. A start whose end never arrives
   makes the extension refuse every intercession until the chat changes or the page
   reloads. Loud and recoverable by construction, but worth watching for in practice.

4. **[LEASE-09](#LEASE-09) — stop emits both events.** The count assumes `GENERATION_STOPPED` is
   always followed by that generation's own `GENERATION_ENDED`. If some backend's abort
   path skips the end, pressing stop leaks the count upward — see question 3 for what
   that feels like. Worth exercising the stop button on each backend.
