---
title: "State the CLI environment, do not ask the model to discover it"
kind: "discovery"
summary: "Models probe the environment first on only 2 of 12 graded runs; injecting the facts as a system-prompt section costs no turns and keeps adoption at 12/12."
tags: [treadmill, grounding, sections, before_agent_start, small-models]
created: "2026-11-21T03:00:46.647Z"
updated: "2026-11-21T03:00:46.647Z"
---
Models do not establish the command-line environment before exploring unless the task asks them to. Across a treadmill of six graded prompts run twice on two models, adoption of the packaged tools was 12/12 and fully consistent on both — but the environment was probed first on only **2 of 12** runs, and those two were the prompts that explicitly asked "what shell runs my commands here". On real tasks the model dives straight in.

Instructing a probe does not fix that reliably; stating the facts does. pi's `before_agent_start` can add a `sections` entry (`Record<string, string>`, XML-wrapped), so the extension now injects the facts it already knows: `<agent dir>/bin` is first on `PATH`, the packaged versions that implies (read from the state file, no subprocesses), that bare names are correct, and that multi-step logic belongs in `busybox sh -c '…'` — closing with "do not spend a turn probing it".

## Why state beats probe

```text
ask the model to probe        → 2/12 did, and the probe costs a turn
state the facts in a section  → 0 turns spent, same adoption (12/12, consistent)
```

The extension knows these facts; making the model discover them is wasted context and a chance for a small model to conclude something wrong.

## Two implementation notes

- **Build the section text once per process.** pi diffs sections against what the model already has; a string that changes per turn patches the prompt every turn.
- **Read versions from the state file** (`<agent dir>/bin/.pi-managed-tools.json`) rather than running each binary `--version`; five subprocesses per turn is real latency for a line of text.

## Measurement trap

A run that used pi's built-in `grep` tool scored as a miss in the first version of the scorer. That tool is backed by the managed `rg` via `getToolPath()`, so it *is* adoption. Count the built-in `grep`/`find` tools as `rg`/`fd` when grading.
