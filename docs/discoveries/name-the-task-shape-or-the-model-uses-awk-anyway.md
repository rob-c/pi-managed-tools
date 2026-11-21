---
title: "Name the task shape, and put it early in the description"
kind: "discovery"
summary: "A rule fires only if the task shape is named in the always-on description AND placed early: the same busybox-sh clause appended at the end did nothing, moved mid-description it fired."
tags: [skills, prompting, adoption, measurement, description-position]
created: "2026-11-21T02:02:37.375Z"
updated: "2026-11-21T02:12:28.077Z"
---
Models adopt a package's preferred CLI tools only when the task shape is named in text that is always in context — and **where that sentence sits in the description matters**. Against this plugin, a shell rule appended at the end of the always-on description did not fire (the model ran a bare `for` loop); the identical clause moved into the middle, right after the first instruction sentence, fired immediately (`busybox sh -c '…'`). Earlier probes showed the same shape dependence: a 25-line excerpt was read with `awk 'NR>=900'` and a JSON file with `python3 -c`, despite `bat` already being named as the `cat` replacement in that same always-on text.

"Show me a line range" does not read as a `cat` task, so a `cat`-replacement rule never fires. Naming the task shape does — and placing it early does.

```text
                      what the model sees
  always-on description ─────────────┐  (every prompt)
  reference body         ────────────┴┐ (only if it decides to load it)
                                      ▼
  "show me lines 900-925"   ──> awk 'NR>=900'      ✗ rule was "bat over cat"
  "which failures?"         ──> python3 -c         ✗ rule was "gron over JSON"

  name the shape, at the END of the description:
    "…run multi-step shell logic as busybox sh -c '…'"
      ──> for d in skills/*/; do …                ✗ did not fire

  the SAME clause moved into the middle:
      ──> busybox sh -c 'for d in skills/*/; do …' ✓ fired
```

## How to apply it

- Name the **task shape**, not the tool it replaces: "reading a line range → `bat -n -r A:B` — not awk/sed/head", "reading JSON → `jq` — not python3 -c".
- Put it in the always-on description and **put it early**. Appending a clause to a description that already lists many rules is close to adding nothing.
- Say explicitly that the preference applies to one-liners too.
- Verify by re-running the identical prompt; a skill edit without a before/after measurement is a guess. Re-run after moving text, not just after writing it.

## Cost

The always-on description is paid in every system prompt. Three shapes took it from 504 to 589 characters; the shell and bare-name rules took it to 850. That is the price of the behaviour, and the position experiment says a longer tail buys less than a shorter middle.
