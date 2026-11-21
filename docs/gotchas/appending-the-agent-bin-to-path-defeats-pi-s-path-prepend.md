---
title: "Appending the agent bin to PATH defeats pi's PATH prepend"
kind: "gotcha"
summary: "pi prepends <agent dir>/bin to bash PATH only if absent; if a user appended it instead, host binaries win for bash while pi's grep/find still use the managed copies. Prepend, never append."
tags: [path, shadowing, getshellenv, gettoolpath]
created: "2026-11-21T02:05:03.335Z"
updated: "2026-11-21T02:05:03.335Z"
---
pi puts `<agent dir>/bin` first on the PATH of every bash call, so the managed binaries beat host copies — but only when the directory is not already in PATH. `getShellEnv()` in `dist/utils/shell.js` checks `pathEntries.includes(binDir)` and, if found anywhere, leaves the order alone. A user who appends the directory instead of prepending it silently inverts the guarantee: bash calls resolve to the host copy while pi's built-in `grep`/`find` tools still use the managed binaries, because `getToolPath()` in `dist/utils/tools-manager.js` checks `TOOLS_DIR` before PATH at all.

```text
getShellEnv()  (dist/utils/shell.js)
  binDir in PATH?  no   ->  [binDir, ...PATH]        managed wins    ✓
                   yes  ->  PATH unchanged            wherever it sat
                             appended  -> host wins   ✗
                             prepended -> managed wins ✓

getToolPath()  (dist/utils/tools-manager.js)
  always checks TOOLS_DIR/<binary> first, then PATH
```

## How to check on a machine

```sh
echo "$PATH" | tr ':' '\n' | head -3      # is ~/.pi/agent/bin line 1?
command -v jq gh ninja                    # inside a pi bash call
```

## The fix

In `~/.zshrc` / `~/.bashrc`, prepend — never append:

```sh
export PATH="$HOME/.pi/agent/bin:$PATH"
```

## Why it matters

This is only observable where a host copy exists. On the machine checked here exactly three of 25 tools collided — `/usr/bin/jq` (1.7.1-apple vs managed 1.8.2), `/opt/homebrew/bin/gh` and `/opt/homebrew/bin/ninja` — so the silent divergence is narrow but version-significant, since jq 1.7 and 1.8 differ in number formatting.
