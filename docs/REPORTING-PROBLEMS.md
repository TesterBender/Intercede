[← Documentation](README.md) · [Troubleshooting](TROUBLESHOOTING.md) · [Known issues](KNOWN-ISSUES.md) · [Testing status](TESTING-STATUS.md)

# How to report a problem

Before filing: [TROUBLESHOOTING.md](TROUBLESHOOTING.md) covers the messages Intercede
produces on purpose, several of which are the extension working correctly rather than
failing. [KNOWN-ISSUES.md](KNOWN-ISSUES.md) lists what is already on record.

## Which kind of report

| You have | File |
| --- | --- |
| A reproducible failure | **Bug report** |
| Messages missing, duplicated, or unrecoverable after an intercession | **Recovery failure** — this one first, always |
| A backend, browser or extension result, working *or* broken | **Compatibility report** |
| An idea | **Feature request** |
| A question, or something you are not sure is a bug | Discussions, if enabled — otherwise a bug report is fine |

Recovery failures are separate because they are the only category where data may be gone.
They get looked at first.

## Run this first

```
/intercede diagnostics
```

It prints a one-line summary and writes the full report to the browser console
(`[Intercede] diagnostics`). The console object is what to paste. It is metadata only:
version, host capabilities, eligibility state, lease counters, journal state, and which prompt
preset is in use ([LEASE-14](RATIONALE.md#LEASE-14), [PROMPT-02](RATIONALE.md#PROMPT-02)).

**It never contains prompt text or chat text.** It does contain `chat.id`, which on most
installs is a filename derived from the character and timestamp — redact that if it names
something you would rather not post.

If a lifecycle problem needs more than counters:

```js
Intercede.lifecycleLog()   // last 64 events: names, argument shapes, generation kinds
```

That log is always being recorded, so it is not empty in the session that needed it, and its
entries are redacted as they are captured — there is no message text in it to leak.

## What to include

Everything below is asked for by the issue forms, so filling one in gets you there:

- Intercede version (`/intercede diagnostics` → `version`) and SillyTavern version.
- Browser and operating system.
- Backend type (chat completion / text completion) and the provider or local model.
- Streaming on or off.
- Any other extension that touches messages, prompts, or the chat display — regex scripts
  set to *Alter Chat Display* especially.
- Exact steps, from a fresh chat if you can reproduce it that way.
- What you expected, and what happened instead.
- **Whether the original message came back.** Did Undo work? Was `/intercede recover`
  offered, and did it restore?
- The diagnostics report, and the console error if there was one.

Screenshots help, particularly for layout and for the confirmation screen. Redact roleplay
text you would rather not publish — a screenshot of the *shape* of the problem is worth as
much as a legible one.

## What not to send

- The contents of your chat, beyond the minimum needed to show the problem.
- Your prompt template, unless the report is about the prompt. If it is, say so and post it
  deliberately — nothing in Intercede sends it anywhere on its own.
- API keys, obviously, and anything from a network tab that carries one.

## If Intercede stopped mid-intercession

Do this before anything else, in this order:

1. **Do not close or switch the chat.** The recovery journal is scoped to the chat it was
   written in.
2. Run `/intercede recover` if it was offered.
3. Take the diagnostics report *before* trying anything further — `journal` is the field that
   says what stage it stopped at, and a later action may clear it.
4. File a **Recovery failure** report with that output.

Intercede deletes nothing it cannot prove it created, so "stopped without deleting anything"
is the designed outcome and the snapshot behind Undo is still there. That is what makes the
report recoverable rather than a post-mortem.
