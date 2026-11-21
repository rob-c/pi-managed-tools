---
name: managed-tools
description: "Prefer rtk to shrink command output, then this toolkit over system binaries. rtk returns the verdict or failures only (rtk test/err/git diff/ls/find/json/deps/env) — use it whenever you need the result, not the content. Every multi-step shell command must be wrapped: `busybox sh -c '...'` — wrap it before writing the loop, pipeline or `for` — with plain bash only for arrays, ${v^^} or mapfile. Ground yourself once with `command -v rg jq bat` before exploring. Otherwise prefer rg over grep, fd over find, bat over cat (bat -n -r A:B reads a line range), jq to read or query JSON, gron to explore it, ast-grep over regex edits, just/ninja over guessed builds, shellcheck for shell, prek for hooks. Applies to one-liners too. Call them by bare name, never by absolute path (/usr/bin/jq): the packaged copy is first on PATH. Exact flags and which of them write: managed-tools-reference. Per-applet busybox safety: busybox-applets."
---

# Managed tools

Twenty-five binaries on `PATH`, installed and version-tracked by `pi-managed-tools`.
Their flags are fully known — load `managed-tools-reference` instead of running
`--help`.

fd 10.5.2 · rg 15.2.0 · bat 0.26.1 · just 1.59.0 · gron 0.7.1 ·
shellcheck 0.11.0 · ast-grep 0.51.3 · ninja 1.13.2 · prek 0.5.11 · rtk 1.2.1
jq 1.8.2 · yq 4.54.3 · fzf 0.75.0 · uv 0.13.9 · gh 2.105.0 · bd 1.3.4
agent-browser 0.43.0 · ruff 0.17.6 · mise 2026.11.11
scc 4.1.0 · duckdb 2.0.1 · miller 6.22.0 · sd 1.1.0 · difftastic 0.72.0
busybox 1.39.0 (236 applets — see busybox-applets)

## Start here

Before exploring an unfamiliar repo, spend one command on how this CLI is wired.
Skipping it is how a small model ends up with inconsistent results and blames the
code instead of the environment.

```sh
busybox sh -c 'echo "PATH0=${PATH%%:*}"; command -v rg fd jq bat scc busybox'
```

Read it as three facts, then continue:

1. **`PATH0` is `<agent dir>/bin`** → the packaged binaries are what run. If it is
   not, say so once (see *Which binary runs*) and keep using bare names anyway.
2. **Every tool resolves under `<agent dir>/bin`** → versions are the ones in the
   version list above, not the host's.
3. **`busybox` is present** → multi-step shell logic can use `busybox sh -c '…'`.

Do not re-derive this per step: once at the start is enough, and re-checking it
mid-task is how a session drifts back to `awk`/`python3 -c`.

## Order of preference

1. **`rtk <cmd>` first** for any command whose output you only need to *judge*.
2. **These binaries over system ones** — they are the same tools, newer, and
   already on `PATH` ahead of `/usr/bin`.
3. Plain commands only when you need the bytes.

This holds for one-liners as much as for whole tasks: a 25-line excerpt is still
read with `bat`, a single JSON field is still extracted with `jq`, a directory
listing is still `fd`. Reaching for `awk`/`sed`/`python3 -c`/`cat` skips a tool
that is already installed and documented.

## Which binary runs

Use the bare name — `jq`, `gh`, `rg`, `bat`, `scc` — never an absolute path such as
`/usr/bin/jq`, `/opt/homebrew/bin/gh` or `/Users/<you>/.pi/agent/bin/rg`. The
packaged copy is already first on `PATH` in every bash call, so the bare name
resolves to it; an absolute path is how you silently pick the host's older build
(`/usr/bin/jq` is 1.7.1 on this class of machine, the packaged one is 1.8.2).

Check rather than assume: `command -v jq` should print `<agent dir>/bin/jq`.

If it prints a host path, the user's shell rc has the agent bin *appended* rather
than prepended, and pi leaves `PATH` alone when the directory is already present.
Do not work around it with an absolute path, and do not `export PATH=…` in a
command — each bash call is a fresh shell, so it fixes nothing beyond that one call.
Report it instead: the durable fix is
`export PATH="$HOME/.pi/agent/bin:$PATH"` in the shell rc, followed by a pi restart
(the running process keeps the env it started with).

One exception: an absolute path is correct when the task is to *inspect* the host
copy ("is `/usr/bin/jq` older?"). That is a deliberate comparison, not a choice of
which binary to run — say which one you are running and why.

## Shell

Run multi-step shell logic through **`busybox sh`**, not the ambient shell. It is the
same static ash binary on every platform this package supports, so a command means
the same thing everywhere and does not depend on which bash is installed, whether
`/bin/bash` exists, or what the user's zsh does.

```sh
busybox sh -c 'for f in src/*.ts; do echo "$f $(wc -l < "$f")"; done'
busybox sh <<'EOF'
set -eu
for d in skills/*/; do echo "$(basename "$d")"; done
EOF
```

busybox ash is POSIX plus extensions, so these work: `[[ ]]`, `<(…)`, `<<<`, `$'…'`,
`local`, `function`, `set -o pipefail`, `${v//a/b}`, `${v:1:2}`, `printf -v`,
`trap … ERR`, `$RANDOM`.

These do **not** work — for one of these, drop the prefix and let pi's own shell run
the command (`/bin/bash` on macOS, `sh`/`bash` from `PATH` on Linux), and say why:

- arrays: `a=(1 2)`, `a+=(x)`, `declare -A`
- `${v^^}` / `${v,,}` case modification
- `read -a`, `mapfile` / `readarray`
- `coproc`, `extglob` (`@(…)`)

Quoting: pi runs your command through its own shell first, so `busybox sh -c '…'` is
nested. Use double quotes inside it, or the heredoc form for anything long.

## Before anything that writes

`managed-tools-reference` carries a read-only vs mutating table for all twenty-five
tools. Check it before any command that can rewrite, delete or upload — several
mutate with **no flag at all** (`sd`, `ruff format`, `just`, `ninja`, `uv run`,
`duckdb FILE`, `agent-browser open`). Prefer the dry run: `just -n`, `ninja -n`,
`uv --dry-run`, `mise -n`, `prek run --dry-run`, `bd --readonly`,
`duckdb -readonly`, `sd -p`, `ast-grep` without `-U`.

## Verdict vs content

`rtk` summarises. It will happily replace a diff with `a.txt | 1 +`, and
`rtk err` keeps stderr while discarding stdout. That is the point for "did it
pass?" and dangerous for "show me what changed".

- Need the **verdict**: `rtk test <cmd>`, `rtk err <cmd>`, `rtk deps`, `rtk env`,
  `rtk json f --keys-only`, `rtk ls`, `rtk find`.
- Need the **content**: plain `git diff`, `bat --paging=never`, `rg`, `gron`.
- Unsure? Run it plainly. A re-run costs more than the tokens saved.

## Tool choice

| Instead of | Use |
|---|---|
| `find` | `fd` |
| `grep -r` | `rg` (add `--hidden -I` when hidden or gitignored files matter) |
| `cat` | `bat --paging=never` |
| regex edit of code | `ast-grep run -p '<pattern>'` (preview, then `-r`) |
| ad-hoc JSON poking | `gron`, or `rtk json` |
| guessing a task command | `just -l` then `just -n` |
| guessing a build | `ninja -t targets`, then `ninja -n` |
| eyeballing shell bugs | `shellcheck -f gcc` (advisory; never rewrite) |
| reading a line range of a file | `bat --paging=never -n -r 900:925 file` — not awk/sed/head |
| reading or querying JSON | `jq -r '.path'`, `jq -c 'select(...)'` — not python3 -c or grep |
| exploring an unknown JSON document | `gron file.json \| rg 'users'` |
| hand-run hooks | `prek run` (`install` mutates `.git/hooks` — confirm first) |
| a JSON/YAML fishing trip | `gron`, `jq -r`, or `yq -o json` |
| `python -m venv` + pip | `uv run <cmd>` |
| `curl` against the GitHub API | `gh api` |
| writing a picker | `fzf --filter` (interactive needs a TTY you do not have) |
| tracking work in a scratch file | `bd q` / `bd list` — but `bd init` rewrites `AGENTS.md`, so ask first |
| curl-ing a page to read it | `agent-browser read <url>`, then `open` + `snapshot` for interaction |
| `python -m py_compile` / eyeballing style | `ruff check --statistics`, `ruff format --check` |
| guessing which runtime version a repo wants | `mise exec -- <cmd>` (activation never happens in pi's bash) |
| counting lines of code | `scc .` (`--by-file`, `-f csv`) |
| awk-ing CSV or joining tables | `mlr --csv ...` or `duckdb -c "select ..."` |
| regex rewrite of many files | `sd -p` first, then `sd` (it edits in place) |
| reading a big diff | `difft --display inline` (structural, falls back to lines) |
| an applet this package lacks (`hexdump`, `unzip`, `patch`, `sha256sum`) | `busybox <applet>` — never `busybox --install -s` |
