# Intercede v0.7.0 — draft release notes

**Not published, and nothing is tagged.** Everything below is prepared text.

```text
Tag:      v0.7.0          (annotated, on the merge commit — not on the branch)
Title:    Intercede v0.7.0 — your prompt, your backend
Body:     everything below the rule, from "The rewrite instruction…" onward
Assets:   none — SillyTavern installs from the repository URL
```

Publish only once, in this order:

1. the branch is merged into `main`;
2. GitHub Actions is **green on the exact commit being tagged** — the merge commit;
3. the live QA rows in [RELEASE-QA.md](RELEASE-QA.md) are walked, or the gaps are accepted
   and written into [RELEASE-TESTS.md](RELEASE-TESTS.md);
4. the maintainer authorizes the tag.

**One item needs a decision before tagging.** The `terse` preset is new wording that has not
been through the tuning the other two have — see *Before you tag* at the end.

---

The rewrite instruction decides more about how a regeneration turns out than anything else in
Intercede, and until now it was a constant, tuned against one setup. This release hands it
over.

Requires **SillyTavern 1.18.0+**. No server plugin, no telemetry, and no Intercede-operated
service; generation goes through the backend you have already configured in SillyTavern.

## Highlights

- **Choose the instruction.** **Extensions → Intercede → Prompt** offers *Scene notes* (the
  shipped default), *Direct* (same framing, fewer tokens), *Terse* (for small local models
  that narrate a long preamble back at you), and *Custom…* for your own template.
- **Edit the per-strength wording.** The three lines behind *Preserve closely*, *Adapt
  naturally*, and *Reimagine remainder* are editable under any preset.
- **See what you are sending.** A collapsible preview renders the assembled instruction with
  a sample continuation filled in, and updates as you type. A template that has lost its
  `{{suffix}}` marker says so there, and the default is used instead.
- **Nothing to undo by hand.** An empty box uses the built-in text shown greyed inside it, so
  clearing a box *is* the undo; **Reset prompt to default** clears them all.
- **Diagnostics answer the first question.** `/intercede diagnostics` now reports which preset
  is in use and whether it was customised — never the prompt text, which would travel into
  whatever public issue the report is pasted into.

## Upgrading changes nothing

If you never open the Prompt section, this release sends the **byte-identical** instruction
v0.6.0 sent. The default wording was moved into a preset table verbatim rather than rewritten,
and `tests/prompt-config.test.js` compares the assembled output against a transcription of the
v0.6.0 string for every rewrite strength.

New settings fill themselves in on first load and existing choices are never rewritten, as
with every previous release. There is no migration step.

## Notes for template authors

- `{{suffix}}` is **required** — it marks where the set-aside continuation goes. A template
  without it is not used at all.
- `{{mode}}` is optional and marks where the per-strength wording goes. Leave it out and the
  wording is appended at the end, which is what the built-in templates do.
- Keep edits phrased as scene or story direction. Wording that reads as an instruction to
  reuse a model's earlier output is rejected outright by some backends' filters — that is why
  the default talks about "notes" rather than about continuations.
- Rename the container tag if you like; Intercede reads it out of your template, keeps the
  set-aside text from closing it early, and teaches the leak heuristic the new name.

## Also in this release

- The quality heuristic that notices a continuation talking *about* the rewrite now also
  watches your template's container tag. Its built-in list is the default prompt's vocabulary,
  which a custom template need never use. Advisory as always — it warns, it never rolls back.
- Suffix interpolation no longer goes through `String.replace`, so a continuation containing
  `$&` or `$'` is inserted literally rather than being expanded as a replacement pattern.

## Not exercised for this release, and released knowing it

Carried forward from v0.6.0, unchanged and still true: non-streaming cancellation;
text-completion and local-LLM backends; mobile and keyboard-only use; extended repeated use;
a broad third-party extension matrix.

Added by this release:

- **The `terse` preset has not been run against a small local model** — the audience it is
  written for. It is a starting point, not a validated configuration.
- **No custom template has been run on a live backend.** The resolution, fallback, and
  sanitising paths are covered by the automated suite against a simulated host; what a real
  provider's filter makes of a user-authored instruction is between the user and that
  provider, and Intercede's only defence is the note in the drawer.

Not implemented, deliberately: per-character or per-chat prompt overrides, SillyTavern macro
expansion (`{{char}}`, `{{user}}`) inside templates, and preset import/export. Prompt
customisation is global.

## Before you tag

The `terse` preset's wording is the one part of this release that is prompt authorship rather
than plumbing, and it has not been through the process that produced the other two — the
default's phrasing was rewritten once already after a backend filter rejected it
([PROMPT-01](RATIONALE.md#PROMPT-01)).

Either sign off on the text in `src/prompt-presets.js` after reading it, or cut the preset and
ship two built-ins plus *Custom…*. Removing it is a three-line change: drop `TERSE` from
`PROMPT_PRESETS`, drop its entry from `BUILT_IN_PRESETS`, and update the expected option list
in `tests/settings-panel.test.js`. Nothing else depends on it.
