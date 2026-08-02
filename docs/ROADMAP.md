[← Documentation](README.md) · [Known issues](KNOWN-ISSUES.md) · [Testing status](TESTING-STATUS.md) · [Compatibility](COMPATIBILITY.md)

# Roadmap

Work that has been deliberately deferred, with the reason. **Nothing here is a commitment or
a schedule.** Intercede is maintained on a best-effort basis by one person; this page exists
so that "not implemented" can be told apart from "not thought about", and so a feature request
can be pointed at an existing entry instead of re-litigated.

## Before more features: close the coverage gaps

v0.7.0 is released. It validated what it changed — custom templates reaching the backend,
literal `{{mode}}` surviving, mode wording placement, swiping after a configuration change —
on a Claude chat-completion setup.

What it did **not** validate is the environment the feature was built for. Prompt
configurability exists because the fixed v0.6.0 wording was tuned against one hosted
chat-completion setup and may not suit a text-completion endpoint or a small local model.
Neither has been tried, and the `terse` preset — written specifically for small local models —
shipped as a starting point rather than a validated configuration.

**Adding another large feature before that gap closes would be the expensive mistake here.**
These are reports wanted, not release blockers; the standing list lives in
[COMPATIBILITY.md](COMPATIBILITY.md#areas-seeking-community-reports), and the highest-value
three are:

1. **Non-streaming cancellation**, on each backend. The host probe falls back to its weakest
   source in practice, and this is the path where that matters most.
2. **A text-completion backend.**
3. **A small local model**, including `terse` — does it react to the inserted response, keep
   useful material from the set-aside continuation, avoid narrating the instruction back,
   avoid repeating the prefix, and honour all three rewrite strengths? If it does not, the
   preset should be reworded or withdrawn rather than left labelled for an audience it does
   not serve.

[RELEASE-QA.md](RELEASE-QA.md) has the walkable form of all of this, including the adversarial
template payload.

## The things that make later work cheaper

Infrastructure rather than features. Each one reduces how much of the matrix has to be walked
by hand.

### A real-browser integration harness

The suite drives jsdom and a fake `SillyTavern.getContext()`. It proves a great deal of
transaction logic and none of the host: real rendering, real lifecycle timing, real
IndexedDB and localStorage, streaming, cancellation, reload-and-recover.

A Playwright suite against a pinned SillyTavern checkout and a deterministic fake generation
endpoint would automate most of the manual safety matrix without a single paid model call.
This is the highest-leverage item on the page.

### Version-contract monitoring

The message event and the generation lifecycle are explicitly version-coupled assumptions
([CAP-02](RATIONALE.md#CAP-02), [LEASE-12](RATIONALE.md#LEASE-12)). Today they are assumptions
recorded in a document; they could be assumptions the extension checks.

Record the host version, the observed event payload shapes, the available context methods and
which source the generation probe answered from — then warn when the host is newer than
anything verified, when an expected event stops arriving, when a payload shape changes, or
when the probe has fallen back to its weakest source. **Warn, not disable**, unless a safety
invariant genuinely cannot be upheld.

That last case is live today: every field report so far reads `#mes_stop (weak)`
([known issue](KNOWN-ISSUES.md#needs-more-information)).

### Storage visibility

The snapshot vault is invisible. A user cannot see how many snapshots exist, how much space
they use, which are still undoable, which are abandoned recovery snapshots, or which chats own
them — and `/intercede cleanup` asks them to trust a number they cannot inspect.

Surface it, then offer the operations against it: clean unused, finalize selected, export
recovery data, verify integrity.

### Template-authoring ergonomics

The preview and the fallback behaviour are a solid base. What would build on them: a token
estimate, a size warning, visible wrapper-tag detection, a *copy assembled prompt* button,
highlighting for `{{suffix}}` and `{{mode}}`, a duplicate-marker warning, previewing under
the active rewrite strength, a validate-without-generating button, and an explicit
**experimental** label for any preset that has not been validated.

### An unambiguous version policy

The version is bumped when work lands rather than when it ships, so between a merge and a tag
`main` reports a release number that does not exist yet. That window caused real confusion
during the 0.7.0 cycle — a checkout describing itself as a released version it was not. Three
ways out, and this is a maintainer decision rather than a design one:

- development builds carry `0.7.0-dev` or `0.7.0-rc.1`, and become `0.7.0` immediately before
  tagging; or
- the version is bumped only at tag time; or
- diagnostics and the settings panel report a `release_status` field alongside the version.

Any of them stops a development checkout from presenting itself as a release.

## Prompt and configuration

Deferred from 0.7.0 on purpose. Prompt customisation is global today: one instruction for
every chat and character.

- **Per-character profiles.** The wording that suits a terse noir narrator is not the wording
  that suits a verbose fantasy one. A settings-scoping problem rather than a prompt problem,
  which is why the global version shipped first.
- **Per-chat overrides**, for one campaign, genre or backend without changing global
  behaviour.
- **Per-backend profiles** — *Scene notes* for a hosted provider, *Terse* for a local model,
  selected automatically.
- **Preset import and export.** A small versioned JSON shape: name, template, mode wording,
  description. Straightforward; simply not done.
- **Preset inheritance**, so a custom preset can override one mode's wording and inherit the
  rest.
- **Preset test fixtures** — saved prefix/insertion/suffix examples an author can assemble
  against while editing.
- **Safe SillyTavern macro expansion.** `{{char}}` and `{{user}}` are not expanded today;
  `substituteParams` is available on the host context and never called. Deferred because it
  is a separately testable behaviour change with its own failure mode: a macro expanding
  inside the set-aside continuation is exactly the class of bug
  [PROMPT-03](RATIONALE.md#PROMPT-03) exists to prevent, and the data-versus-source boundary
  would have to be re-established for a second syntax. If it happens, Intercede's own
  placeholders should move into a namespace that cannot collide.

## Core product

Larger, and each one has to touch the safety machinery.

- **Edit an existing intercession.** Change the inserted response, archive the current revised
  continuation, regenerate from the same set-aside suffix.
- **Move the cut point.** Restore from the snapshot, choose a different boundary, create a
  replacement transaction.
- **A transaction-history panel** — the chain, its rewrite strengths, when each link was made,
  which snapshots still exist.
- **Branch-based historical intercession.** Only the latest completed assistant message can be
  interceded. Rewriting further back is a different operation: everything after the cut is
  already canonical and would have to be regenerated or branched. Branching is the likely
  shape, because it does not require Intercede to decide what to do with messages it never
  created.
- **Group chat support.** The blocker is speaker forcing: an intercession inserts a user turn
  and regenerates an assistant turn, and in a group chat "which assistant" is a question the
  transaction cannot currently answer *or prove afterwards*. Ownership is proven by the event
  that announced a message; that proof would have to carry the speaker too.
- **Selective chain restoration.** Undo works while an intercession is the chat tail, so a
  chain unwinds newest-first. Undoing from the middle means deciding what happens to
  everything built on top of it, and every answer so far amounts to guessing on the user's
  behalf — the one thing the safety model refuses to do. Branching from an earlier link is
  the way through.
- **Portable undo packages.** Export a chat with an optional recovery sidecar, rather than
  inflating the ordinary chat file.

## Interoperability

The custom events (`intercede_before_commit`, `intercede_committed`, `intercede_rolled_back`,
`intercede_undone`, `intercede_invalidated`) are the start of this. What could build on them:

- **A memory-extension adapter**, giving memory systems a standard way to invalidate and
  rebuild derived state from `fromIndex`.
- **A timeline adapter**, so a historical intercession could request branch creation through
  Timelines when it is installed.
- **A continuation-tree adapter**, converting only the active path while archiving the whole
  original object.
- **A prompt-modifier cooperation contract** — publish the active transaction and lease id so
  a cooperating extension can avoid generating into Intercede's window. That window is the
  cause of the most common interference failure today.
- **A TTS suppression contract**, distinguishing a prefix re-render from a genuinely new
  assistant message.

## Rewrite quality

Speculative, and none of it is safety-critical.

- **Suggested response points** — rank likely places to interrupt: direct questions, pauses,
  offers, accusations, topic changes.
- **A semantic preservation report.** The current indicator is trigram overlap, which measures
  textual reuse and not fidelity ([VAL-04](RATIONALE.md#VAL-04)). A list of which lines,
  actions, revelations and beats survived would say something the number cannot.
- **Genre-oriented rewrite presets** — dialogue-heavy, action-heavy, introspective, comedic,
  concise.
- **Prefix-duplication repair preview.** Detect exact repetition and offer one-click removal
  *before* committing, without silently editing ambiguous prose.
- **Compare several swipes against the same set-aside suffix**, to see which alternative kept
  what.
- **An optional planning pass** — a cheap model call classifying beats as retain / adapt /
  reorder / discard before the visible generation. Optional permanently: it adds cost and
  failure surface.

## Interface and accessibility

- Searchable settings help; a first-run guided demo.
- Larger, touch-friendly boundary markers.
- An undo-history indicator, and a storage-health warning.
- A *copy diagnostics* button, and a downloadable redacted diagnostic bundle.
- An accessibility audit: screen-reader labels, focus traps in modals, reduced-motion support.
- Localisation-ready strings.

## Not planned

- **Anything that turns a rollback into a repair.** When another extension disturbs an
  intercession, Intercede rolls back rather than reconciling. The alternative is guessing
  which messages are whose.
- **Telemetry, analytics, or any Intercede-operated service.** There is none and there will be
  none. Generation goes through the backend already configured in SillyTavern.
- **Snapshots inside the chat file.** They live in browser storage on purpose; putting them in
  the chat file would inflate every export invisibly.

## What actually helps most

Filling in [COMPATIBILITY.md](COMPATIBILITY.md) is worth more than any feature on this page.
Non-streaming cancellation, one text-completion backend, and one local model are the three
rows where a single report would change what this project knows about itself.
