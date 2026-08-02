[← Documentation](README.md) · [Known issues](KNOWN-ISSUES.md) · [Report a problem](REPORTING-PROBLEMS.md) · [Testing status](TESTING-STATUS.md)

# Troubleshooting

Most of the messages below are Intercede working correctly. It rewrites canonical chat
history, so it is built to stop and say so rather than to guess, and a stop is a much better
outcome than a silent repair. The distinction worth learning is between the two failure
words it uses:

- **"rolled back"** — your original message is already back. Nothing is left to do.
- **"stopped without deleting anything"** — the chat is as it was left, and
  `/intercede recover` is waiting. Something *is* left to do.

They are never both true, and only one is ever shown for a given failure
([ERR-02](RATIONALE.md#ERR-02)).

Run `/intercede diagnostics` before and after anything you try here. See
[REPORTING-PROBLEMS.md](REPORTING-PROBLEMS.md) for what it contains and what to redact.

## Nothing happens / the button is missing

**The ↩ button does not appear on a message.** Intercede only works on the **latest completed
assistant message**. It will not appear on your own messages, on older assistant messages, or
while a generation is running. This is a limitation, not a bug — older history is never
silently rewritten.

**Nothing happens anywhere.** Check *Extensions → Intercede → Enabled*. When it is off you
get: *"Intercede is switched off — enable it in the extension settings to respond inside a
message."* Undo, compare, recover and finalize deliberately keep working while it is off, so
turning it off can never strand a committed intercession.

> *"Intercede cannot start — this SillyTavern build is missing: …"*

A required host capability is absent. Intercede needs **SillyTavern 1.18.0+**. If you are on
1.18.0 or later and still see this, the named capability is the report — that list is the
whole diagnosis.

## Selection problems

> *"No safe insertion points were found in this message."*

Every candidate cut fell inside a protected region: a code fence, inline code, an HTML tag, a
macro, paired Markdown emphasis, a run of list items, or a link. Cutting there would produce
two broken messages. Try *Paragraphs and sentences* in the settings if you are on paragraphs
only — a message written with single newlines between lines has no blank lines, and therefore
no paragraph boundaries.

> *"No insertion points found in the visible text of this message."*

Different cause: the boundaries exist but they are all inside text a display regex is hiding
(a `<response_consideration>` block being stripped at render time, typically). Intercede will
not offer a cut inside text you cannot see, because the hidden block would be split across two
messages ([VIS-01](RATIONALE.md#VIS-01)).

> *"In-place mode could not attach to this message — using the floating window."*

Harmless fallback. The message's DOM was not in the shape the inline renderer expects, so the
reading overlay opened instead. Everything works the same way from there.

> *"The message changed after selection — the cut was rebased to the same context."*

Something edited the message between selection and commit, and the cut was unambiguously
relocated to the same surrounding text. Informational. If it had been ambiguous, the
intercession would have aborted instead.

## The intercession failed

> *"Intercession failed and was rolled back: … Your response text was kept — open Intercede
> again to retry."*

Your original message has been restored from its snapshot and the messages Intercede created
were removed. Your typed response was kept, so reopening Intercede gets you back to where you
were. The text after the colon is the actual reason; the common ones follow.

> *"The reply cannot be attributed to this intercession…"*

Intercede tracks the rewrite instruction to the specific generation call that consumed it. If
an unrelated generation took it, or two matching generations ran at once, the reply cannot be
proven to be Intercede's — so it is not claimed. Usually another extension generating in the
background. Nothing was changed or deleted.

> *"Another generation … overlapped this intercession and removed the rewrite instruction
> before it could be used…"*

The instruction is installed for exactly one generation and cleared aggressively so it cannot
leak into summaries or later requests. Another generation overlapping the window strips it,
and the continuation would have been written without any rewrite instruction at all. Intercede
refuses that reply rather than committing a rewrite that never happened.

A summarisation or memory extension that generates on message events is the usual cause. If
it is reproducible, that pairing is worth a
[compatibility report](COMPATIBILITY.md).

> *"No assistant continuation was captured for this intercession."*

The generation produced no message Intercede could identify. Failing closed here is correct —
nothing was committed. This has been seen once in the field and never reproduced; it is
[on record as an open question](KNOWN-ISSUES.md#under-investigation), and a recurrence now
arrives with per-reason counts in diagnostics. **If you hit this, the diagnostics report is
genuinely valuable.**

## Recovery

> *"Intercede stopped without changing anything further: …"*
> *"Intercede stopped without deleting anything… Restore the original message from its
> snapshot, or keep the chat exactly as it stands now?"*

Ownership could not be proven, so nothing was deleted. You are being asked to decide:

- **Restore** puts the original message back from the snapshot.
- **Keep** leaves the chat exactly as it is, clears the interrupted transaction's markers, and
  records it as abandoned — **the snapshot is kept**. Declining a restore never discards the
  only copy of your original text.

Run `/intercede recover` if the prompt is gone and you want it back.

> *"An unfinished intercession exists in another chat (…). Open that chat to recover it."*
> *"The chat changed during an intercession. Reopen that chat to restore the original message."*

The journal belongs to the chat it was written in. Switch back to that chat and run
`/intercede recover` there. Nothing is lost in the meantime.

> *"Recovery aborted: the target message no longer matches the snapshot. Nothing was changed."*
> *"Recovery aborted: the chat is shorter than the snapshot expects."*
> *"Recovery stopped: later messages could not be proven to belong to the intercession.
> Nothing was deleted."*

The chat moved on far enough that restoring would be a guess. Recovery refuses to guess. Your
snapshot is still in the vault — `/intercede compare` may still show you the original text
even when it cannot be automatically restored.

> *"The original message was restored in memory but the chat could not be saved. Do not close
> this chat."*

Take this one literally. The restore worked, but SillyTavern could not write the chat file.
Closing or switching now loses it. Get the save working — free disk space, check the
SillyTavern server is still running — and trigger a save.

> *"The stored snapshot for this intercession is no longer available."*

The vault entry is gone, so Undo cannot restore. `/intercede finalize` deletes snapshots on
purpose; `/intercede cleanup` deletes them past the configured age, but never one that can
still be undone. Clearing browser site data for the SillyTavern origin removes all of them —
snapshots live in this browser profile and do not travel with an exported chat.

## Undo and Compare

**The Undo button is not there.** Undo is only available while the intercession is still the
chat tail. Once anything follows it, the chain has to unwind newest-first. The buttons also
appear only after the snapshot behind them has been confirmed present, so a missing button
means a missing snapshot rather than a broken button.

## The rewrite itself is bad

Not an error state — this is prompt tuning. **The settings below need v0.7.0 or later**;
v0.6.0 has a fixed instruction and no Prompt section.

| Symptom | Try |
| --- | --- |
| The continuation repeats the preserved prefix | *Reimagine remainder*, or a stronger custom instruction |
| Your inserted response is ignored | *Adapt naturally* rather than *Preserve closely* |
| The model narrates the instruction back at you, or says "scene notes" | The **Terse** preset — small local models do this with long preambles |
| The backend rejects the request outright | Read [PROMPT-01](RATIONALE.md#PROMPT-01). Phrasing that reads as an instruction to reuse model output is refused by some hosted filters |
| Output is fine but you want fewer tokens | The **Direct** preset |

Intercede's advisory warnings — prefix repetition, ignored insertion, meta-commentary — never
block or alter a commit. They are prompts to re-read, not verdicts, and the meta-commentary
one is tuned to the default vocabulary ([VAL-05](RATIONALE.md#VAL-05)).

Use **Preview the assembled instruction** in the Prompt settings before blaming the model. A
custom template that lost its `{{suffix}}` marker is not used at all — Intercede falls back to
the default and says so above the preview.

## Still stuck

[File a report.](REPORTING-PROBLEMS.md) A failure Intercede handled cleanly is still worth
reporting: the handling is designed, the *cause* usually is not.
