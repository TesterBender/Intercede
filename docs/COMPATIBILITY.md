[← Documentation](README.md) · [Testing status](TESTING-STATUS.md) · [Known issues](KNOWN-ISSUES.md) · [Report a problem](REPORTING-PROBLEMS.md)

# Compatibility reports

Which environments Intercede has been run in, by anyone. Entries are **observations, not
guarantees**, and everything not marked *Maintainer verified* is a user report that has not
been reproduced.

Read [TESTING-STATUS.md](TESTING-STATUS.md) first for what the status words mean. The short
version: most combinations are **untested**, and untested is the honest default rather than a
warning.

## Areas seeking community reports

These are the gaps v0.7.0 shipped with, disclosed rather than closed. A single report against
any of them would change what this project knows about itself:

- **non-streaming cancellation** — the highest-value row, for the reason below;
- **text-completion backends**;
- **local-LLM backends and smaller models** — including the `terse` preset, which shipped as a
  starting point rather than a validated configuration;
- **mobile workflows**;
- **keyboard-only operation**;
- **long repeated-use sessions**;
- **third-party extension combinations**.

None of these is a known failure. They are places nobody has looked.

## Backends

| Intercede | SillyTavern | Backend | Model / provider | Streaming | Status | Source |
| --- | --- | --- | --- | --- | --- | --- |
| v0.7.0 | 1.18.0+ | Chat completion | Claude | not recorded | **Maintainer verified** — prompt configuration, custom templates, swiping after a config change | [RELEASE-TESTS.md](RELEASE-TESTS.md#v070--released) |
| v0.6.0 | 1.18.0+ | Chat completion | Claude | on | **Maintainer verified** — commit, compare, undo, streaming cancellation, overlap rollback | [RELEASE-TESTS.md](RELEASE-TESTS.md#v060--release-candidate) |
| — | — | Text completion | — | — | Untested | — |
| — | — | Local model (koboldcpp, llama.cpp, Ollama, …) | — | — | Untested | — |

Non-streaming has never been walked end to end, including cancellation. That row matters more
than it looks: the host probe that answers "is a generation running?" fell back to its weakest
source throughout the one live session, and streaming is where that source has the most help
([HOST-06](RATIONALE.md#HOST-06)).

## Browsers and platforms

| Platform | Status | Source |
| --- | --- | --- |
| Chromium-based, Windows desktop | **Maintainer verified** | [RELEASE-TESTS.md](RELEASE-TESTS.md) |
| Firefox, desktop | Untested | — |
| Safari, desktop | Untested | — |
| Mobile browsers, any | Untested | — |

Mobile is untested including layout. Intercede renders a reading overlay and per-message
buttons; neither has been looked at on a small screen.

## Other extensions

Intercede's failure mode when another extension changes the chat mid-generation is to roll
back rather than guess, so a conflict usually shows up as *"the intercession failed and was
rolled back"* rather than as damage. That is by design, but it still makes the extension
unusable alongside whatever caused it, which is worth reporting.

| Extension | Status | Source |
| --- | --- | --- |
| Regex scripts set to *Alter Chat Display* | **Automated** — boundaries are classified against an offscreen render and never offered inside hidden text ([VIS](RATIONALE.md#VIS-01)) | Test suite |
| Anything else | Untested | — |

## Adding a row

Open a **Compatibility report** issue — it works for successes as well as failures, and a
success is the more useful of the two here. Include the version pair, the backend, whether
streaming was on, and which operations you actually tried (commit, undo, compare, swipe,
chaining, cancel, recover).

Rows link to their issue rather than quoting it, so the evidence, the discussion, and any
later correction stay attached to the report instead of being frozen into a table cell.

Nothing is added to this file without the reporter saying it is fine to list it.
