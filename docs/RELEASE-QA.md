# Release QA — live host matrix

The automated suite runs against a jsdom fake. It proves the logic; it cannot prove the
host. This matrix is the gate that must be walked in a real SillyTavern **1.18.0**
installation before tagging a release.

Run it against at least one chat-completion backend and one text-completion backend. Note
which backend each row was exercised on — several rows behave differently per backend.

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

These rows exist because the host's lifecycle events are not what their names suggest —
see [LEASE-12](RATIONALE.md#LEASE-12). Read them off `/intercede diagnostics`.

| Test | Required result |
| --- | --- |
| One ordinary intercession | `kind mismatches` stays `0`; `opaqueEnds` (console report) rises with `ends` |
| Stop button pressed mid-generation | `0 open` afterwards, or a reconciliation that clears it; stop recorded |
| Quiet generation overlapping an intercession | Records may leak upward; must self-clear via host idle, never lock the extension out |
| Ten intercessions in one session | `starts`/`ends` need not match; `0 open` at rest is what matters |

`kind mismatches` above zero on 1.18.0 means the host started naming generation kinds —
worth reporting, not necessarily a fault.

## After every cancellation, failure and successful commit

```text
/intercede diagnostics
```

Healthy output shows:

- no active transaction;
- no armed generation lease;
- no lingering extension prompt;
- no unreconciled open generation;
- no unexplained message ownership;
- no unexpected recovery journal;
- no kind-mismatched ends.

## Why non-streaming cancellation deserves extra attention

SillyTavern 1.18.0 exposes no universal `isGenerating` boolean, so
`probeHostGeneration()` falls back to the streaming processor or to `#mes_stop`
visibility. Cancellation on a non-streaming backend is therefore the path where the
host probe is weakest and the jsdom suite least representative. Exercise it on each
backend rather than once.
