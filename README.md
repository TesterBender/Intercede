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

Requires **SillyTavern 1.18.0+**. Works with streaming disabled or enabled; no server plugin,
no external services, nothing leaves your browser.

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
| `/intercede cleanup` | Delete undo snapshots older than the configured age |

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
- **Validation** — after generation the chat tail is structurally verified (roles, prefix
  integrity, non-empty continuation). Structural corruption rolls back; stylistic issues
  (prefix repetition, ignored insertion, meta-commentary) only warn.
- **Recovery journal** — a synchronous localStorage journal is written around every risky
  step. After a reload or crash, Intercede offers to restore the original message; it never
  deletes a message it cannot prove belongs to the interrupted transaction.
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
`intercede_undone`, `intercede_invalidated`) are emitted through the SillyTavern
`eventSource` so memory/summary/timeline extensions can invalidate derived state. A small
console API is exposed at `window.Intercede`.

## Limitations (v0.5)

- Latest completed assistant message only; one intercession runs at a time (chains are
  sequential — you intercede the finished continuation, not a generation in flight).
- Group chats are not yet supported (planned for a later version with speaker forcing).
- Undo is available only while the intercession is still the chat tail, so a chain unwinds
  newest-first; an earlier link cannot be undone without undoing the ones above it.
- Undo snapshots are stored in this browser's storage and do not travel with exported chats
  (deliberate: no invisible chat-file inflation).
- No cutting inside code fences, inline code, links, HTML tags, macros, or unfinished quotes
  (deliberate: those boundaries are unsafe).

## Module map

```
index.js                     bootstrap, slash commands, recovery wiring, public API
src/constants.js             shared constants, defaults, event names
src/stcontext.js             SillyTavern.getContext() access + capability check
src/segmentation.js          protected Markdown regions, paragraph/sentence boundaries
src/anchors.js               source-anchored cuts (hashes + context, rebase-or-abort)
src/vault.js                 discarded-suffix vault (localforage) + recovery journal
src/prompt.js                the one-generation suffix-revision instruction
src/lease.js                 generation lease + swipe/regenerate re-leasing
src/validator.js             structural validation + quality heuristics + overlap metrics
src/transaction.js           the atomic transaction: snapshot → mutate → generate →
                             validate → commit / rollback; undo; journal recovery
src/events.js                custom Intercede events
src/ui/open.js               interface dispatcher (in-place vs floating window, toggle)
src/ui/inline-mode.js        in-place selection: markers rendered over the live message
src/ui/overlay.js            floating window: reading overlay, boundary chips, composer
src/ui/visibility.js         boundary visibility vs display-only transforms (§9.5)
src/ui/commit-flow.js        shared drafts, warnings, confirmation, commit pipeline
src/ui/message-button.js     per-message actions, eligibility, Alt+I
src/ui/modal.js              self-contained confirm/modal dialogs
src/ui/compare.js            original vs. revised comparison view
src/ui/settings.js           settings drawer
```
