# Getting help with Intercede

Intercede is maintained on a best-effort basis by one person with one setup. That shapes what
is realistic to expect: **anything touching canonical chat history is taken seriously and
quickly; everything else depends on the week.**

## Start here

| You have | Go to |
| --- | --- |
| A message from Intercede you do not understand | [Troubleshooting](../docs/TROUBLESHOOTING.md) |
| Messages missing or an original you cannot restore | **[Recovery failure issue](https://github.com/TesterBender/Intercede/issues/new?template=recovery-failure.yml)** — first, and do not close the chat |
| A reproducible failure | [Bug report](https://github.com/TesterBender/Intercede/issues/new?template=bug-report.yml) |
| A backend or browser result, working or broken | [Compatibility report](https://github.com/TesterBender/Intercede/issues/new?template=compatibility-report.yml) |
| An idea | [Roadmap](../docs/ROADMAP.md), then [feature request](https://github.com/TesterBender/Intercede/issues/new?template=feature-request.yml) |
| A question, or "is this even a bug?" | Discussions if it is enabled; otherwise a bug report is fine |

[How to report a problem](../docs/REPORTING-PROBLEMS.md) covers what to include and — this
part matters — what to redact first.

## What gets attention, in what order

1. **Anything where chat history was damaged or could not be restored.** This is the whole
   reason the extension is built the way it is.
2. **Reproducible failures with diagnostics attached.**
3. **Compatibility reports, successes included.** Most of the matrix is untested, so a
   "worked fine on X" report changes what the project knows about itself
   ([testing status](../docs/TESTING-STATUS.md)).
4. Everything else.

## What to expect

- **No SLA, and no promise a given thing gets fixed.** [ROADMAP.md](../docs/ROADMAP.md) says
  what is deferred and why; entries there are explicitly not commitments.
- **"Works as designed" is a common answer**, and the docs try to say so in advance. Intercede
  stops rather than guessing, so a good deal of what looks like failure is the safety model
  doing its job — [troubleshooting](../docs/TROUBLESHOOTING.md) distinguishes the two.
- **A feature that would require guessing on your behalf is likely to be declined** on
  structural grounds rather than effort.

## What this project will not ask you for

Your API keys, your chat contents, or anything that identifies you. `/intercede diagnostics`
is deliberately metadata-only — no prompt text, no chat text — so that it can be pasted into a
public issue. The one field worth a second look before posting is `chat.id`, which is usually
a filename derived from the character name.

If a report seems to need more than that, say so in the issue rather than posting it.
