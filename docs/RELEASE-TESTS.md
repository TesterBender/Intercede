# Release test results

One section per release candidate. Record what was actually run, on what, and what the
diagnostics said — not a verdict. A row with no evidence is an untested row.

Walk the matrix in [RELEASE-QA.md](RELEASE-QA.md). Paste the `/intercede diagnostics`
console report before and after each group; it is metadata only and safe to share
([LEASE-14](RATIONALE.md#LEASE-14)).

## Template

```text
Candidate:        v0.6.0 (commit ………)
SillyTavern:      1.18.0 (commit ………)
Backend:          e.g. Claude via chat completion / koboldcpp via text completion
Streaming:        on | off
Browser / OS:     ………
Tester / date:    ………

Build check:      lease.events contains opaqueEnds?      yes | no
                  (no ⇒ stale checkout, stop and reload)

Diagnostics before: ………
Diagnostics after:  ………

Matrix rows:      pass | fail | not run, with a note for anything but pass
```

## v0.6.0 — candidate

Automated suite at the head of `p3-release-lifecycle`: **256 passed, 17 files**
(`npm run check`, Node 24).

### Live session — lifecycle build (`58ced79`)

```text
Candidate:        v0.6.0 (58ced79)
SillyTavern:      1.18.0 (exact commit not recorded)
Backend:          not recorded
Streaming:        not recorded
Browser / OS:     not recorded
Tester / date:    TesterBender, 2026-08-01

Build check:      lease.events contains opaqueEnds?      yes
```

Recording the four unrecorded fields is a prerequisite for the tag: several rows in
[RELEASE-QA.md](RELEASE-QA.md) behave differently per backend, and "passed somewhere"
cannot tell a later reader which.

| Group | Status | Evidence |
|---|---|---|
| Idle diagnostics, console | **pass** | `0 open`, no lease, no journal, every counter `0` |
| Idle diagnostics ×3, composer | **pass** | each: `generation idle — 0 open — 1 reconciled now`; the count did not climb |
| Normal intercession | **pass** | committed; three-role history; amber meta-commentary warning alongside it (advisory) |
| Nested quiet overlap | **pass** | instruction stripped, uninstructed continuation refused, original restored, journal cleared, lease disarmed |
| Failure notice quality | **fail** | one failure, two contradicting toasts — see below |
| Stop / cancel, streaming | not run | |
| Stop / cancel, non-streaming | not run | |
| Ten intercessions | not run | |
| Undo | not run | |
| Mobile + keyboard | not run | |

Final counters, coherent and settled:

```text
starts 10   namedStarts 6   defaultedStarts 4   opaqueStarts 0   confirmedStarts 4
ends 4      opaqueEnds 4    kindMismatchedEnds 0  unmatchedEnds 0  unmatchedConfirmations 0
reconciledFromHostIdle 6    reconciledUnconfirmed 6    openCount 0
leaseArmed false   journal null   auditClosed true
```

Four confirmed generations with four ends; six starts that never became generations,
reconciled at host idle. `opaqueStarts 0` and `kindMismatchedEnds 0` are the two values
that say the host contract is where [LEASE-12](RATIONALE.md#LEASE-12) and
[LEASE-13](RATIONALE.md#LEASE-13) assume it is. **The ever-growing open count is fixed in
real use, not only in the model.**

### Observations from that session

**The host probe answered `#mes_stop (weak)` throughout.** Neither `ctx.isGenerating` nor
`body.dataset.generating` produced an answer on this build, so every eligibility decision
came from the weakest source in [HOST-06](RATIONALE.md#HOST-06). Nothing failed because of
it, but it is why non-streaming cancellation is still the row that most needs walking.

**One transient "No assistant continuation was captured", after the interference probe.**
Not reproduced; ordinary generation worked again after a reload. Addressed from two
directions rather than guessed at — see [CAP-06](RATIONALE.md#CAP-06) for a filter that
could have discarded the message and [CAP-07](RATIONALE.md#CAP-07) for the evidence a
recurrence will now carry. Watch for it during the ten-intercession row.

**Two contradicting toasts for that one failure** — *"stopped without changing anything
further … run recover"* and *"failed and was rolled back"*. Only the first was true. Fixed
under [ERR-02](RATIONALE.md#ERR-02); re-walk the failure rows in RELEASE-QA.

**`AutoComplete.updateFloatingPosition` threw `getBoundingClientRect` of null.** Raised in
SillyTavern's own autocomplete while a slash command was being typed. Intercede does not
touch `#send_textarea` or the autocomplete DOM, and the trace contains no Intercede frame.
Recorded as a host observation; not a release blocker and not acted on.

**The meta-commentary warning fired on a good continuation.** Two patterns were retired as
ordinary prose rather than commentary ([VAL-05](RATIONALE.md#VAL-05)).

### Prior session (pre-fix build, `d883481`)

Kept because the safety result is still meaningful; the diagnostics from it are not.

**Passed — the nested quiet overlap fail-closed path.** With a deterministic probe
starting a quiet generation inside `GENERATION_STARTED`, the outgoing request contained
the preserved prefix, the inserted user message and the ordinary system prompt but **no
rewrite instruction**. Intercede detected the loss, refused the continuation, restored the
original assistant message, removed the inserted user message and the generated
continuation, retained the typed insertion for retry, cleared the journal and disarmed the
lease. This is [LEASE-05](RATIONALE.md#LEASE-05) working as designed.

**Void — the diagnostics from that session.** The report listed the seven pre-fix tallies
with no `opaqueEnds`, so it came from `d883481`, not from the lifecycle fix. Specifically:

- `kindMismatchedEnds: 12` of `ends: 12` — every real completion scored as a mismatch,
  which is the defect fixed in [LEASE-12](RATIONALE.md#LEASE-12);
- `openGenerations: 2`, both `normal`, climbing by one per `/intercede diagnostics` —
  abandoned composer slash-command starts, reported before reconciliation could clear
  them ([LEASE-15](RATIONALE.md#LEASE-15), [LEASE-10](RATIONALE.md#LEASE-10)).

Both must be re-measured on the fixed build before they mean anything.
