# Release test results

One section per release candidate. Record what was actually run, on what, and what the
diagnostics said — not a verdict. A row with no evidence is an untested row, and a row the
maintainer chose not to walk is recorded as exactly that: an accepted gap, named, not
quietly folded into a pass.

Walk the matrix in [RELEASE-QA.md](RELEASE-QA.md). Paste the `/intercede diagnostics`
console report before and after each group; it is metadata only and safe to share
([LEASE-14](RATIONALE.md#LEASE-14)).

Fields that were not captured are written `not recorded`. Never reconstruct one from
memory — a plausible-looking backend name is worse than an admitted blank, because a later
reader cannot tell which rows it invalidates.

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

## v0.7.0 — released

Tagged at `cac71547548f47e9ddc20420c216166b79dbf10d` and published.

Automated suite at the tag: **304 passed, 18 files**, ESLint clean. The default prompt was
confirmed byte-identical to v0.6.0 for every rewrite strength — the regression guard the whole
release rests on. Documentation work after the tag added `tests/docs.test.js`, taking `main`
to 308 across 19 files with no extension source change.

```text
Released:         v0.7.0 (commit cac71547548f47e9ddc20420c216166b79dbf10d)
Node:             v24.13.1 (local run)
SillyTavern:      1.18.0+ (exact installed commit not recorded)
Backend:          Claude via chat completion (exact provider route not recorded)
Streaming:        not recorded
Browser / OS:     not recorded
Tester / date:    TesterBender, 2026-08-02
```

Live validation was **targeted at what the release changed** rather than a re-walk of the
whole matrix:

| Group | Status | Evidence |
|---|---|---|
| Automated suite | **pass** | 304 tests, 18 files, ESLint clean; default prompt byte-identical to v0.6.0 across all three strengths |
| Custom template reaches the backend | **pass** | the authored template observed in the outgoing request |
| Literal `{{mode}}` in a continuation | **pass** | survives unchanged — the defect reported against the development build ([PROMPT-03](RATIONALE.md#PROMPT-03)) |
| Mode wording placement | **pass** | appears from the template's own marker, separately from the continuation's text |
| Swipe after changing prompt configuration | **pass** | the re-lease path (`src/lease.js`) rebuilds from the active configuration |
| Ordinary intercession | **pass** | Claude chat completion |
| `terse` preset on small local models | not run | **shipped as a starting point, not a validated configuration** |
| Non-streaming cancellation | not run | accepted gap, carried forward |
| Text-completion backend | not run | accepted gap, carried forward |
| Broad local-LLM range | not run | accepted gap, carried forward |
| Mobile layout | not run | accepted gap, carried forward |
| Keyboard-only flow | not run | accepted gap, carried forward |
| Extended repeated-use session | not run | accepted gap, carried forward |
| Third-party extension matrix | not run | accepted gap, carried forward |

Three template-injection defects were found and fixed inside this cycle and never reached a
release: a literal `{{mode}}` in the set-aside continuation being expanded — reported from a
development build, and the reason the row above exists — `$&`/`$'` being expanded as
`String.replace` patterns, and only the first container around a `{{suffix}}` marker being
defended. All three are covered by `tests/prompt-config.test.js`
([PROMPT-03](RATIONALE.md#PROMPT-03)). None of them existed in v0.6.0, which assembled its
instruction from a fixed array of lines with no placeholder substitution at all.

The accepted gaps above are **disclosed coverage, not observed failures**, on the same terms
as v0.6.0's. They now have a standing home in
[COMPATIBILITY.md](COMPATIBILITY.md#areas-seeking-community-reports), because after a release
they are requests for reports rather than release blockers.

---

## v0.6.0 — release candidate

Automated suite: **257 passed, 17 files** (`npm run check`, Node 24), run locally by the
maintainer from a clean checkout. The `optional capabilities unavailable (fallbacks in
use): sendMessageAsUser, SlashCommandParser` line in that output is the fake host reporting
what it deliberately omits — expected, and the reason those fallbacks have coverage at all.

```text
Candidate:        v0.6.0 (final commit recorded at the end of this section)
SillyTavern:      1.18.0+ (exact installed commit not recorded)
Backend:          Claude via chat completion (exact provider route not recorded)
Streaming:        on — "stream": true observed in the outgoing request
Browser / OS:     Chromium-based on Windows; exact versions not recorded
Tester / date:    TesterBender, 2026-08-01

Build check:      lease.events contains opaqueEnds?      yes
```

| Group | Status | Evidence |
|---|---|---|
| Idle diagnostics, console | **pass** | `version 0.6.0`, `capabilities.ok`, `0 open`, `open: []`, no lease, no journal, all counters `0` |
| Idle diagnostics ×3, composer | **pass** | each: `generation idle — host idle (weak) via #mes_stop — 0 open — 1 reconciled now`; the count did not climb |
| Normal intercession | **pass** | committed as a real history transformation; three-role result |
| Compare | **pass** | insertion, discarded non-canonical continuation, revised canonical continuation and the overlap indicator all shown correctly |
| Undo | **pass** | committed tip intercession restored through the ordinary undo path |
| Stop / cancel, streaming | **pass** | exercised with streaming on |
| Nested quiet overlap | **pass** | instruction stripped, uninstructed continuation refused, original restored, only owned messages removed, insertion retained, journal cleared, lease disarmed, one rollback notice |
| Final lifecycle state | **pass** | `0 open`, no lease, no journal, `auditClosed: true`, `kindMismatchedEnds`/`unmatchedEnds`/`unmatchedConfirmations` all `0` |
| Duplicate failure notice | **fixed, not re-walked live** | observed on the earlier build; corrected under [ERR-02](RATIONALE.md#ERR-02) and covered by `tests/notifications.test.js`. Not manually reproduced on the final build — see accepted gaps |
| Stop / cancel, non-streaming | not run | accepted gap |
| Ten-intercession soak | not run | accepted gap — maintainer waived |
| Mobile layout | not run | accepted gap |
| Keyboard-only flow | not run | accepted gap |
| Text-completion backend | not run | accepted gap |
| Local-LLM backend | not run | accepted gap |
| Third-party extension matrix | not run | accepted gap |

### Accepted untested coverage

The maintainer has reviewed the rows above marked *accepted gap* and released with them
open, relying on field reports and contributions for rarer environments. They are disclosed
coverage gaps, **not** observed failures, and no row here is a claim that something is
broken.

Two of them were withdrawn deliberately rather than skipped, because they are not things a
person can meaningfully do by hand:

- **Defaulted and opaque event kinds.** These are host event *arguments*, not user actions.
  A maintainer cannot type an absent JavaScript argument. Covered by
  `tests/capture.test.js`, which drives absent, named, unrecognized-string, numeric, object
  and boolean type payloads through the real transaction, and by the structural ownership
  proof that every candidate still has to pass ([CAP-06](RATIONALE.md#CAP-06)).
- **A deliberately sabotaged capture.** Reproducing this by hand means editing the host at
  runtime to suppress a message event. Covered by `tests/notifications.test.js`: one
  terminal failure produces one notice, no recovery is offered when no journal remains,
  an unresolved journal still produces one, and the typed response survives either way
  ([ERR-02](RATIONALE.md#ERR-02)).

Group chats and historical-message intercession are unsupported by design, not untested.

### Counters after the earlier mixed session

Coherent and settled:

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

### Observations carried into the release

**The host probe answered `#mes_stop (weak)` throughout.** Neither `ctx.isGenerating` nor
`body.dataset.generating` produced an answer on this build, so every eligibility decision
came from the weakest source in [HOST-06](RATIONALE.md#HOST-06). Nothing failed because of
it. It is the reason non-streaming cancellation is the most interesting of the accepted
gaps: streaming cancellation passed, and that is the path where the probe has the most
help.

**One transient "No assistant continuation was captured", on the earlier build.** Not
reproduced, and safe when it happened — the transaction failed closed, deleted nothing, and
ordinary generation worked after a reload. One of its possible causes is now eliminated:
capture could discard a message whose type argument it did not recognize
([CAP-06](RATIONALE.md#CAP-06)). Whether that was *this* occurrence is unknown and will
stay unknown; a recurrence now arrives with counts per reason and a transaction id
([CAP-07](RATIONALE.md#CAP-07)) instead of a third round of speculation.

**Two contradicting toasts for that one failure** — *"stopped without changing anything
further … run recover"* and *"failed and was rolled back"*. Only the first was true. Fixed
under [ERR-02](RATIONALE.md#ERR-02) with regression coverage; not re-walked live.

**`AutoComplete.updateFloatingPosition` threw `getBoundingClientRect` of null.** Raised in
SillyTavern's own autocomplete while a slash command was being typed. The trace contains no
Intercede frame, and the extension references no composer or autocomplete selector in JS or
CSS. Recorded as a host observation; not an Intercede defect and not acted on.

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
