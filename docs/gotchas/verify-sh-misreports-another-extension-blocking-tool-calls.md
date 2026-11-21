---
title: "verify.sh misreports another extension blocking tool calls"
kind: "gotcha"
summary: "scripts/verify.sh fails with \"does not name pi's bin directory\" when another extension blocks tool calls in non-interactive pi; use an isolated PI_CODING_AGENT_DIR instead of debugging the plugin."
tags: [verify, pi-docs-first, testing]
created: "2026-11-21T02:02:49.151Z"
updated: "2026-11-21T02:02:49.151Z"
---
`scripts/verify.sh` drives `pi` non-interactively and dies when any other installed extension intercepts tool calls. In this project it failed with `FAIL: the tool output above does not name pi's bin directory`, because the `pi-docs-first` extension answered in place of the check and refused to run the requested tool. The failure looks like a bug in this plugin and is not one.

The script assumes a plain pi: it runs `pi list`, requires the package to appear there, then runs one `managed_tools` call in a scratch directory and greps the output for the bin path.

```text
scripts/verify.sh
   │
   ├─ pi list ────────────────> package present? ok
   └─ pi -p "/managed-tools status"
            │
            ├─ plain pi      ──> "bin dir: …"        ✓ grep matches
            └─ other extension intercepts the tool call
                             ──> unrelated text       ✗ FAIL, blames this plugin
```

## Workaround

Run the check with an isolated agent profile so only the package under test loads. Point `PI_CODING_AGENT_DIR` at a scratch dir listing just this package plus the provider extension, and link `auth.json`, `models-store.json`, `npm/` and `bin/` from `~/.pi/agent` — otherwise pi reports "No models available" or re-downloads every tool.

```sh
PI_CODING_AGENT_DIR=/tmp/probe/agent pi -p "/managed-tools status"
```

## Better fix

Have `verify.sh` compare the output against the expected `bin dir:` line and, when it is absent, print the raw text and say an extension may have intercepted the call. That is a change to `scripts/verify.sh`, not to the extension.
