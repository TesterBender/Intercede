# Intercede documentation

## Which version is which

```text
Latest release:   v0.7.0  —  tagged and published, commit cac7154
Requires:         SillyTavern 1.18.0+
```

Installing from the repository URL gives you `main`. When `main` is ahead of the latest tag it
is a development build, so `/intercede diagnostics` may report a version that is a commit
rather than a release — include the commit in a report if you can.

---

Everything longer than the [main README](../README.md) lives here. The README is still the
place to start: it explains what Intercede does, how to install it, and what it guarantees.
These pages are what you need *after* that — when something misbehaves, when you want to know
whether your setup has ever been tried, or when you want to know why the code is shaped the
way it is.

## Using it

| Page | For |
| --- | --- |
| [Main README](../README.md) | Installation, usage, the safety model, what is stored and where |
| [Tuning the instruction](../README.md#tuning-the-instruction) | Prompt presets, custom templates, placeholders |
| [Troubleshooting](TROUBLESHOOTING.md) | What a message means and what to do about it |
| [Known issues](KNOWN-ISSUES.md) | Confirmed, suspected, and resolved problems |
| [Limitations](../README.md#limitations-v07) | What the current version deliberately does not do |

## Reporting and compatibility

| Page | For |
| --- | --- |
| [Testing status](TESTING-STATUS.md) | What is actually verified, and by whom |
| [Compatibility reports](COMPATIBILITY.md) | Backends, models and hosts people have run this on |
| [How to report a problem](REPORTING-PROBLEMS.md) | What to include, and what to redact first |

## Under the hood

| Page | For |
| --- | --- |
| [Design rationale](RATIONALE.md) | Why every non-obvious line exists. Stable rule IDs the source points at |
| [Release QA matrix](RELEASE-QA.md) | The live checks a release is supposed to walk |
| [Release test results](RELEASE-TESTS.md) | What was actually run, and what was skipped on purpose |
| [Roadmap](ROADMAP.md) | Deferred work, with no delivery promises attached |

## Releases

| Version | State | Notes |
| --- | --- | --- |
| v0.7.0 | **Current** — tagged at `cac7154` | [Release notes](RELEASE-NOTES-v0.7.0.md) — user-configurable rewrite prompts |
| v0.6.0 | Superseded | [Release notes](RELEASE-NOTES-v0.6.0.md) |

## How to read these pages

Intercede is maintained on a best-effort basis by one person, and the documents here try to
be honest about the difference between three things that are easy to blur together:

- **what the code does** — established by the source and the automated suite;
- **what has been observed** — a real backend, in a real browser, once;
- **what is assumed** — read from SillyTavern's source, or inferred, and never run.

[RATIONALE.md](RATIONALE.md) marks the third category explicitly in its *Open questions*
section, and [TESTING-STATUS.md](TESTING-STATUS.md) defines the vocabulary the compatibility
and known-issue pages use. A feature being implemented is not a claim that it has been tried
in your environment.
