# Intercede v0.6.0 — draft release notes

**Not published.** Publish only after the live matrix in
[RELEASE-QA.md](RELEASE-QA.md) has been walked and recorded in
[RELEASE-TESTS.md](RELEASE-TESTS.md).

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
  aborts without ever emitting an end. Those abandoned starts are labelled via
  `GENERATION_AFTER_COMMANDS` and reconciled against the host before a lease takes its
  baseline, so they can no longer be mistaken for a concurrent generation.
- Eligibility, diagnostics and the lease baseline now share one atomic
  probe-reconcile-report step, so a report can no longer describe records the same call is
  about to discard.

## Diagnostics

- `/intercede reset` (and `Intercede.resetDiagnostics()`) clears counters and the event
  log. It touches no lease, open-record or transaction state.
- `Intercede.setDebugLifecycle(true)` enables a bounded 64-entry lifecycle log in the
  diagnostics report: event names, argument shapes, resolved kinds, open counts before and
  after. No prompt or chat content is recorded.
- New counters distinguish named, defaulted and opaque starts, opaque versus
  kind-mismatched ends, confirmed starts, and records reconciled by the current call.
- The toast is one line reporting only what is abnormal; the full report stays in the
  console.

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
