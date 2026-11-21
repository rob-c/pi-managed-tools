---
title: "An empty binary runs fine on Linux and fails on macOS"
kind: "gotcha"
summary: "Linux runs an empty/unheadered executable through /bin/sh and exits 0 while macOS returns ENOEXEC — check file size before trusting any \"does it run?\" probe, and run CI on both OSes."
tags: [exec, linux, macos, ci-matrix, damage-detection]
created: "2026-11-21T03:35:07.633Z"
updated: "2026-11-21T03:35:07.633Z"
---
On Linux, executing a file with no valid executable header does not fail: the C library (via libuv) falls back to `/bin/sh file`, so an **empty** file runs and exits 0. macOS returns `ENOEXEC` instead. Any "is this binary runnable?" probe is therefore platform-dependent, and a zero-length binary reads as healthy on Linux — which is exactly what happened here: the damage detector offered no repair for an empty managed binary, and the bug was invisible until the first Ubuntu CI run passed 84/85 while macOS passed 85/85.

```text
spawnSync(emptyFile, ["--version"])
  macOS  -> status null, error ENOEXEC   -> probe says "does not run"   OK
  Linux  -> status 0 (via /bin/sh)       -> probe says "healthy"        WRONG
```

## The fix

Check the file size before trusting the probe, and treat zero bytes as damage in its own right:

```ts
if (statSync(binaryPath).size === 0) { problems.push(`${name} is empty`); continue; }
if (!probeBinary(binaryPath).ran) problems.push(`${name} does not execute`);
```

Size is cheap and deterministic; the exec probe is neither. Report the two reasons separately so the message says which one it was.

## Where this bites beyond binaries

The same shell fallback applies to any "can I execute this?" test — checks for a script's shebang, a downloaded installer, a stubbed test fixture. On macOS a malformed fixture fails loudly; on Linux `/bin/sh` may accept it and return 0. A test asserting "this input is rejected" must therefore either add an explicit size/format check or assert on the *reason*, not merely on failure.

CI matrix note: this class of defect is only findable by running the suite on each target OS. A single-OS suite passed for months of changes here.
