# Intercede v0.6.0 — draft release notes

**Not published, and nothing is tagged.** Everything below is prepared text.

```text
Tag:      v0.6.0          (annotated, on the merge commit — not on the branch)
Title:    Intercede v0.6.0 — respond inside a completed message
Body:     everything below the rule, from "Respond inside…" onward
Assets:   none — SillyTavern installs from the repository URL
```

Publish only once, in this order:

1. the live matrix in [RELEASE-QA.md](RELEASE-QA.md) has been walked on the **fixed build**
   and recorded in [RELEASE-TESTS.md](RELEASE-TESTS.md), including the backend, browser and
   streaming state;
2. the branch is merged and CI is green **on the merge commit**;
3. a clean install from the repository URL has been loaded once and `/intercede diagnostics`
   reports version `0.6.0` with `opaqueEnds` present.

---

Respond inside an already completed assistant message. Pick a boundary, write your reply,
and the remainder is regenerated as a real Assistant → User → Assistant exchange, with the
original continuation kept as recoverable, non-canonical editorial reference.

Requires **SillyTavern 1.18.0+**. No server plugin, no external services, nothing leaves
your browser.

## Highlights

- **Genuine three-role history.** The preserved prefix is byte-for-byte what was written
  before your cut; your insertion is a real user-role message; the continuation is an
  ordinary assistant message you can swipe, compare, or intercede in turn.
- **Everything runs as a transaction.** Snapshot first, source-anchored cuts validated
  against raw message text, proven ownership of every message created, selective rollback
  that never truncates by length, and a synchronous recovery journal for crashes and
  refreshes.
- **One-generation prompt lease.** The rewrite instruction is installed from inside a
  matching `GENERATION_STARTED` and cleared on every exit path. If another generation
  overlaps and strips it, Intercede rolls its own continuation back rather than committing
  a reply the instruction never reached.
- **Undo restores the original exactly** — text, swipes and metadata — while the
  intercession is still the chat tail.
- `/intercede diagnostics` reports what the host actually did, so a bug report can be
  pasted rather than described.

## Host lifecycle correctness

This release is built against SillyTavern 1.18.0's real event behaviour, read from its
source rather than assumed:

- `GENERATION_ENDED` carries `chat.length`, not a generation kind, and is emitted only
  from `hideStopButton()`. It is treated as an opaque completion signal; a payload steers
  record matching only when it demonstrably names a kind.
- `stopGeneration()` emits the end *before* `GENERATION_STOPPED`. Both handlers are
  order-independent.
- A slash command typed into the composer runs a `Generate()` that emits a start and then
  aborts without ever emitting an end. `GENERATION_AFTER_COMMANDS` **confirms** the starts
  that survived command processing; an abandoned one is recognised by the *absence* of that
  confirmation and reconciled once the host is stably idle — before a lease takes its
  baseline, so it can no longer be mistaken for a concurrent generation. In practice: every
  `/intercede …` you type used to leave a record behind, and enough of them made a perfectly
  valid intercession refuse with "another generation overlapped".
- Eligibility, diagnostics and the lease baseline now share one atomic
  probe-reconcile-report step, so a report can no longer describe records the same call is
  about to discard.
- The same conservatism now applies to identifying the continuation. `MESSAGE_RECEIVED`
  carries a type argument, and capture used to discard any message whose type it did not
  recognise — then report that nothing had been generated. A value is excluded only when it
  is demonstrably a *different named kind*; anything unrecognised is admitted and left to
  the structural ownership proof, which fails closed on its own terms.

## When something goes wrong

- **One failure, one message.** A transaction that stops for review and one that rolls back
  are different outcomes, and Intercede used to announce both at once — a sticky notice
  saying the chat had been left untouched, with a second toast on top claiming everything
  had been rolled back. Only the first was ever true. The transaction now owns its own
  notice, and `/intercede recover` is offered only when something is genuinely left to
  recover.
- A failed capture writes one console line, with a short transaction id and a count of what
  it saw and why each event was set aside — enough to tell "the host announced nothing" from
  "the message arrived and was rejected". Counts and kind names only.
- Quality warnings are advisory and now read that way. Two meta-commentary patterns were
  retired for firing on ordinary in-character prose: *"per your instructions"* is something
  characters say, and *"original draft"* belongs to any scene with a writer in it.

## Diagnostics

- `/intercede reset` (and `Intercede.resetDiagnostics()`) clears counters and the event
  log. It touches no lease, open-record or transaction state.
- The bounded 64-entry lifecycle log is **always recorded** — event names, argument shapes,
  resolved kinds, open counts before and after, and no prompt or chat content, by
  construction rather than by care. `Intercede.setDebugLifecycle(true)` includes it in the
  diagnostics report; `Intercede.lifecycleLog()` reads it regardless. A buffer you have to
  switch on before the fault happens is empty in the session that needed it.
- New counters distinguish named, defaulted and opaque starts, opaque versus
  kind-mismatched ends, confirmed starts, and records reconciled by the current call.
- The toast is one line reporting only what is worth a second look; the full report stays
  in the console. From the composer it will normally say `0 open — 1 reconciled now`,
  because the command is itself a generation SillyTavern abandoned.

## Known limitations

Carried from the README:

- Latest completed assistant message only; one intercession at a time.
- Group chats are not supported yet.
- Undo is available only while the intercession is the chat tail, so chains unwind
  newest-first.
- Undo snapshots live in browser storage and do not travel with exported chats.
- No cutting inside code fences, inline code, HTML tags, macros, paired Markdown emphasis,
  list runs, or links. Shortcut links (`[label]`) are indistinguishable from bracketed
  prose and are left unprotected.
- An intercession another extension disturbs mid-generation is rolled back, not repaired.

## License

MIT.
