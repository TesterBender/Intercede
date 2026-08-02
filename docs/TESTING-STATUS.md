[← Documentation](README.md) · [Compatibility](COMPATIBILITY.md) · [Known issues](KNOWN-ISSUES.md) · [Report a problem](REPORTING-PROBLEMS.md)

# Testing status

Intercede is maintained on a best-effort basis by one person with one setup. The automated
suite is thorough about the things it *can* reach; it runs in jsdom against a fake
`SillyTavern.getContext()` and cannot exercise a real backend, streaming, a phone, or another
installed extension.

**Implemented is not the same as verified.** This page exists so that nothing on the other
pages has to imply otherwise.

## Status vocabulary

The compatibility and known-issue pages use these words and only these words.

| Status | Means |
| --- | --- |
| **Automated** | Covered by the repository test suite, which runs on every push via GitHub Actions |
| **Maintainer verified** | Reproduced by hand, on a real SillyTavern install, and recorded in [RELEASE-TESTS.md](RELEASE-TESTS.md) |
| **Reported working** | One or more users reported success. Not reproduced by the maintainer |
| **Reported failing** | A user reported a failure with enough detail to be actionable. Not necessarily reproduced |
| **Untested** | No reliable result either way. Most combinations are here |
| **Known incompatible** | A confirmed, unresolved conflict |

*Untested* is the default. It is not a warning; it is an admission.

## What the suite covers

`npm run check` runs ESLint and the vitest suite, and GitHub Actions runs it on every push.

At the **v0.7.0** tag (`cac7154`): **304 tests across 18 files**, ESLint clean. The v0.6.0
suite was 257 across 17. Documentation work after the tag added `tests/docs.test.js`, taking
`main` to 308 across 19; no extension source changed with it.

Test counts from a commit message are not a release record. What makes a run count is the
commit it was run on and CI agreeing on that same commit —
[RELEASE-TESTS.md](RELEASE-TESTS.md) is where that is written down.

The suite asserts exact final chat state rather than "no exception thrown", because the
failures worth catching in a history-rewriting extension are the ones that still look like
success. It covers the transaction lifecycle, ownership proof, generation capture, the
one-generation lease, validation, the snapshot vault, the recovery journal and its recovery
paths, segmentation and anchoring, prompt resolution, the settings panel bindings, and the
rationale document's own pointer integrity.

The one version-coupled assumption — the event name and payload used to identify the
generated continuation — lives in `src/generation-capture.js` and is recorded in the tests.

Two of the suites check the documentation rather than the code: `tests/rationale.test.js`
fails if any `@see docs/RATIONALE.md#…` pointer in the source names a rule that does not
exist, and `tests/docs.test.js` fails if any link between these pages resolves to a missing
file, a missing anchor, or an orphaned page. A pointer that no longer resolves is worse than
no pointer, because it reads as a promise that the answer was written down.

## What the suite cannot cover

- Any real backend, provider, or model.
- Streaming, and cancelling mid-stream.
- Any other installed extension.
- Mobile layout, touch input, or keyboard-only operation.
- Extended repeated use, where drift and leaks appear.
- Whatever a hosted provider's content filter makes of a user-authored prompt template.

## What has actually been run live

The v0.6.0 session, recorded in full in [RELEASE-TESTS.md](RELEASE-TESTS.md): SillyTavern
1.18.0+, Claude via chat completion, streaming on, Chromium-based browser on Windows. It
exercised
idle and repeated diagnostics, an ordinary commit, compare, undo, streaming cancellation, and
a deliberately induced nested-generation overlap.

Everything else in the release matrix was recorded as an **accepted gap** — named, disclosed,
and released with open. Accepted gaps are not observed failures. They are places where
nobody has looked.

**v0.7.0 added targeted live validation of the prompt work**, on the same Claude
chat-completion setup: a custom template reaching the outgoing request, a literal `{{mode}}`
in a continuation surviving unchanged, the mode wording appearing separately from the
template's own marker, swiping a continuation after changing the prompt configuration, and
ordinary intercession. That covers the paths the release actually changed.

It is targeted, not broad. The gaps carried forward from v0.6.0 are unchanged, and the
`terse` preset shipped as **a starting point rather than a validated configuration** — it has
not been tuned against a broad selection of the small local models it is written for.

Still open after v0.7.0, and the places a report is worth most:

- non-streaming cancellation;
- text-completion backends;
- local-LLM backends, and small models generally;
- mobile and keyboard-only workflows;
- extended repeated-use sessions;
- third-party extension combinations.

## Where community reports fit

A report is the only way most of the matrix will ever be filled in. What is useful:

- **It worked.** Genuinely valuable, and the rarest kind of report. It turns *untested* into
  *reported working* for a combination the maintainer will never own.
- **It broke, with evidence.** Diagnostics, steps, and what the chat looked like afterwards.
- **It broke, without evidence.** Still worth filing — it goes to *needs more information*
  rather than into a table, and a second matching report is what makes it a pattern.

[How to report a problem](REPORTING-PROBLEMS.md) says what to include.
