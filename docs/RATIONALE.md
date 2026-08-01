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

"While nothing is generating" is answered by `isGenerationActive()`, which asks the host
and falls back to the open-generation records ([LEASE-10](#LEASE-10),
[LEASE-04](#LEASE-04)) — never by a flag that the most recent event happened to set. This
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

Because it is the one operation that destroys evidence on purpose, it refuses whenever
something else might still need that evidence: a transaction in progress, the
recovery-required latch ([TX-11](#TX-11)), a journal in a non-terminal stage, or a
metadata record that has gone missing. A journal mid-flight is the sharpest of these —
the snapshot it names may be the only copy of the original text of a message the chat
currently shows half-applied.

The three steps run in an order chosen by asking what each intermediate failure leaves
behind:

1. **Mark the snapshot `finalizedAt`.** Not the last step, the first. Cleanup protects a
   committed record that is *not* finalized ([VAULT-02](#VAULT-02)), so a snapshot
   orphaned by a failed step 3 would otherwise be protected forever — a permanent leak
   that no sweep can reach.
2. **Persist the decision** (`finalizedAt` set, `vaultKey` deleted) while the snapshot
   still exists — and **restore the in-memory record if the save throws**. That restore
   is not tidiness. `canUndoTip()` reads the in-memory record, so a mutated record with a
   failed save means this session advertises no undo while the snapshot it needs is still
   sitting in the vault. Only a reload, which re-reads the unchanged metadata from disk,
   would have brought it back. With the restore, undo keeps working immediately.

   `persistChatAndMetadata()` saves the chat then the metadata, so `saveChat()` can
   succeed while `saveMetadata()` fails. The restore is the same either way: memory says
   "not finalized" and undo works, and if the finalized state did reach disk, the next
   reload reports undo as gone — correctly, since the vault record is marked finalized
   and collectable. At no point is undo gone while still advertised.
3. **Delete the snapshot.** Only now is it expendable. If this fails, undo is already
   correctly advertised as gone and the record is collectable by age.

The invariant across all three: never leave undo *gone while still advertised*. Every
ordering that deletes before recording would.

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
**Sites:** `src/lease.js` › `openGenerations`, `openCount()`, `closeOpenGeneration()`, `armLease()`, `onGenerationStarted()`, `onGenerationEnded()`
**Guards:** INV-11 **Related:** [LEASE-05](#LEASE-05), [LEASE-09](#LEASE-09), [LEASE-10](#LEASE-10), [TX-03](#TX-03), [TX-17](#TX-17)

An interfering *start* is not the only way the instruction gets pulled. A generation
already running when it is installed will clear the prompt at its own `GENERATION_ENDED`
— and that event carries nothing identifying whose end it is.

Counting instead lets the apply step notice that it is not alone, which is the same fact
one step earlier, at a moment when identity is still known.

**`openGenerations` is the only event-derived record of what is running** — one entry per
start, closed by an end. There is no companion boolean. A boolean cannot represent two
overlapping generations, so any end sets it false while another is still open:

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

`GENERATION_ENDED` carries a kind but no identity, so an end closes the most recent open
record of the same kind, falling back to the most recent record of any kind. Two
concurrent generations of the same kind are genuinely indistinguishable; the fallback is
tallied as a kind mismatch rather than hidden ([LEASE-11](#LEASE-11)).

> **The trade this accepts, and its limit.** A start whose end never arrives leaves a
> record open forever. Counting can only be wrong upward, which is the right direction —
> a false *zero* is silent and commits a continuation the instruction never reached,
> while a false *positive* merely refuses to work.
>
> But "merely refuses to work" was too generous. In the field this locked the extension
> out of its own chat until a reload. Refusing forever is not an acceptable resting
> state, which is why [LEASE-10](#LEASE-10) lets the host overrule the count — without
> ever letting it overrule an interference decision already made.

<a id="LEASE-09"></a>
### LEASE-09 — Only an end decrements
**Sites:** `src/lease.js` › `onGenerationEnded()`, `onGenerationStopped()`, `initLease()`
**Related:** [LEASE-04](#LEASE-04), [LEASE-07](#LEASE-07)

`GENERATION_STOPPED` clears the prompt and the lease like any other exit path, but it
does **not** decrement. SillyTavern emits it from `stopGeneration()` while the aborted
`Generate()` still runs its own `finally`, so the stopped generation emits
`GENERATION_ENDED` too. Decrementing on both would drop the count below what is actually
running — the one direction [LEASE-04](#LEASE-04) cannot tolerate.

`CHAT_CHANGED` is the single place the records are dropped wholesale: nothing that was
running before the chat changed can still be assembling a prompt for this one. It remains
the user-reachable escape hatch, though [LEASE-10](#LEASE-10) should mean nobody needs
it.

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
**Sites:** `src/lease.js` › `isDryRunSignal()`, `onGenerationStarted()`
**Related:** [CAP-04](#CAP-04), [LEASE-10](#LEASE-10)

A dry run is a prompt-assembly probe, not a generation: the handler returns before any
sequencing or counting. This exemption is pinned by a test so it stays deliberate rather
than incidental.

**A missed dry run is not a harmless miscount.** Dry runs emit `GENERATION_STARTED` and
never emit `GENERATION_ENDED`, so one counted as real is an open record that can never be
closed — the extension then believes a generation is running forever. That is the single
cheapest way to lock Intercede out of its own chat.

The signal is therefore read positionally-agnostically: a boolean `true` anywhere in the
event arguments after the type means dry run. The handler does not assume `(type,
options, dryRun)`, because a build that emits `(type, dryRun)` would otherwise slot the
flag into `options` and read `dryRun` as `undefined`. An options object is never `true`,
so widening the check costs nothing.

<a id="LEASE-10"></a>
### LEASE-10 — The host outranks our bookkeeping
**Sites:** `src/lease.js` › `isGenerationActive()`, `reconcileWithHost()`; `src/stcontext.js` › `probeHostGeneration()`
**Guards:** INV-11 **Related:** [HOST-06](#HOST-06), [LEASE-04](#LEASE-04), [TX-03](#TX-03)

Counting events is only as good as the events. A start whose end never arrives — a
misread dry run ([LEASE-08](#LEASE-08)), a host path that skips `GENERATION_ENDED` —
leaves a record open forever, and a count that can only be wrong upward turns into a
permanent refusal to do anything. That was observed in the field: undo and every new
intercession answering "wait for the current generation to finish" with nothing running,
until the chat changed or the page reloaded.

So eligibility asks the host first ([HOST-06](#HOST-06)) and falls back to the count only
when the host cannot answer — `unknown` is the only case where our bookkeeping decides.

Two separable acts hide in that sentence, and they carry different risk:

- **Answering the question.** If the host says idle, `isGenerationActive()` returns false,
  full stop. This is always safe: it reports host state, it destroys nothing, and being
  wrong costs at most one transaction that should have waited.
- **Dropping the open records.** Destructive, because those records are what the next
  `armLease()` baselines against. This happens **only when no lease is armed.** With no
  transaction in flight there is no interference decision to corrupt: the next
  `armLease()` simply takes a fresh baseline. This is what keeps a weak idle signal from
  silently undoing [LEASE-04](#LEASE-04).

> **The residual risk, stated plainly.** If the host reports idle while a background
> generation really is running, the following transaction arms with a baseline of zero
> and cannot see that generation strip its instruction. That is the [LEASE-05](#LEASE-05)
> hole, reopened for exactly one case: a host signal that does not cover background
> generations. `#mes_stop` is such a signal, which is why its idle answer is marked weak
> and reported as such in diagnostics. A strong signal — one the host sets for every
> generation — closes this completely.

There is deliberately **no timeout-based reset**. Age is not evidence: a slow backend and
a lost event look identical, and a reset on a timer would resurrect the silent-commit
failure on exactly the slow generations most likely to be interfered with.

<a id="LEASE-11"></a>
### LEASE-11 — Diagnostics are part of the safety story
**Sites:** `src/lease.js` › `getLeaseDiagnostics()`; `index.js` › `collectDiagnostics()`
**Related:** [LEASE-10](#LEASE-10), [HOST-06](#HOST-06)

Every assumption this module makes about host events is unverifiable from inside the
repository, so `/intercede diagnostics` reports what actually happened: which probe
answered and how confidently, what is still open and for how long, and tallies of starts,
ends, dry runs, unmatched ends, kind-mismatched ends, stops, and host reconciliations.

The tallies are the discriminator. Dry runs climbing alongside a stuck open record points
at [LEASE-08](#LEASE-08); unmatched ends point at a host emitting ends we never saw start;
reconciliations climbing means the counter is leaking and the host is covering for it.

`parserBuild` answers a different question: **which build is actually loaded?**
`manifest.json` sets `auto_update: false`, and a version string is reported just as
confidently by a stale checkout as by a current one — during P1 runtime testing three
different parser generations all announced `0.5.0`, and several findings turned out to be
an old checkout rather than live defects. So the field is not a claim, it is a
measurement: `probeParserBuild()` runs the real parser over fixtures whose behaviour
changed between builds and reports what it observes. A tester pasting diagnostics can see
at a glance whether reference links, backslash parity, intraword emphasis, list
continuations and blank-line paragraphs are present in the code that is answering.

Bump the version too, of course. The probe is what survives forgetting to.

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
**Sites:** `src/vault.js` › `cleanupVault()`; `src/transaction.js` › `cleanupSnapshots()`, `liveVaultKeys()`
**Guards:** INV-10 **Related:** [TX-14](#TX-14), [TX-15](#TX-15), [REC-03](#REC-03), [CFG-01](#CFG-01)

A committed record that has not been explicitly finalized is the only copy of the message
Undo restores. An `abandoned` record holds the only copy of the original text of a
message the chat still shows half-applied. Neither may be removed by age alone; use
[TX-14](#TX-14) to give up undo deliberately.

Those two checks read the record's own `state`, which is the limit of what a record can
answer: it says what the snapshot was *for*, never whether anything still *points at it*.
The in-flight transaction, the recovery journal, and the chat's own metadata all live
outside the vault, and the vault cannot import them without a cycle. So the references are
passed in as `protectedKeys`, composed on the transaction side by `liveVaultKeys()` — the
active transaction's key, a non-terminal journal's key, and every metadata record without
a `finalizedAt`.

`cleanupSnapshots()` is therefore the only entry point any caller should use; calling
`cleanupVault()` directly means cleaning up with the references missing. It refuses
outright while a transaction is in progress, because the snapshot being written is the one
thing a sweep must not race — and equally while the recovery-required latch
([TX-11](#TX-11)) is set, since the latch means something is unresolved that the journal
and metadata may no longer describe. That is the same guard [TX-14](#TX-14) uses, for the
same reason: the sweep would be taking the evidence.

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

<a id="HOST-06"></a>
### HOST-06 — Asking the host whether it is generating
**Sites:** `src/stcontext.js` › `probeHostGeneration()`
**Related:** [LEASE-10](#LEASE-10), [HOST-01](#HOST-01)

Returns `busy`, `idle`, or `unknown`, plus the probe that answered and how much its
*idle* answer is worth. Probes are tried in descending confidence:

| Probe | Busy | Idle |
|---|---|---|
| `ctx.isGenerating` (boolean) | strong | strong |
| `ctx.streamingProcessor` with `isFinished === false` | strong | — |
| `#mes_stop` visible | strong | weak |
| nothing present | `unknown` | `unknown` |

**Confidence is asymmetric, and that asymmetry is the whole design.** A visible stop
button proves a generation is running. A hidden one proves only that no *user-facing*
generation is running — background and quiet generations need not show it. So the same
probe is trusted absolutely for `busy` and only provisionally for `idle`, which is why
[LEASE-10](#LEASE-10) fences what an idle answer is allowed to do.

`unknown` is a real answer and must not be collapsed into `idle`. A build exposing none of
these falls back to event counting, which is worse but is not wrong by default.

Reading `#mes_stop` is a DOM read of a stable, user-visible control, not a reach into
client internals ([HOST-01](#HOST-01)). It is the last resort precisely because it is the
weakest.

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
**Sites:** `src/segmentation.js` › `getProtectedRanges()`, `isOffsetProtected()`, `getBoundaries()`

Boundaries are only offered between safe textual units — never inside fenced or inline
code, Markdown links/images, raw HTML tags, macro expressions, or an unfinished
quotation. An unclosed trailing fence protects to end of text.

Sentence segmentation skips a whole block when it is protected, and the containment test
asks whether **one** range covers the block end to end — not whether each of its two ends
falls inside *some* range. The weaker test is the tempting one, and it is wrong in a case
that occurs constantly in roleplay: two adjacent emphasis spans with free text between
them. Each end of the block sits inside a different range, so the block reads as fully
protected and every sentence boundary in the gap disappears. Over-protection is the safe
direction for a *cut* ([SEG-07](#SEG-07)), but here it silently costs boundaries that were
never in a protected range at all.

<a id="SEG-03"></a>
### SEG-03 — A paragraph break is a blank line
**Sites:** `src/segmentation.js` › `PARAGRAPH_SEPARATOR_REGEX`, `getBlocks()`
**Related:** [SEG-04](#SEG-04), [SEG-05](#SEG-05)

```js
const PARAGRAPH_SEPARATOR_REGEX = /\n[^\S\n]*(?:\n[^\S\n]*)+/g;
```

The trailing `+` is load-bearing. With `*` in its place — which is what shipped through
v0.5 — a single newline counted as a paragraph break, and two things followed:

- Paragraph granularity stopped meaning anything: on a message written with single
  newlines it offered a boundary at every line, which is sentence-ish behaviour under
  the wrong label.
- `getBlocks()` degraded into a line-splitter, so quotation state was computed per line
  rather than per paragraph. Under [SEG-10](#SEG-10) a cut inside a quotation is now
  offered deliberately, so this no longer changes which boundaries appear — but the
  block a risk is *assessed* against is still the paragraph, and a line-splitter would
  assess the wrong text.

A single newline is now a line break within a paragraph. It still yields a *sentence*
boundary wherever a sentence actually ends there — `Intl.Segmenter` breaks after a line
feed — so the useful cut points survive; they are simply labelled honestly.

The cost is real and accepted: a message written entirely with single newlines has no
paragraph boundaries at all, and in paragraph granularity offers nothing. Sentence
granularity, the default, still finds the same places. Restoring the old behaviour to
avoid that empty case would restore the mis-cut quotation with it.

<a id="SEG-07"></a>
### SEG-07 — Paired emphasis is protected
**Sites:** `src/segmentation.js` › `EMPHASIS_PATTERNS`, `WITHIN_BLOCK`
**Related:** [SEG-02](#SEG-02)

`**strong**`, `__strong__`, `*emphasis*`, `_emphasis_`, and `~~strike~~` become protected
ranges. A cut between the delimiters puts the opener in the prefix and the closer in
text that is about to be regenerated, so the prefix renders with an unclosed `*` and the
stray delimiter is what the model sees first.

This matters most for the way roleplay is actually written. In `*She walks in.*` the
sentence segmenter reports a break after `.` and *before* the closing `*`, because `*`
is not closing punctuation under UAX #29. That candidate is now rejected, and the
candidate after the closing delimiter is kept — the same cut, one character later, in
the right place.

Each pattern requires a non-space character just inside both delimiters, which is what
CommonMark requires for the pair to render as emphasis at all: text these patterns miss
was never emphasis. `WITHIN_BLOCK` forbids a blank line inside a match, so an unclosed
delimiter cannot pair with one three paragraphs away and protect everything between.

Three rules follow CommonMark rather than intuition, and each was a real hole:

- **`*` may open inside a word, `_` may not.** `foo*bar*baz` renders as emphasis;
  `snake_case_name` does not. A lookbehind that excluded a preceding word character for
  both — which is what the first version did — left intraword emphasis unprotected.
- **An escaped delimiter is text — and escaping is a parity question.** `ESCAPED`
  consumes `\*` as one unit inside a span, and `NOT_ESCAPED` guards every delimiter
  position outside one. Parity is what makes it correct: `\*` is a literal asterisk, but
  `\\*` is a literal backslash followed by a *live* delimiter, and `\\\*` is escaped
  again. A plain `(?<!\\)` sees only the nearest backslash, so it read every even run as
  an escape and dropped the emphasis entirely — under-protection, the direction that
  hands out a broken cut. The assertion is
  `(?<!(?<!\\)(?:\\\\)*\\)`: no odd run of backslashes ends here.
- **`***` is matched before `**`.** Otherwise the `**` pattern stops one delimiter short
  and leaves a cut legal *between* the second and third asterisk.

Over-matching only ever forbids a cut, so the failure direction is a boundary the user
does not get. Under-matching hands them a broken one. Where the two conflict — an
ambiguous or unmatched delimiter run — protect.

These are regexes, not a CommonMark delimiter scanner, and a scanner is the honest fix if
this list grows again. The line to watch: every rule here is expressible as "which
character pairs bind", and once one needs to know what *else* matched, the regexes are
the wrong tool.

<a id="SEG-08"></a>
### SEG-08 — A list is one unit
**Sites:** `src/segmentation.js` › `addListRanges()`, `LIST_ITEM_REGEX`, `LIST_CONTINUATION_REGEX`, `resumesList()`
**Related:** [SEG-02](#SEG-02)

A run of bullet or ordered items — with indented continuation lines, and with the blank
lines of a loose list — is protected as a single range. Cutting between two items leaves
a truncated list in the prefix and asks the regeneration to resume a numbering it was
never shown.

A blank line ends the run only when what follows resumes neither the list nor the current
item: `resumesList()` accepts the next item *or* an indented continuation. Checking only
for the next item — the first version — flushed the range at the blank line before a
loose item's own second paragraph, so cuts inside that paragraph became legal even though
it still belongs to the item above.

Cuts *at* the range's edges stay legal, because `isOffsetProtected()` compares strictly:
before the list and after it are both fine. Only the inside is refused.

A message that is mostly a list therefore offers few boundaries, or none. That is the
same trade already made for fenced code, and the same message says so.

<a id="SEG-09"></a>
### SEG-09 — Links are protected in every form that resolves
**Sites:** `src/segmentation.js` › `getProtectedRanges()` (`link`, `link-definition`)
**Related:** [SEG-02](#SEG-02)

Inline `[label](dest)`, full reference `[label][ref]`, collapsed `[label][]`, and the
`[ref]: dest` definition line. A cut inside a label splits it from its destination, and a
cut inside a definition leaves a dangling reference in text the model is asked to
continue — neither renders as a link afterwards.

The **shortcut** form — a bare `[label]` that resolves against a definition elsewhere —
is deliberately *not* protected. It is indistinguishable from ordinary bracketed prose,
and roleplay uses brackets constantly (`[OOC: ...]`, `[Note: ...]`). Protecting it would
silently remove boundaries from any message that brackets anything, which is a large,
invisible cost paid for a rare form. The consequence is stated rather than hidden: a
shortcut reference can be cut.

<a id="SEG-10"></a>
### SEG-10 — Dialogue is offered, and the risk is reported
**Sites:** `src/segmentation.js` › `BAD_SENTENCE_START_REGEX`, `describeCutRisks()`, `insideOpenQuote()`; `src/ui/commit-flow.js` › `confirmAndCommit()`
**Related:** [SEG-04](#SEG-04), [SEG-02](#SEG-02), [UI-03](#UI-03)

The first version refused any cut that sat inside a quotation, and any cut whose next
sentence began with a quote mark. Both rules are defensible in the abstract and wrong for
this product. Runtime testing on real roleplay made it obvious: in

```text
A small shrug inside the sweater. "It's not going to work like that."
```

*every* boundary a user would actually want was suppressed — the one before the dialogue,
because the next sentence starts with `"`, and the ones inside it, because the quotation
is open. Dialogue is the substance of roleplay, not an edge case, and an extension whose
whole purpose is to respond *inside* a message cannot decline to cut where the talking
happens.

So the two filters moved rather than disappearing. The parser offers the boundary;
`describeCutRisks()` inspects the preserved prefix and the confirmation screen says what
the cut leaves dangling — an open quotation, an unclosed Markdown delimiter. The user
decides.

This is a deliberate asymmetry with [SEG-02](#SEG-02), and the distinction is what makes
both coherent:

- **Structure stays hard-protected.** Code fences, inline code, links, macros, HTML tags,
  emphasis pairs, list runs: cutting these produces text that no longer *means* what it
  says — a dangling `](`, half a macro, a list that renumbers itself.
- **Style is advisory.** An open quotation still renders as text. It reads oddly, it is
  usually not what the user wanted, and it is occasionally exactly what they wanted
  (interrupting a speaker mid-sentence is a legitimate thing to do to a scene).

Only the prefix's final block is assessed: anything before a blank line is closed as far
as rendering is concerned. The risks are reported whenever the confirmation is shown, and
they are not gated behind `warnExtensions` — that setting is about *other extensions*,
while these describe this cut.

<a id="SEG-04"></a>
### SEG-04 — Sentence heuristics
**Sites:** `src/segmentation.js` › `segmentSentences()`, `ABBREVIATION_REGEX`, `BAD_SENTENCE_START_REGEX`, `insideOpenQuote()`

`Intl.Segmenter` when available, a punctuation regex otherwise. A candidate is rejected
when it follows an abbreviation or single initial, or when the next sentence starts with
continuation punctuation, a *closing* quote, or a lowercase letter — all of which mean the
segmenter split something that was not a sentence.

Opening quotes and unfinished quotations are no longer rejection reasons; see
[SEG-10](#SEG-10) for why that filter moved from the parser to the confirmation.

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
### UI-05 — Drafts are keyed by text, not by position
**Sites:** `src/ui/commit-flow.js` › `draftKey()`, `findDraftBoundaryIndex()`; `src/ui/selection.js` › `resolveSelectionTarget()`
**Related:** [UI-04](#UI-04), [UI-12](#UI-12)

Drafts store the raw-text offset, which is stable across the two interfaces — they may
filter their boundary lists differently, so a positional index would resolve to a
different boundary depending on which interface reopened.

The key is `chatId::targetIndex::sourceHash`. Position alone is not identity: a swipe, an
edit, or a rollback puts different text at the same index, and the stored offset then
points somewhere in text the user never saw — the draft would come back attached to a
boundary that means nothing. Including the hash makes that case a miss, which loses a
draft the user cannot use anyway, instead of restoring one onto the wrong message.

`resolveSelectionTarget()` computes the hash once, next to the boundaries it belongs
with, so both interfaces key drafts identically by construction.

Every path in or out of the map goes through `draftKey()` with the same identity object —
storing, reading, and *forgetting after a successful commit*. The commit path is the easy
one to miss, and missing it fails silently: the delete computes a key nothing was stored
under, so the map grows and the stale draft resurfaces the next time that message is
interceded. There is a test for the clearing path specifically, because nothing else
observes it.

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

Those events are not sufficient on their own, and the gap is easy to miss because the
slash commands keep working while the controls are absent. `GENERATION_ENDED` and
`CHARACTER_MESSAGE_RENDERED` both fire *before* the transaction commits, so the refresh
they trigger runs while `getCommittedTipRecord()` still returns nothing — the controls
stay hidden, and nothing refreshed afterwards until some unrelated event happened along.
The refresh is therefore also driven by [`intercede_invalidated`](#CFG-02), which by
construction fires *after* every canonical change. It is the one signal whose timing is
tied to the commit rather than to the generation.

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

<a id="UI-12"></a>
### UI-12 — One controller, two presentations
**Sites:** `src/ui/selection.js`; `src/ui/overlay.js`, `src/ui/inline-mode.js`
**Related:** [UI-01](#UI-01), [UI-03](#UI-03), [UI-04](#UI-04), [ANC-01](#ANC-01)

The two selection interfaces differ in exactly two things: where the markers are drawn,
and how the remainder is dimmed. Everything either side of that — resolving which message
is eligible, reading its raw source, computing boundaries, refusing a message with none,
building the composer, saving the draft, committing what the composer holds — was
duplicated line for line, and had already started to drift: a guard added to one mode was
not present in the other.

Duplication here is not a tidiness problem, it is a correctness one. A boundary rule, a
draft key, or an eligibility check that exists twice is a rule that can be *true in one
mode and false in the other*, and the user has no way to tell which mode they are in when
it matters. `resolveSelectionTarget()`, `buildComposer()`, `saveDraftFromState()`, and
`commitFromState()` hold the single copy; each mode supplies only its own rendering.

The split is drawn at the presentation seam rather than at a convenient line count: if a
change is invisible to the user, it belongs in `selection.js`.

<a id="UI-13"></a>
### UI-13 — Visual weight tracks consequence
**Sites:** `src/ui/settings.js`, `src/ui/selection.js`, `src/ui/overlay.js`, `style.css`
**Related:** [UI-07](#UI-07), [UI-12](#UI-12)

Every action control had the same visual weight regardless of what it did. The settings
drawer was a flat column of eight controls where snapshot retention sat flush against
cosmetic toggles; a one-digit day count got a full-width field; the panel's only button
floated in a wrapper styled solely with `margin-top: 4px`; the composer's rewrite-mode
`select` (`flex: 1 1 180px`) out-massed the commit and cancel buttons beside it; and the
overlay's icon-only dismiss carried `menu_button` chrome — reading exactly as loud as the
primary **Intercede** button in the same panel.

Weight is a claim about importance. When everything is equally loud, the claim is empty and
the user has to read every label to find the one control that matters. Sections with
headings, an action row anchored right above a rule, a field sized to its content, and a
dismiss quieter than a commit each restate the same hierarchy the prose already implies.

Two constraints on how far this goes:

- **Reuse the tokens that exist.** The section headings take
  `.intercede-compare-heading`'s treatment and the action row takes
  `.intercede-modal-buttons`'; the marker rest opacities (four arbitrary values across the
  two interfaces) collapse to `--ic-marker-rest` and `--ic-rule-rest`. A new visual idiom
  per surface is how two interfaces drift apart — the same failure [UI-12](#UI-12)
  describes for logic.
- **Never buy consistency with a moved click target.** `showConfirm` renders
  primary-then-secondary into a `flex-end` footer, so **Undo** sits left of **Keep** and
  **Intercede** left of **Back** — the opposite of the usual primary-rightmost convention.
  Reversing it would relocate the button under the user's cursor on the two most
  consequential dialogs in the extension, to satisfy a convention. The composer was changed
  to match the modal instead; the modal was left alone.

**The settings drawer is bound by `id`, after the fact.** `initSettingsPanel()` inserts
`PANEL_HTML` and *then* attaches every handler by element id, so wrapper elements — the
sections, the headings, the action row this rule introduced — can be rearranged freely for
layout, but no `id` may move to a different control or disappear. A layout pass that
renames one breaks the binding silently: the panel still renders, and the control it
belongs to simply stops doing anything. `tests/settings-panel.test.js` enumerates every
bound id and asserts the markup still carries it.

**The width correction has to be global.** SillyTavern styles `.menu_button` as
`width: min-content`, which wraps a multi-word label one word per line — and inside
`.mes_text` (`overflow-wrap: anywhere`) min-content is one *character*. The stylesheet
already corrected this, but only under `.intercede-composer-controls`, where it was first
noticed. Everything else inherited the bug: **Clean up now** rendered as three stacked
lines in the settings drawer, and the finalize dialog's **Delete snapshot** / **Keep it**
stacked for the same reason. A fix scoped to the surface where a bug was *observed*, rather
than to the surface the cause spans, is not a fix — it is a delay.

`tests/button-layout.test.js` parses the covered selector list out of `style.css` and
asserts that every button the extension actually renders is matched by it, so a button
added to a new container fails rather than quietly stacking.

What this rule does *not* touch: whether an action confirms, what it deletes, or where it
can be reached from. Those are behavioural questions, and the layout pass deliberately
answered none of them — `snapshotTtlDays` still defaults to `0`, so **Clean up now** still
reports a count rather than deleting, and `finalize`, `recover`, and `diagnostics` are still
slash-command-only.

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

`intercede_invalidated` is the umbrella signal, emitted *in addition to* — and immediately
after — each of the four specific outcomes (`committed`, `rolled_back`, `undone`, and the
rollback inside snapshot recovery). A listener that only needs to know "history moved" can
subscribe to this one event instead of tracking all four, and a fifth outcome added later
still reaches it.

Its payload carries `fromIndex` alongside `affectedMessageIds`, because an intercession
inserts and removes messages: every index at or after `fromIndex` may have *shifted
position*, not merely changed text. A consumer that invalidates only the listed ids will
keep stale state for everything below them. `fromIndex` is `null` when no message ids
could be determined — treat that as "invalidate everything", not as "nothing changed".

<a id="CFG-03"></a>
### CFG-03 — The switch stops new intercessions, not recovery
**Sites:** `src/ui/open.js` › `openIntercede()`; `src/ui/message-button.js` › `refreshButtonVisibility()`
**Related:** [TX-14](#TX-14), [TX-15](#TX-15), [REC-01](#REC-01)

`settings.enabled` is enforced in `openIntercede()`, which every entry point funnels
through — the wand item, Alt+I, the per-message button, and bare `/intercede`. One gate,
because four gates are four chances for one of them to be missed; that is precisely how
the setting came to be decorative in the first place.

It deliberately does **not** gate `/intercede undo`, `compare`, `recover`, `finalize`, or
recovery-on-chat-change. Switching an extension off is a statement about what it should do
next, not consent to strand a committed intercession with no way back. If turning Intercede
off also removed undo, the user's own snapshot would become unreachable by the very action
that was supposed to make the extension harmless.

The wand entry is added once at init, so visibility has to be refreshed when the setting
changes rather than decided at construction. The per-message button follows the same call.

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
