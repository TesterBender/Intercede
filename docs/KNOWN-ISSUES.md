[← Documentation](README.md) · [Troubleshooting](TROUBLESHOOTING.md) · [Testing status](TESTING-STATUS.md) · [Report a problem](REPORTING-PROBLEMS.md)

# Known issues

What is on record, sorted by how well established it is. A problem being listed here is not a
promise that it will be fixed, and an empty section is not a claim that nothing is wrong —
see [TESTING-STATUS.md](TESTING-STATUS.md) for how little of the matrix has been walked.

Deliberate limitations are **not** listed here. They are in
[the README](../README.md#limitations-v07), and the deferred ones are in
[ROADMAP.md](ROADMAP.md).

## Confirmed

Reproduced by the maintainer, or supported by multiple matching reports.

*None currently open.* The defects found during the v0.6.0 and v0.7.0 cycles were fixed before
their release; they are listed under [Resolved](#resolved) so that a report matching one of
them can be told apart from a regression.

Read that as narrowly as it is written. Most of the environment matrix has never been walked
([testing status](TESTING-STATUS.md)), so an empty *confirmed* section means nobody has
looked in most places, not that nothing is there.

## Under investigation

Real evidence, not yet reproduced.

### A single unreproduced capture failure

One intercession failed with *"No assistant continuation was captured for this
intercession."* during the v0.6.0 live session, after a run of deliberate interference
testing, and never recurred. It failed safely: nothing was committed, nothing was deleted, and
ordinary generation worked afterwards.

Three explanations were open. One is now eliminated — capture could discard a message whose
type argument it did not recognise, which was removed under
[CAP-06](RATIONALE.md#CAP-06). Whether that was *this* occurrence will stay unknown. The
other two remain: the host may have produced no message at all because the test probe had left
it in an odd state, or something happened in the capture window that nothing recorded.

**A recurrence now arrives with evidence** — per-reason counts and a transaction id
([CAP-07](RATIONALE.md#CAP-07)) instead of a third round of speculation. If you see this
message, the diagnostics report is the most useful thing anyone could file.

*Tracked in [RATIONALE.md § Open questions](RATIONALE.md#open-questions), item 6.*

## Needs more information

Things that may or may not be problems. Not enough to act on.

### The host generation probe answers from its weakest source

Every live report so far reads `#mes_stop (weak)`, meaning neither `ctx.isGenerating` nor
`body.dataset.generating` produced an answer on that build — so the weakest link in the probe
chain ([HOST-06](RATIONALE.md#HOST-06)) is carrying every eligibility decision in practice.

Nothing has failed because of it, and the flag is read as busy-only, so one that never appears
costs nothing. It is the reason **non-streaming cancellation** is the untested row most worth
walking: streaming cancellation passed, and that is the path where the probe has the most
help.

### Whether reconciliation fires promptly enough

The open-generation count drifts upward by design — SillyTavern emits fewer
`GENERATION_ENDED` events than starts ([LEASE-12](RATIONALE.md#LEASE-12)), and a composer
slash command starts a generation that aborts before the stop button is ever shown
([LEASE-15](RATIONALE.md#LEASE-15)). Reconciliation clears the drift, and `armLease()` now
reconciles before taking its baseline so drift cannot be misread as an overlap.

What is unestablished is whether that happens promptly enough under sustained real use. Watch
`reconciledNow`, `reconciledUnconfirmed` and `unconfirmedOpen` in `/intercede diagnostics`. A
count that climbs and never settles is a report.

### The `terse` preset has not been tuned against the models it is for

Shipped in v0.7.0 for small local models. It has not been through the tuning the other two
presets have, and has not been validated against a broad selection of the models it targets.
It is a starting point, not a validated configuration — and it is the single most useful thing
a local-model user could [report on](COMPATIBILITY.md#areas-seeking-community-reports).

## Not Intercede

Observed during Intercede testing, but not caused by it. Recorded so the same trace is not
investigated twice.

### `AutoComplete.updateFloatingPosition` — `getBoundingClientRect` of null

Raised inside SillyTavern's own slash-command autocomplete while a command was being typed.
The stack contains no Intercede frame, and the extension references no composer or
autocomplete selector in either JavaScript or CSS. Host observation; not acted on.

## Resolved

Fixed. Kept so that a matching report can be identified as a regression rather than a
rediscovery.

The three template rows never reached a released version. v0.6.0 assembled its instruction
from a fixed array of lines with no placeholder substitution at all, so it had nowhere for any
of them to happen; they were introduced by the v0.7.0 prompt work and closed inside the same
cycle, before the tag. The first was found in the field, on a development build, by a
continuation containing a literal `{{mode}}` — and is now a live-validated row in
[RELEASE-TESTS.md](RELEASE-TESTS.md#v070--released).

| Issue | Introduced | Fixed | Rule |
| --- | --- | --- | --- |
| A literal `{{mode}}` inside the set-aside continuation was expanded into the mode wording | v0.7.0 dev | v0.7.0, before tagging | [PROMPT-03](RATIONALE.md#PROMPT-03) |
| A continuation containing `$&` or `$'` was expanded as a `String.replace` pattern | v0.7.0 dev | v0.7.0, before tagging | [PROMPT-03](RATIONALE.md#PROMPT-03) |
| Only the first container a template opened around `{{suffix}}` was defended against early closing | v0.7.0 dev | v0.7.0, before tagging | [PROMPT-03](RATIONALE.md#PROMPT-03) |
| Two contradicting notices for one failure — "stopped … run recover" *and* "failed and was rolled back" | v0.6.0 | [ERR-02](RATIONALE.md#ERR-02) |
| Every real completion scored as a kind mismatch (`kindMismatchedEnds: 12` of `ends: 12`) | v0.6.0 | [LEASE-12](RATIONALE.md#LEASE-12) |
| The open-generation count climbed by one per `/intercede diagnostics` and never settled | v0.6.0 | [LEASE-15](RATIONALE.md#LEASE-15) |
| Capture discarded a continuation whose event type argument it did not recognise | v0.6.0 | [CAP-06](RATIONALE.md#CAP-06) |
| The meta-commentary warning fired on ordinary prose | v0.6.0 | [VAL-05](RATIONALE.md#VAL-05) |
| Diagnostics described lease records that no longer existed by the time they were read | v0.6.0 | [LEASE-11](RATIONALE.md#LEASE-11) |

All of them are recorded in full in [RELEASE-TESTS.md](RELEASE-TESTS.md), and the v0.7.0 rows
also in [RELEASE-NOTES-v0.7.0.md](RELEASE-NOTES-v0.7.0.md).

## Adding to this page

File a report — [how](REPORTING-PROBLEMS.md). Entries land in *needs more information* by
default and move up as evidence accumulates. Nothing is written into *confirmed* on a single
report unless it has been reproduced.
