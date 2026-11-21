---
title: "Enforce rules in tool_call, not in skill text"
kind: "decision"
summary: "Enforce command-shape rules in pi's tool_call hook (event.input is mutable) rather than skill text: the rewrite made /usr/bin/jq run the packaged build and lifted treadmill consistency from 4/6 to 6/6."
tags: [extensions, tool_call, before_agent_start, adoption, determinism]
created: "2026-11-21T02:43:49.975Z"
updated: "2026-11-21T02:43:49.975Z"
---
Prompt text steers a model probabilistically; pi's `tool_call` hook enforces deterministically. Asked to run `/usr/bin/jq --version` verbatim, a session with only skill text sometimes used the absolute path (the host's `jq 1.7.1-apple`); with a `tool_call` rewrite in place the same request executed the packaged `jq` and printed `jq-1.8.2`. Both rules this project cares about — bare names, and wrapping multi-step shell — moved from "usually followed" to "always true" only when enforced in code.

```text
tool_call  (event.input mutable)  → rewrite /usr/bin/jq → jq      deterministic
before_agent_start                → systemPromptOptions            deterministic
                                    .promptGuidelines += rule
skill body                        → loads only if model decides    opportunistic
skill description                 → always present, but competes
                                    with every other rule
```

## What to reach for

- **`pi.on("tool_call", ...)`** with `event.input` mutation is the only way to make a command-shape rule actually hold. The hook can also block (`{ block: true, reason }`), which suits a rule you would rather fail than see broken.
- **`pi.on("before_agent_start", ...)`** mutating `event.systemPromptOptions.promptGuidelines` (a `string[]`) puts a rule in every turn without a skill load. Make it idempotent — it fires every run, and duplicates are paid for on every turn.
- Skill text remains right for long-form reference, not for behavioural rules.

## Guardrails for a `tool_call` rewrite

Only rewrite what you can prove is safe: a token in command position (start, or after whitespace, `;`, `|`, `&`, `(`), and only names the package actually manages — `/usr/bin/tar` must survive, `echo "/usr/bin/jq"` is data, and `/usr/bin/jq-config` is a different program. Ship an env switch to disable it and a counter so the user can see it happening.

Measured effect: six graded prompts re-run twice each went from 4/6 consistent to 6/6 consistent with zero absolute-path violations once both the rewrite and the guideline injection were in place.
