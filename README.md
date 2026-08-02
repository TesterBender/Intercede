# Intercede

**Respond inside an already completed message.**

Intercede is a SillyTavern UI extension that lets you answer *in the middle* of a finished
assistant response without rewriting everything that followed. You read the message, pick the
sentence or paragraph where your character would naturally speak, write your reply — and the
remainder is regenerated as a real three-turn exchange:

```
Assistant: (preserved prefix — byte-for-byte what was written before your cut)
User:      (your inserted response — a genuine user-role message)
Assistant: (revised continuation — regenerated with the original remainder as reference)
```

The original continuation is not thrown away. It is handed to the model as clearly
non-canonical scene notes (`<scene_notes>`), so compatible dialogue, beats, and
revelations survive — retimed and rephrased around your response. It is also kept in a local
vault so undo restores the original message *exactly*: text, swipes, and metadata.

The revised continuation is an ordinary assistant message, so it can be interceded in turn:
answer inside it, and the remainder of *that* is regenerated the same way. Intercessions
chain as deep as the scene warrants, and undo unwinds them newest-first.

Requires **SillyTavern 1.18.0+**. Works with streaming disabled or enabled. No server
plugin, no telemetry, and no Intercede-operated service; generation goes through the
backend you have already configured in SillyTavern, exactly as an ordinary message does.

Current release: **v0.7.0**. Installing from the repository URL gives you `main`, which may be
ahead of the latest tag — `/intercede diagnostics` reports the version either way, and a
commit is worth including in a bug report when it is.

## Documentation

The pages below are the manual. This README stays the overview.

| Page | Purpose |
| --- | --- |
| [Documentation home](docs/README.md) | Index of everything below |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | What a message means, and what to do about it |
| [Known issues](docs/KNOWN-ISSUES.md) | Confirmed, suspected, and resolved problems |
| [Testing status](docs/TESTING-STATUS.md) | What is actually verified, and by whom |
| [Compatibility reports](docs/COMPATIBILITY.md) | Backends and hosts people have run this on |
| [Report a problem](docs/REPORTING-PROBLEMS.md) | What to include, and what to redact first |
| [Roadmap](docs/ROADMAP.md) | Deferred work, with no delivery promises attached |
| [Design rationale](docs/RATIONALE.md) | Why every non-obvious line exists |

## Installation

Extensions → *Install extension* → paste this repository's URL, or clone into:

```
SillyTavern/public/scripts/extensions/third-party/Intercede
```

## Usage

1. On the **latest completed assistant message**, click the ↩ **Intercede** button
   (or press **Alt+I**, or type `/intercede`).
2. A reading overlay opens. Click a `⤷ respond here` marker between paragraphs or sentences.
   Everything above the marker stays; everything below (shown dimmed) will be rewritten.
3. Write your response, pick a rewrite strength, and hit **Intercede** (Ctrl+Enter):
   - **Preserve closely** — keep the original wording and sequence wherever possible.
   - **Adapt naturally** *(default)* — keep important beats, allow reordering and new reactions.
   - **Reimagine remainder** — the original is inspiration only.
4. The revised continuation arrives as a normal message: swipe it for other adaptations
   (each swipe re-applies the same editorial instruction), or use the buttons on it:
   - ⟲ **Undo** — restore the original message exactly (available while the intercession is
     still the chat tail).
   - ⇄ **Compare** — original vs. revised continuation, with a textual-overlap indicator.
5. To answer inside the revised continuation as well, just intercede it: it is the latest
   completed assistant message, so ↩ / Alt+I / `/intercede` target it like any other. Each
   link records its parent, so Compare tells you which continuation it is measured against
   and `/intercede undo` peels the chain back one intercession at a time.

### Slash commands

| Command | Effect |
| --- | --- |
| `/intercede` | Open boundary selection on the latest eligible message |
| `/intercede undo` | Undo the committed intercession at the chat tail |
| `/intercede compare` | Show the original/revised comparison |
| `/intercede recover` | Run crash-recovery for an interrupted intercession |
| `/intercede finalize` | Delete the undo snapshot for the intercession at the chat tail (messages stay) |
| `/intercede cleanup` | Delete unused undo snapshots older than the configured age |
| `/intercede diagnostics` | Report generation state, host probe, and event tallies (also `Intercede.diagnostics()`) |
| `/intercede reset` | Clear diagnostic counters and the event log. Touches no lease or transaction state |

### Tuning the instruction

The rewrite instruction is what actually decides how a regeneration turns out, and the
default was tuned against one setup (Claude over chat completion). **Extensions → Intercede →
Prompt** lets you change it:

| Preset | For |
| --- | --- |
| **Scene notes** *(default)* | The shipped wording. Unchanged from v0.6.0 |
| **Direct** | The same framing, fewer tokens |
| **Terse** | Small local models that start narrating a long preamble back at you |
| **Custom…** | Your own template |

A custom template needs `{{suffix}}` — it marks where the set-aside continuation goes.
`{{mode}}` marks where the per-strength wording goes; leave it out and it is added at the
end. The three wording boxes are editable under any preset.

**Every prompt box is optional.** An empty one uses the built-in text shown greyed inside
it, so clearing a box is how you undo an edit, and **Reset prompt to default** clears all of
them at once. A template that is empty or has lost its `{{suffix}}` marker is not used at
all — Intercede falls back to the default and says so above the preview rather than sending
an instruction that would silently drop your continuation.

Expand **Preview the assembled instruction** to see exactly what will be sent, with a sample
continuation filled in. Editing a template blind is the one way this goes wrong.

> One wording constraint worth knowing: keep edits phrased as scene or story direction.
> Text that reads as an instruction to reuse a model's earlier output is rejected by some
> backends' filters — that is why the default talks about "notes" rather than about
> continuations. This mostly bites hosted APIs; local models rarely care. The full account,
> including the phrasing that was actually rejected, is
> **[PROMPT-01](docs/RATIONALE.md#PROMPT-01)** — worth reading before writing a template
> from scratch. `/intercede diagnostics` reports which preset you are on (never the text).

SillyTavern macros (`{{char}}`, `{{user}}`) are **not** expanded inside these templates.

## Safety model

Interceding mutates canonical history, so every operation runs as a transaction:

- **Snapshot first** — the complete original message object goes into a browser-side vault
  (`localforage`) before anything is touched.
- **Source anchors** — cuts are validated by hashes and context windows against the *raw*
  message text (`message.mes`), never the rendered DOM. A stale or ambiguous cut aborts
  instead of guessing; an unambiguous drift is rebased.
- **One-generation lease** — the suffix-revision instruction (worded as in-fiction scene
  notes so backend ToS filters don't mistake it for output-reuse) is installed only from
  inside a matching `GENERATION_STARTED` handler and cleared on every generation end, stop, chat
  change, and in `finally`. It cannot leak into summaries, quiet prompts, or later requests.
- **Proven ownership** — the revised continuation is identified by the message event that
  announces it, not by its position afterwards, and every message the transaction created
  is tagged with the transaction's id. Nothing is rewritten or deleted on position alone.
  If another extension adds a message while Intercede is generating, the intercession fails
  and rolls back instead of adopting that message as its continuation.
- **Observed is not owned** — the event handler only records which assistant messages
  appeared; it writes nothing. A message is marked as Intercede's only after it has been
  checked against the expected shape *and* the reply has been attributed to Intercede's own
  generation call. A marker is never allowed to become its own evidence, so an extension
  that emits the same event first is neither tagged nor deleted.
- **Attributed generation** — the one-generation instruction is tracked to the specific
  `generate()` call that consumed it. If an unrelated generation takes the instruction, or
  more than one matching generation runs while Intercede is waiting, the reply cannot be
  attributed and the intercession stops without claiming it.
- **Uninterrupted instruction** — installing the instruction is not the same as it
  surviving until SillyTavern assembles the prompt. Because clearing it is also how
  Intercede keeps it out of other requests, any generation that overlaps the one it was
  installed for — nested inside the start event, or already running — silently strips it.
  Intercede detects both and rolls its own continuation back rather than committing a reply
  the instruction never reached. Overlap is tracked by counting generations rather than by
  a running/not-running flag, which cannot represent two at once and reads as idle the
  moment either one ends.
- **Eligibility asks SillyTavern, not just its events** — "is a generation running?" is
  answered by the host when it can answer, and only from Intercede's own event
  bookkeeping when it cannot. A lifecycle event that never arrives can therefore no longer
  leave the extension convinced a generation is running forever. `/intercede diagnostics`
  reports which signal answered and what the event tallies look like.
- **Validation** — after generation the three messages are verified against captured
  ownership (identity, markers, roles, prefix integrity, non-empty continuation), and
  verified *again* after `intercede_before_commit` in case a listener changed history.
  Structural corruption rolls back; stylistic issues (prefix repetition, ignored insertion,
  meta-commentary) only warn.
- **Selective rollback** — rollback removes only the messages the transaction can prove it
  created, newest first, and restores the original message from the snapshot. It never
  truncates the chat by length. If ownership cannot be proven, it stops, deletes nothing,
  keeps the journal and snapshot, and asks you what to do.
- **One failure, one message** — a transaction that stops for review says so itself, and
  nothing adds a second notice claiming it was rolled back. The two outcomes are different
  in kind: a rollback has already put your original message back, while a stop leaves the
  chat as it is and hands you `/intercede recover`. That command is only ever offered when
  something is actually left to recover. Either way your typed response is kept.
- **Recovery journal** — a synchronous localStorage journal is written and read back around
  every risky step; if it cannot be verified, the intercession aborts before any message is
  changed. After a reload or crash, Intercede offers to restore the original message; it
  never deletes a message it cannot prove belongs to the interrupted transaction. Choosing
  to keep the chat as it stands clears the interrupted transaction's markers and records it
  as abandoned, keeping its snapshot — declining a restore never quietly discards the only
  copy of the original text. If the snapshot is missing entirely, the journal is kept rather
  than cleared: automatic restoration being impossible does not make the interruption
  imaginary.
- **Undo that is really there** — the Undo and Compare buttons appear only once the
  snapshot behind them has been confirmed present, and automatic snapshot cleanup never
  deletes a snapshot that can still be undone. `/intercede finalize` discards one on
  purpose.
- **Display-hidden text is respected** — regex scripts set to *Alter Chat Display* can hide
  parts of the raw message (e.g. stripping a model's `<response_consideration>` planning
  block at render time). Intercede classifies every candidate cut against an offscreen
  render of the message and never offers a cut inside text the reader cannot see — in
  either interface — since cutting there would split the hidden block across messages.
- **Latest message only** — older history is never silently rewritten. (Branch-based
  historical intercession is future scope.)
- **Chains keep their provenance** — when the cut message is itself a revised continuation,
  the new transaction records its parent and its depth, and the message keeps the earlier
  transaction's marker alongside the new one. Nothing is shared between links: each has its
  own snapshot and its own vault entry, so undoing one restores exactly the message the next
  one was cut from and leaves every earlier link undoable.

Custom events (`intercede_before_commit`, `intercede_committed`, `intercede_rolled_back`,
`intercede_undone`) are emitted through the SillyTavern `eventSource` so
memory/summary/timeline extensions can invalidate derived state. `intercede_invalidated`
fires in addition to each of those outcomes (and after recovery restores a snapshot), so a
listener that only needs to know that history moved can subscribe to that one event. Its
payload carries `fromIndex` as well as `affectedMessageIds`: an intercession inserts and
removes messages, so every index from `fromIndex` onward may have shifted position rather
than merely changed text — invalidate from there, not just the listed ids. A `null`
`fromIndex` means "assume everything". Note that `intercede_before_commit` is
informational: listeners cannot veto a commit, and any history they change is detected by
the re-validation above. A small console API is exposed at `window.Intercede`.

## What it stores, and where

Everything in the table below stays in the browser profile SillyTavern is open in. No
request leaves for any service Intercede owns; there is no telemetry or analytics of any
kind.

What does leave is the generation itself. Interceding sends a request through your
configured SillyTavern backend, carrying the same chat context an ordinary message would
plus the discarded continuation as scene notes. That is the whole point of the feature, and
it is subject to whatever your backend and its provider do with a request — Intercede
neither adds a destination nor removes one.

| Where | What | Lifetime |
| --- | --- | --- |
| `localforage` (IndexedDB) | Undo snapshots: the complete original message, the discarded continuation, and the cut | Until `/intercede finalize`, or `/intercede cleanup` past the configured age (default: keep forever) |
| `localStorage` | The recovery journal — ids, stages, a hash of the target message. No message text | Cleared on commit or rollback; survives a crash on purpose |
| Chat metadata | Compact per-transaction records (ids, indices, state) | Travels with the chat file |
| SillyTavern extension settings | Your preferences | Until changed |
| Memory only | The bounded lifecycle log (last 64 events, no content) | Until reload or `/intercede reset` |

Settings added by a new version fill themselves in with their defaults the first time that
version loads; existing choices are never rewritten, and nothing needs migrating by hand.
Snapshots are the only storage that grows, which is what `/intercede cleanup` and the
snapshot-age setting are for.

## Limitations (v0.7)

- Latest completed assistant message only; one intercession runs at a time (chains are
  sequential — you intercede the finished continuation, not a generation in flight).
- Group chats are not yet supported (planned for a later version with speaker forcing).
- Undo is available only while the intercession is still the chat tail, so a chain unwinds
  newest-first; an earlier link cannot be undone without undoing the ones above it.
- Undo snapshots are stored in this browser's storage and do not travel with exported chats
  (deliberate: no invisible chat-file inflation).
- Dialogue is cuttable. Boundaries are offered before an opening quotation and between
  sentences inside one, because that is where roleplay usually wants to answer. If a cut
  leaves a quotation open or a Markdown delimiter unclosed, the confirmation screen says
  so — the decision is yours rather than the parser's.
- No cutting inside code fences, inline code, HTML tags, macros, paired
  Markdown emphasis (`**bold**`, `_italic_`, `~~strike~~`, including intraword `*em*` and
  escaped delimiters), a run of list items, or links — inline, reference (`[a][b]`,
  `[a][]`) and definition lines. The one link form left unprotected is the shortcut
  `[label]`, which is indistinguishable from ordinary bracketed prose such as `[OOC: …]`. A paragraph boundary requires a blank line, so
  a message written with single newlines between its lines offers paragraph boundaries only
  where a blank line actually appears — switch to "Paragraphs and sentences" for those.
- Switching Intercede off in the settings stops new intercessions everywhere (wand, Alt+I,
  the message button, bare `/intercede`) but deliberately leaves `/intercede undo`,
  `compare`, `recover`, and `finalize` working, so turning it off can never strand a
  committed intercession.
- An intercession that another extension disturbs mid-generation is rolled back rather than
  repaired. That is deliberate: the alternative is guessing which messages are whose.
- Prompt customisation is global: one instruction for every chat and character. Per-character
  overrides, SillyTavern macro expansion inside templates, and importing/exporting presets
  are not implemented.
- The quality heuristic that notices a continuation talking *about* the rewrite is tuned to
  the default vocabulary. It learns your container tag (`<scene_notes>` or whatever you
  rename it to), but a heavily reworded custom template may see fewer of these advisory
  warnings. They never block or alter a commit either way.

## Development

There is no build step — SillyTavern loads `index.js` directly, and the tooling below is
for contributors only.

```
npm install
npm run check     # eslint + vitest
```

Tests run in jsdom against a fake `SillyTavern.getContext()` (`tests/helpers/fake-context.js`)
and assert exact final chat state, since the failures worth catching here are the ones that
still "succeed". The event name and payload used to capture the generated continuation are
the only version-coupled assumption; they live in `src/generation-capture.js` and are
recorded in the tests.

A green suite is necessary but not sufficient — it cannot exercise a real backend,
streaming, or another installed extension. Releases also walk the live matrix in
**[docs/RELEASE-QA.md](docs/RELEASE-QA.md)**, recording results in
[docs/RELEASE-TESTS.md](docs/RELEASE-TESTS.md).

When a lifecycle problem needs evidence rather than counters, read the bounded event log.
It is **always being recorded** — the last 64 lifecycle events, as event names, argument
*shapes*, resolved generation kinds and open counts, never prompt or chat text. A buffer
you have to switch on before the bug happens is empty in the session that needed it, and
because entries are redacted as they are captured there is nothing to gate.

```js
Intercede.lifecycleLog()            // read it now, whatever the settings say
Intercede.setDebugLifecycle(true)   // include it in /intercede diagnostics from now on
Intercede.resetDiagnostics()        // empty it and the counters; touches no safety state
```

## Why the code does what it does

The reasoning behind every non-obvious decision lives in **[docs/RATIONALE.md](docs/RATIONALE.md)**,
not in the source. Rules there have stable IDs, and the code points at them:

```js
// @see docs/RATIONALE.md#LEASE-05
```

That pointer means the line is load-bearing for a stated safety property. Read the rule
before changing it; update the rule if you change the behaviour. Start with the invariant
table at the top of the document, or with `TX-01` for the transaction contract.

## Module map

```
docs/RATIONALE.md            design rationale, invariants, known deferred defects
index.js                     bootstrap, slash commands, recovery wiring, public API
src/constants.js             shared constants, defaults, event names
src/stcontext.js             SillyTavern.getContext() access + capability check
src/segmentation.js          protected Markdown regions, paragraph/sentence boundaries
src/anchors.js               source-anchored cuts (hashes + context, rebase-or-abort)
src/vault.js                 discarded-suffix vault (localforage) + recovery journal
src/prompt.js                assembles the one-generation suffix-revision instruction
src/prompt-presets.js        the built-in instruction texts (default = the v0.6.0 wording)
src/prompt-config.js         resolves preset/custom/overrides from settings
src/lease.js                 generation lease + swipe/regenerate re-leasing
src/ownership.js             per-message ownership markers and chain provenance
src/generation-capture.js    identifies the generated continuation by event, not position
src/errors.js                RecoveryRequiredError and friends
src/validator.js             ownership-proving validation + quality heuristics + overlap
src/transaction.js           the atomic transaction: snapshot → mutate → generate →
                             validate → commit / rollback; undo; journal recovery
src/events.js                custom Intercede events
src/ui/open.js               interface dispatcher (in-place vs floating window, toggle)
src/ui/selection.js          plumbing both selection modes share: target, composer, commit
src/ui/inline-mode.js        in-place selection: markers rendered over the live message
src/ui/overlay.js            floating window: reading overlay, boundary chips, composer
src/ui/visibility.js         boundary visibility vs display-only transforms (§9.5)
src/ui/commit-flow.js        shared drafts, warnings, confirmation, commit pipeline
src/ui/message-button.js     per-message actions, eligibility, Alt+I
src/ui/modal.js              self-contained confirm/modal dialogs
src/ui/compare.js            original vs. revised comparison view
src/ui/settings.js           settings drawer
```

## License

MIT — see [LICENSE](LICENSE).
