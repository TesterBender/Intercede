# Release QA — live host matrix

The automated suite runs against a jsdom fake. It proves the logic; it cannot prove the
host. Everything below is what a real SillyTavern **1.18.0** installation is for.

Record outcomes in [RELEASE-TESTS.md](RELEASE-TESTS.md), including the ones you skip.

## How much of this is required

The full matrix is **recommended** for high-confidence compatibility coverage, ideally
against one chat-completion and one text-completion backend, noting which backend exercised
each row.

The **minimum release gate** is narrower, and deliberately so:

- the automated suite passes on the commit being released, and CI agrees;
- a normal intercession commits, on at least one live backend;
- rollback, undo and `/intercede diagnostics` behave on that same build;
- the prompt-integrity path fails closed — a generation that overlaps and strips the
  instruction must roll back rather than commit;
- no known defect can corrupt canonical history.

A release may proceed with rows marked `not run`, provided the maintainer accepts the gap
knowingly and it is written down. That is a judgement about *compatibility breadth*, which
field reports cover well. It is not a judgement about safety, which they do not: the gate
rows above are the ones where a defect silently damages a chat, and they are not waivable.

Rows that cannot be produced by hand — an absent event argument, a suppressed message
event — belong in the automated suite and are listed as such in
[RELEASE-TESTS.md](RELEASE-TESTS.md). Do not ask a person to manufacture them.

## Before you start: confirm which build is loaded

`manifest.json` sets `auto_update: false`, and a version string is reported just as
confidently by a stale checkout as by a current one. Run `/intercede diagnostics` and check
the console report:

- `version` is `0.7.0`;
- `lease.events` contains **`opaqueEnds`**, `namedStarts`, `defaultedStarts`,
  `opaqueStarts`, `confirmedStarts` and `reconciledUnconfirmed`;
- `lease.reconcileReason` is present;
- a **`prompt`** block is present, reporting `preset`, `customized` and `fallback`. A report
  without it is pre-v0.7.0 regardless of what its `version` says.

A report whose `events` block has only `starts / dryRuns / ends / unmatchedEnds /
kindMismatchedEnds / reconciledFromHostIdle / stops` is the **pre-fix build**. Findings
from it do not apply. Reload the extension before testing anything below.

## Verified host behaviour (SillyTavern 1.18.0)

Read from the shipped `public/script.js`. The adapter is built on these and the tests
encode them; if a future build changes any of them, the adapter changes here first.

| Event | Emitted by | Payload |
|---|---|---|
| `GENERATION_STARTED` | `Generate()`, before slash-command processing | `(type, params, dryRun)` — `type` is `undefined` for an ordinary send |
| `GENERATION_AFTER_COMMANDS` | `Generate()`, only if commands did **not** abort it | same shape as the start |
| `GENERATION_ENDED` | `hideStopButton()` only | `chat.length` — an integer, never a kind |
| `GENERATION_STOPPED` | `stopGeneration()`, **after** it calls `hideStopButton()` | none |
| `MESSAGE_RECEIVED` | streaming and non-streaming paths | `(messageId, type)` — a bare integer index |

Three consequences that the matrix below is designed to exercise:

1. **`GENERATION_ENDED` is edge-triggered on the stop button**, not emitted per
   generation. Overlapping generations produce fewer ends than starts.
   ([LEASE-12](RATIONALE.md#LEASE-12))
2. **A slash command typed into the composer runs a `Generate()` that emits a start and
   then aborts** without ever showing the stop button — so it emits no end at all. Every
   `/intercede …` leaves one abandoned `normal` record until reconciliation clears it.
   ([LEASE-15](RATIONALE.md#LEASE-15))
3. **The end precedes the stop** when cancelling with an abort controller.
   ([LEASE-09](RATIONALE.md#LEASE-09))

## Core behaviour

| Test | Required result |
| --- | --- |
| Non-streaming chat-completion response | Exactly Assistant prefix → User insertion → Assistant continuation |
| Non-streaming text-completion response | Same canonical role sequence |
| Streaming enabled | Completes safely, or refuses with a clear message |
| Stop during generation | Exact rollback; no leased prompt survives |
| Backend or API failure | Original message, swipes, metadata and count restored |
| Empty model response | No empty assistant suffix committed |
| Regenerate / swipe continuation | New swipe reuses the same discarded-suffix reference |
| Undo at chat tip | Complete original object and swipe set restored |
| Foreign extension inserts a message | Foreign message untouched by rollback |
| Prompt Inspector or another prompt modifier active | Lease applies only to the intended generation |
| Quiet / background generation overlaps | Intercede does not consume the wrong generation |
| Display regex enabled | Raw prefix remains byte-correct |
| Refresh after prefix mutation | Recovery journal restores or safely resumes |
| Refresh after user insertion | No permanently split or corrupted history |
| Mobile layout | Composer, boundary selection, cancel and commit usable |
| Keyboard operation | Focus order, Escape, Enter and the commit shortcut work |

## Prompt configuration (v0.7.0)

The automated suite covers resolution and fallback against a simulated host. What it cannot
cover is what a real backend does with an instruction it has not seen before — which is the
entire subject of this section.

| Test | Required result |
| --- | --- |
| Upgrade from v0.6.0 without opening the Prompt section | The armed instruction is unchanged; `prompt.customized` is `false` |
| Each built-in preset, one intercession | Commits normally; no filter rejection from the backend |
| `terse` preset on a small local model | Commits without the model narrating the instruction back |
| Custom template with a renamed container | Commits; the container name appears in the request, not `scene_notes` |
| Clear the custom template while on *Custom…* | Warning shown; the default is sent, not an empty prompt |
| Delete `{{suffix}}` from a custom template | Warning shown; the default is sent — the continuation is never dropped |
| A `</your_tag>` inside the selected text | Defanged in the request; the real container still closes once |
| Swipe a continuation made under a custom template | The swipe re-leases the **same** custom instruction |
| Edit a template while a generation is in flight | The running generation is unaffected; the next one picks the edit up |
| **Reset prompt to default** | Every prompt field clears; the preset returns to *Scene notes* |
| `/intercede diagnostics` after customising | Reports the preset and `customized: true`, and quotes no prompt text |

## Generation lifecycle

Read these off `/intercede diagnostics`. The event log is recorded either way; this only
makes the report carry it ([LEASE-14](RATIONALE.md#LEASE-14)):

```js
Intercede.setDebugLifecycle(true)
```

It records event names, argument *shapes*, resolved kinds and open counts — never prompt
or chat text. `Intercede.resetDiagnostics()` clears counters and the log between cases and
touches no safety state.

| Test | Required result |
| --- | --- |
| `/intercede diagnostics` three times while idle | `0 open` **every** time; the count must not climb |
| One ordinary intercession | `kindMismatchedEnds` stays `0`; `opaqueEnds` rises with `ends` |
| Ordinary intercession right after several slash commands | Commits normally — no "another generation overlapped" refusal |
| Stop button pressed mid-generation | `0 open` at rest, or a reconciliation that clears it; stop recorded |
| Quiet generation overlapping an intercession | Rolls back; records may leak upward but must self-clear, never lock the extension out |
| Ten intercessions in one session | `starts`/`ends` need not match; `0 open` at rest is what matters |

## Failure reporting

The failure path is exercised least and read most carefully, so walk it deliberately —
disconnect the backend, or stop a generation before any message arrives.

| Test | Required result |
| --- | --- |
| An intercession that fails and rolls back | **One** red toast, saying it was rolled back; the original message is whole; no mention of `/intercede recover` |
| An intercession that stops for review | **One** red toast, saying nothing further was changed, offering `/intercede recover`; no toast claiming a rollback |
| Either failure | The typed response is still there when Intercede is reopened |
| Console after either | One line with a short transaction id; a capture failure also logs counts per reason ([CAP-07](RATIONALE.md#CAP-07)) |
| `/intercede recover` after the stop case | Restores the original message exactly |

A continuation that commits **with** an amber warning is a pass, not a failure: quality
warnings are advisory ([VAL-05](RATIONALE.md#VAL-05)). Note the wording of any that fire
on ordinary in-character prose — that is the false-positive report worth having.

Expected on a healthy 1.18.0 session:

- `defaultedStarts` dominates — the host names no type for an ordinary send;
- `opaqueStarts` is **`0`**. Non-zero means the host contract moved
  ([LEASE-13](RATIONALE.md#LEASE-13));
- `opaqueEnds` ≈ `ends`;
- `kindMismatchedEnds` is **`0`**. Non-zero means the host started naming kinds — worth
  reporting, not necessarily a fault;
- `unconfirmedOpen` returns to `0` at rest. A persistent non-zero value is an abandoned
  start that reconciliation never settled.

## After every cancellation, failure and successful commit

```text
/intercede diagnostics
```

The toast is one line and reports only what is worth a second look.

Two healthy shapes exist, and only one of them says `clean`:

- **From the console** (`Intercede.diagnostics()`) — nothing ran, so nothing needed
  settling: `… — 0 open — clean`.
- **From the composer** (`/intercede diagnostics`) — the command *is* a generation as far
  as SillyTavern is concerned, so it settles its own abandoned start and says so:
  `… — 0 open — 1 reconciled now`. That is the expected reading, not a fault
  ([LEASE-15](RATIONALE.md#LEASE-15)).

What matters in both is `0 open`. Healthy output shows:

- no active transaction;
- no armed generation lease;
- no lingering extension prompt;
- `0 open`;
- no unexplained message ownership;
- no unexpected recovery journal;
- no kind-mismatched or unmatched ends.

## Why non-streaming cancellation deserves extra attention

*(Not walked for v0.6.0 — an accepted gap. Streaming cancellation passed. This is the first
row to walk if a cancellation problem is ever reported.)*

SillyTavern 1.18.0 exposes no universal `isGenerating` boolean, so
`probeHostGeneration()` falls back to `body.dataset.generating` and then to `#mes_stop`
visibility. Cancellation on a non-streaming backend is therefore the path where the host
probe is weakest and the jsdom suite least representative. Exercise it on each backend
rather than once.

If `lease.host.stable` is ever `false` in a report, the probe disagreed with itself
between two reads. Nothing is reconciled in that state by design
([LEASE-10](RATIONALE.md#LEASE-10)) — capture the report, it is worth investigating.
