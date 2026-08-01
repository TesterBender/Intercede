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

Automated suite at the head of `p3-release-lifecycle`: **217 passed, 14 files**
(`npm run check`, Node 24). Live matrix: **not yet walked.**

| Group | Status | Evidence |
|---|---|---|
| Idle diagnostics ×3 | not run | |
| Normal intercession | not run | |
| Nested quiet overlap | partially run — see below | pre-fix build |
| Stop / cancel, streaming | not run | |
| Stop / cancel, non-streaming | not run | |
| Ten intercessions | not run | |
| Mobile + keyboard | not run | |

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
