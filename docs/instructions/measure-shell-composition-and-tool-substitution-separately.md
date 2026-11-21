---
title: "Measure shell-composition and tool-substitution separately"
kind: "instruction"
summary: "Grade \"prefer busybox\" as two metrics — shell wraps (11/45, none single-command) and applet substitution (0 of the packaged tools); parse JSONL and dedupe by toolCallId, or grep overcounts 262 for 11."
tags: [busybox, measurement, treadmill, skills, adoption]
created: "2026-11-21T03:03:56.316Z"
updated: "2026-11-21T03:04:22.761Z"
---
An instruction like "prefer busybox" has two independent meanings — using it as the **shell that composes** a command, and using its **applets instead of** other binaries — and a model can adopt one without the other. Counting "did it mention busybox" hides that. Measured over 37 pi transcripts after the instruction went in: 11 of 45 bash commands (24%) were wrapped in `busybox sh`, **none** of those wraps covered a single command, and there were **zero** invocations of `busybox grep|find|sed|cat|ls|tar` — the tools the package provides. The four applets that did appear (`head`, `wc`, `awk`, `sort`) have no packaged equivalent.

```text
"prefer busybox" = two claims, measure them apart

  shell composition   busybox sh -c '<multi-step>'    11/45 commands, 0 single-command wraps
  tool substitution   busybox grep instead of rg       0 occurrences
  leftover applets    head/wc/awk/sort                 4 uses, nothing packaged to replace them
```

## Recipe

Do **not** `grep -c` the raw JSONL: each command appears in several events (`message_start`, `message_end`, partial results), so a naive count over the same corpus returned **262** where the real figure was **11**. Parse the events and dedupe by `toolCallId`:

```sh
node --input-type=module -e '
import { readFileSync, readdirSync } from "node:fs";
const seen = new Set(); let cmds = 0, wraps = 0, single = 0; const applets = new Set();
for (const f of readdirSync(".").filter((f) => f.endsWith(".jsonl")))
  for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    for (const c of Array.isArray(r.message?.content) ? r.message.content : []) {
      if (c.type !== "toolCall" && c.type !== "tool_use") continue;
      const k = c.id ?? JSON.stringify(c); if (seen.has(k)) continue; seen.add(k);
      const cmd = String((c.arguments ?? c.input)?.command ?? ""); if (!cmd) continue;
      cmds++;
      if (/busybox\s+sh/.test(cmd)) { wraps++;
        if (!/[;|&]|\bfor\b|\bwhile\b|\bif\b/.test(cmd.replace(/^.*?busybox\s+sh\s+(-c\s+)?/s, ""))) single++; }
      for (const m of cmd.matchAll(/busybox\s+(?!sh\b)([a-z_][a-z0-9_]*)/g)) applets.add(m[1]);
    } }
console.log({ cmds, wraps, single, applets: [...applets] });'
```

A wrap whose body has no `;`, `|`, `&&`, `for`, `while` or `if` is a single command needlessly put in a subshell — the over-application signal.

## Why it decides whether to change the instruction

A 24% wrap rate with zero unnecessary wraps says the instruction is applied where it earns its place; a high single-command share would say it is being sprayed. Zero substitution of packaged tools says the "use busybox for what nothing else covers" boundary holds — worth keeping, because busybox `tar`, `sort` and `sed` differ from GNU in ways that break scripts.
