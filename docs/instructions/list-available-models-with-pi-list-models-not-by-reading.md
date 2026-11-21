---
title: "List available models with pi --list-models, not by reading settings.json"
kind: "instruction"
summary: "When asked \"what models are available\", run `pi --list-models [search]`; the catalog comes from ~/.pi/agent/models-store.json, not from settings.json."
tags: [pi, models, cli, settings, catalog]
created: "2026-11-21T02:50:21.183Z"
updated: "2026-11-21T02:50:21.183Z"
---
Asked "models", the right move here is the harness command `pi --list-models` (optionally `pi --list-models <fuzzy-search>`). It prints provider, model id, context window, max output, and whether thinking and image input are supported. Do not try to reconstruct the list from `~/.pi/agent/settings.json` — that file only holds `extensionChangelogVersions`, `lastChangelogVersion` and `packages`, so a `jq` for defaultProvider/defaultModel/models/thinkingLevel returns all nulls and says nothing about what exists.

```mermaid
flowchart LR
  A["pi update"] -->|refreshes| B["~/.pi/agent/models-store.json<br/>(per-provider catalog)"]
  B -->|read by| C["pi --list-models"]
  D["env: PI_PROVIDER / PI_MODEL /<br/>PI_REASONING_LEVEL"] -->|current session's choice| C
  E["~/.pi/agent/settings.json<br/>(no model keys)"] -.->|does NOT supply models| C
  C --> F["provider · model · context · max-out<br/>thinking · images"]
  G["pi --provider X --model Y<br/>pi --models 'glob'"] -->|override per run| D
```

## Where the data actually lives

- Model catalog: `~/.pi/agent/models-store.json` — a per-provider map (`jq -r keys` → e.g. `lunaroute`). `pi update` refreshes model catalogs; it is fetched data, not project config.
- Runtime choice: the `PI_PROVIDER` / `PI_MODEL` / `PI_REASONING_LEVEL` environment variables of the running session (e.g. `lunaroute` / `deepseek-4.1-flash` / `medium`). Read them with `env | grep '^PI_'`; they reflect this session, not a saved default.
- Override per run with `pi --provider <name> --model <pattern>` (pattern accepts `provider/id` and a `:<thinking>` suffix) or `pi --models <globs>` to set what Ctrl+P cycles through.

## Gotcha

`pi --help` has no `models` subcommand — the flag is `--list-models`. `pi update` is the command that touches catalogs.
