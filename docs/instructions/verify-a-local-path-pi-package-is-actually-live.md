---
title: "Verify a local-path pi package is actually live"
kind: "instruction"
summary: "Local-path pi packages need no download — bump package.json version; verify the code is live by grepping the role=system message in `pi --mode json` output, not by trusting a transcript."
tags: [pi, extensions, local-path, verification, changelog]
created: "2026-11-21T02:47:10.407Z"
updated: "2026-11-21T02:47:10.407Z"
---
For a package installed as a **local path** (`pi install ./dir`), `pi update --extensions` prints "Packages are already up to date" and downloads nothing: the working tree *is* the installed version, so bumping `version` in `package.json` is the whole update. pi decides whether to show a changelog by comparing that version against `extensionChangelogVersions` in `~/.pi/agent/settings.json`, keyed like `{"source":"../../src/my-pkg","scope":"user"}` — so a bump makes the next launch show "Extension Updates" for every version since the recorded one.

Verifying the new code is actually live needs no model cooperation: extension hooks that fire unconditionally leave a trace in the JSON event stream.

```text
pi --mode json -p "Reply with exactly: ok"  > out.jsonl
   └─ message_end with role=system  ──> contains text injected by
                                        before_agent_start / promptGuidelines

pi --mode json -p "Run verbatim: /usr/bin/jq --version"
   └─ output says 1.8.2 while /usr/bin/jq --version says 1.7.1  ──> tool_call rewrite live
```

## Recipe

```sh
node -e 'console.log(require("./package.json").version)'   # working tree version
pi update --extensions                                     # expect a no-op for local paths
pi --mode json -p "Reply with exactly: ok" > out.jsonl
node -e 'const fs=require("fs");for(const l of fs.readFileSync("out.jsonl","utf8").split("\n")){let r;try{r=JSON.parse(l)}catch{continue}if(r.type==="message_end"&&r.message?.role==="system")console.log(JSON.stringify(r.message).includes("MY MARKER TEXT"))}'
```

Do not infer "installed" from `pi list` alone — it lists configured packages, not loaded code — and do not infer it from a model transcript, because a model may simply follow the same rule you were trying to inject.
