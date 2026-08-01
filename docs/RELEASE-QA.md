# Release QA — live host matrix

The automated suite runs against a jsdom fake. It proves the logic; it cannot prove the
host. This matrix is the gate that must be walked in a real SillyTavern **1.18.0**
installation before tagging a release.

Run it against at least one chat-completion backend and one text-completion backend. Note
which backend each row was exercised on — several rows behave differently per backend.

Record outcomes in [RELEASE-TESTS.md](RELEASE-TESTS.md).

## Before you start: confirm which build is loaded

`manifest.json` sets `auto_update: false`, and a version string is reported just as
confidently by a stale checkout as by a current one. Run `/intercede diagnostics` and check
the console report:

- `version` is `0.6.0`;
- `lease.events` contains **`opaqueEnds`**, `namedStarts`, `defaultedStarts`,
  `opaqueStarts`, `confirmedStarts` and `reconciledUnconfirmed`;
- `lease.reconcileReason` is present.

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

## Generation lifecycle

Read these off `/intercede diagnostics`. Enable the event log first:

```js
Intercede.setDebugLifecycle(true)
```

It records event names, argument *shapes*, resolved kinds and open counts — never prompt
or chat text ([LEASE-14](RATIONALE.md#LEASE-14)). `Intercede.resetDiagnostics()` clears
counters and the log between cases and touches no safety state.

| Test | Required result |
| --- | --- |
| `/intercede diagnostics` three times while idle | `0 open` **every** time; the count must not climb |
| One ordinary intercession | `kindMismatchedEnds` stays `0`; `opaqueEnds` rises with `ends` |
| Ordinary intercession right after several slash commands | Commits normally — no "another generation overlapped" refusal |
| Stop button pressed mid-generation | `0 open` at rest, or a reconciliation that clears it; stop recorded |
| Quiet generation overlapping an intercession | Rolls back; records may leak upward but must self-clear, never lock the extension out |
| Ten intercessions in one session | `starts`/`ends` need not match; `0 open` at rest is what matters |

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

The toast is one line and reports only what is abnormal. Healthy output ends in `clean`
and shows:

- no active transaction;
- no armed generation lease;
- no lingering extension prompt;
- `0 open`;
- no unexplained message ownership;
- no unexpected recovery journal;
- no kind-mismatched or unmatched ends.

## Why non-streaming cancellation deserves extra attention

SillyTavern 1.18.0 exposes no universal `isGenerating` boolean, so
`probeHostGeneration()` falls back to `body.dataset.generating` and then to `#mes_stop`
visibility. Cancellation on a non-streaming backend is therefore the path where the host
probe is weakest and the jsdom suite least representative. Exercise it on each backend
rather than once.

If `lease.host.stable` is ever `false` in a report, the probe disagreed with itself
between two reads. Nothing is reconciled in that state by design
([LEASE-10](RATIONALE.md#LEASE-10)) — capture the report, it is worth investigating.
