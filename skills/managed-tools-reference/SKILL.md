---
name: managed-tools-reference
description: "Exact flags and worked examples for the pinned fd, rg, bat, just, gron, shellcheck, ast-grep, ninja, prek and rtk binaries. Load before invoking any of them, especially for structural edits (ast-grep), build invocation (ninja, just) or output compression (rtk)."
---

# Managed tools — exact reference

Versions are fixed by `pi-managed-tools`; every flag listed exists in the
installed build and nothing else is needed.

fd 10.5.2 · rg 15.2.0 · bat 0.26.1 · just 1.59.0 · gron 0.7.1 ·
shellcheck 0.11.0 · ast-grep 0.51.3 · ninja 1.13.2 · prek 0.5.11 · rtk 1.2.1
jq 1.8.2 · yq 4.54.3 · fzf 0.75.0 · uv 0.13.9 · gh 2.105.0 · bd 1.3.4
agent-browser 0.43.0 · ruff 0.17.6 · mise 2026.11.11
scc 4.1.0 · duckdb 2.0.1 · miller 6.22.0 · sd 1.1.0 · difftastic 0.72.0 · busybox 1.39.0

## Policy

Token order: `rtk` to shrink output, then these binaries over the system ones,
plain commands last.

`rtk` decides *what you need*: the verdict, or the content.

- **Verdict** — pass/fail, an error list, a shape. Use rtk: `rtk test <cmd>`,
  `rtk err <cmd>`, `rtk deps`, `rtk env`, `rtk json f --keys-only`, `rtk ls`,
  `rtk find`, `rtk git status`. It is aggressive: `rtk git diff` reduces a diff to
  `a.txt | 1 +` plus a file list, and `rtk err` keeps stderr while discarding
  stdout. Both are correct for "did it work" and wrong for "what changed".
- **Content** — bytes you will edit, quote or reason about. Do not use rtk: plain
  `git diff`, `bat --paging=never`, `rg`, `gron`, `ast-grep`.
- When it matters, run plainly once rather than re-running a truncated result.

Precedence for every other task: `rg` over `grep`, `fd` over `find`, `bat` over
`cat`, `ast-grep` over regex on code, `gron` over ad-hoc JSON parsing, `just -l`
over guessing a recipe, `ninja -t targets`/`-n` over guessing a build step,
`shellcheck` for shell (advisory), `prek` for hooks.

## Why the bare name resolves to the packaged binary

Two independent mechanisms, and one way to defeat both.

| Mechanism | Where | Effect |
|---|---|---|
| `getShellEnv()` prepends `<agent dir>/bin` | `dist/utils/shell.js` | first entry on `PATH` for every bash call |
| `getToolPath()` checks `TOOLS_DIR` before `PATH` | `dist/utils/tools-manager.js` | pi's built-in `grep`/`find` use the managed `rg`/`fd` regardless of `PATH` |

```bash
command -v jq gh rg bat scc          # should all print <agent dir>/bin/<tool>
echo "$PATH" | tr ':' '\n' | head -1  # should be <agent dir>/bin
```

`getShellEnv()` only prepends **when the directory is not already in `PATH`**. If a
shell rc appends it (`PATH="$PATH:$HOME/.pi/agent/bin"`), the order is left alone and
a host copy can win for bash calls — while pi's built-in tools keep using the managed
ones, so the two paths diverge. Tell the user to prepend and restart pi; an
`export PATH=…` inside a bash call dies with that call, because each call is a new
`spawn(shell, [...args, command])`.

Never write an absolute binary path (`/usr/bin/jq`, `/opt/homebrew/bin/gh`) to run
work — it bypasses both mechanisms and pins the host's version forever. The only
legitimate use is deliberately inspecting the host copy for comparison.

## Read-only vs mutating

Assume a bare tool name mutates. `just`, `ninja`, `prek run`, `mise <task>`, `uv run`,
`sd`, `ruff format`, `agent-browser open`, `duckdb FILE` and any `bd` write verb all
change something with no flag needed.

Dry-run when unsure: `just -n` · `ninja -n` · `uv --dry-run` · `mise -n` ·
`prek run --dry-run` · `bd --readonly` · `duckdb -readonly` · `ast-grep` without `-U` ·
`sd -p`.

| tool | read-only | mutates (★ = destructive) |
|---|---|---|
| fd | everything | nothing itself; `-x`/`-X CMD` runs a child per result |
| rg | everything (`-r` only changes printed output) | nothing; `--pre CMD` runs a child per file |
| bat | everything, incl. `--diff` (reads git index) | `cache --build` writes `~/.cache/bat`; ★`cache --clear` deletes it; `--pager CMD` execs |
| gron | everything (`-u` prints JSON) | nothing |
| shellcheck | everything (`-f diff` prints a patch only) | nothing |
| jq | everything (1.8.2 has **no** `-i`) | nothing |
| mlr | every verb, all format flags | ★`tee FILE` overwrites; ★`split` writes/overwrites `split_*` in cwd; DSL `tee >`/`emit >`; `--prepipe CMD`; `--no-shell` disables |
| difft | everything (`--check-only` is a pure report) | nothing |
| fzf | everything, provided no `--history`/`--bind` | `--history FILE` writes; `--bind`/`--preview`/`--info-command` exec; `--listen` allows remote exec |
| scc | everything except the three below | `-o FILE`, `--format-multi`, `--report=PATH` write (bare `--report` prompts first) |
| ast-grep | `-p … -r …` only prints; `scan` has **no** `--fix` | ★`-U/--update-all` and `-i/--interactive` rewrite files |
| sd | `-p/--preview`; stdin to stdout | ★**in place by default** whenever file arguments are given |
| ruff | `check`, `check --diff`, `format --check`, `format --diff` | ★`format` rewrites by default; `check --fix`/`--unsafe-fixes`; ★`clean` deletes `.ruff_cache` |
| yq | default prints to stdout | ★`-i/--inplace` rewrites the **first file only**; ★`-s/--split-exp` creates files and dirs (cwd unless `--security-allow-write-any-path`) |
| duckdb | `-readonly`, `-c` with a plain SELECT | ★`duckdb FILE` creates or opens that db; SQL can CREATE/INSERT/COPY TO; `.shell`, `INSTALL`, `LOAD` |
| just | `-n/--dry-run`, `-l`, `-s`, `--summary`, `--dump`, `--fmt --check` | ★bare `just` runs the first recipe (arbitrary shell); `--fmt` rewrites the justfile; `--init` creates one; ★`--clean` deletes cached recipe metadata |
| ninja | `-n` (writes nothing), `-t targets`, `-t commands`, `-t query`, `-t graph`, `-t rules`, `-t deps` | ★bare `ninja` builds (outputs, `.ninja_log`); ★`-t clean`, ★`-t cleandead` delete outputs; `-t restat`, `-t recompact` rewrite the log |
| prek | `list`, `validate-config`, `validate-manifest`, `run --dry-run`, `cache dir` | `run` executes hooks (often auto-fixers); `install`/`uninstall` write or remove `.git/hooks`; `update` rewrites config revs; ★`cache clean`, ★`cache gc` delete; `self update` replaces the binary |
| mise | `ls`, `outdated`, `env`, `bin-paths`, `where`, `doctor`, `config ls`, `fmt -c`, any `-n/--dry-run` | `use`/`install` install toolchains and write config; ★`prune`, ★`uninstall --all`, ★`cache clear`, ★`implode` delete; `fmt` rewrites config; `trust`; `self-update`; ★`install-into` wipes the target path |
| uv | `pip list`, `pip freeze`, `pip tree`, `pip check`, `lock --check`, `python list`, `tree`, `--dry-run` forms | ★`run`/`sync`/`add`/`remove`/`lock` modify env and lockfile with no flag; `pip install`/`pip uninstall`; ★`venv --clear`; `python install`; `tool install`; ★`publish` (remote, irreversible); ★`cache clean`; `auth login`/`auth logout` |
| gh | subcommand decides; `gh api` is a GET unless `-f`/`-F`/`--input`/`-X` is given | `pr create`/`pr merge`, `issue`, `release`, `run rerun`, `secret set`, `auth login` (writes `hosts.yml`); ★`repo delete`, ★`release delete`, ★`cache delete`, ★`secret delete` |
| bd | `list`, `show`, `query`, `status`, `count`, `graph`, `history`, `stale`, `lint`; `--readonly` blocks writes | write verbs: `create`, `q`, `update`, `close`, ★`delete`, `comment`, `dep`, `label`; ★`init` also rewrites `AGENTS.md`; writes auto-commit by default |
| rtk | only-read proxies: `ls`, `tree`, `read`, `json`, `deps`, `env`, `diff` | **it is a proxy that runs the real command**: `test`, `err`, `git`, `gh`, `docker` do whatever you passed them; `init` writes hook files |
| busybox | applet decides; R/M/M★ for all 236 are in `busybox-applets`. `busybox <applet>` only | ★`busybox --install -s DIR` (236 symlinks), ★`bb <mutating applet>` |
| agent-browser | `snapshot`, `get`, `read`, `vitals`, `console`, `errors` | `open`/`click`/`fill`/`type`/`eval` drive the live page; ★`screenshot` writes a file even with no path; `pdf`, `download`, `state save`, ★`close --all`; starts a background daemon |

## fd — files

`fd [opts] [pattern] [path...]` · regex by default, all entries with no pattern.

`-e EXT` · `-t f|d|l|x|e|s|p` type · `-d N` depth · `-H` hidden · `-I` no-ignore
`-L` follow links · `-g` glob pattern · `-s` case-sensitive · `-i` ignore case
`-a` absolute · `-0` NUL-separate · `-x CMD` run per result · `-X CMD` run once
`--exclude GLOB` · `--changed-within DUR`

```bash
fd -e ts . src               # pattern first: '.' = everything, then the path
fd -td -d 2                  # directories to depth 2 — the tree replacement
fd -H -I '\.env' -d 1        # hidden + ignored
fd -0 -e json | xargs -0 jq -r .name
fd -e sh -x shellcheck -f gcc # lint each match
```

`fd PATTERN PATH` — the first positional is the pattern, so a bare directory
name becomes a search term. Pass `.` to match everything in a path.

## rg — contents

`rg [opts] PATTERN [path...]`

`-i` ignore case · `-S` smart case · `-w` word · `-F` fixed string · `-n` line no
`-c` count · `-l` names only · `-o` match only · `-A/-B/-C N` context
`-t TYPE` · `-g GLOB` · `--hidden` · `-u` unrestrict (repeatable) · `-U` multiline
Skips hidden and `.gitignore`d files by default: use `--hidden -I` (or `-uu`) when a
search must see everything, or results silently go missing.
`-r REPL` · `-z` inside .gz · `--json` · `--stats` · `--files` · `--type-list`

```bash
rg -n -C2 'TODO' src
rg -l -t ts 'deprecated'
rg -F -f patterns.txt          # patterns from a file
rg --json 'x' | jq -r 'select(.type=="match") | .data.path.text' | sort -u
```

## bat — view

`bat [opts] FILE...` · always add `--paging=never` here; stdout is not a TTY.

`-p` plain · `-pp` plain + no paging · `-n` numbers · `-A` non-printing chars
`-r A:B` line range · `-H/--highlight-line N:M` highlight lines · `--diff` git diff
`-l LANG` · `--style plain,numbers,header,grid,changes` (header = filename)
`--decorations=always` — required, or style is dropped when stdout is a pipe

```bash
bat --paging=never -r 40:80 src/app.ts
bat --paging=never --diff --diff-context 3 src/app.ts   # vs git index
bat --paging=never --decorations=always --style header,numbers src/app.ts
```

`-H` is `--highlight-line`, not a filename header — use `--style header` for that.

## just — task runner

`just [opts] [recipe] [args...]`

`-l` list recipes · `--summary` names only · `-s RECIPE` show recipe source
`-n` dry run · `-f FILE` · `-d DIR` · `--set VAR VAL` · `--choose` picker

```bash
just -l                       # discover before assuming
just -s build                 # read what a recipe does
just test -- --nocapture      # args after -- reach the recipe
just -n deploy                # dry run
```

## gron — JSON to greppable

`gron [opts] [file|URL|-]`

`-u` reverse (assignments → JSON) · `-v` values only · `-s` stream JSONL
`-j` JSON stream · `-m` monochrome · `--no-sort` · `-k` skip TLS verify

```bash
gron data.json | rg 'users'
gron data.json | gron -v | rg -c .    # -v reads assignments, so pipe into it
gron -u out.gron > restored.json
```

`-v` filters *assignments* on stdin; it does not read a JSON file on its own.

## shellcheck — shell lint, advisory

`shellcheck [opts] FILES`

`-f checkstyle|diff|gcc|json|json1|quiet|tty` · `-e CODES` exclude
`-i CODES` include only · `-S error|warning|info|style` · `-s sh|bash|dash|ksh|busybox`
`-x` follow sources · `-a` include sourced warnings · `-o all` optional checks
`-P PATH` source path · `--norc` · `--rcfile FILE`

```bash
shellcheck -f gcc -S warning scripts/*.sh
shellcheck -s bash -e SC1091 -f json1 script.sh
```

Never use `-f diff` to rewrite: report findings and let the user decide.

## ast-grep — structural search and rewrite

`ast-grep run -p 'PATTERN' -l LANG [paths]` · `$VAR` = one node, `$$$` = many.

`-p/--pattern` · `-l/--lang` · `-r/--rewrite` · `-A/-B/-C N` context · `-i` interact
`--json[=STYLE]` · `--globs GLOB` (there is no `-g`) · `-A/--after N` · `-B/--before N`
`--strictness cst|smart|ast|relaxed|signature|template` · `--selector KIND`

Subcommands: `run` · `scan` (rule files) · `test` · `outline` · `lsp` · `new`

```bash
ast-grep run -p 'console.log($A)' -l ts src            # preview first
ast-grep run -p 'console.log($A)' -l ts -r 'logger.info($A)' src
ast-grep run -p 'if ($C) { $$$B }' -l go               # multi-statement body
ast-grep outline src/app.ts                            # symbols, imports, members
```

Preview without `-r`, then add `-r`. Never regex a codebase you intend to edit.

The archive also installs `sg`, a deprecated alias that **execs `ast-grep`**: it
only works while `ast-grep` is present and runnable. Use `ast-grep` in new
commands. `sg` shadows util-linux's `/usr/bin/sg` on Linux; delete
`<agent dir>/bin/sg` if you need the system one.

## ninja — build

`ninja [opts] [targets...]` · no target builds `default`.

`-C DIR` · `-f FILE` (default `build.ninja`) · `-j N` · `-k N` · `-l N` load avg
`-n` dry run · `-v` verbose · `--quiet` · `-t TOOL` subtool · `-d MODE` · `-w FLAG`

Subtools: `-t targets` · `-t commands` · `-t query TARGET` · `-t graph`
`-t compdb RULES` · `-t clean` · `-t list`

```bash
ninja -t targets all | head
ninja -n -v                   # dry run before a real build
ninja -C build -j8
ninja -t compdb cc cxx > compile_commands.json
```

`-t` ends option parsing; later flags belong to the subtool.

## prek — git hooks (pre-commit compatible, Rust)

`prek [opts] [HOOK|PROJECT]... [COMMAND]`

Commands: `run` · `install` · `list` · `init` · `update` · `prepare-hooks`
`uninstall` · `validate-config` · `validate-manifest` · `cache` · `try-repo` · `exec`

`-a/--all-files` · `--files PATH...` · `--files0-from FILE` · `--last-commit`
`--skip HOOK` · `--stage STAGE` · `-v`

```bash
prek list                     # configured hooks
prek run --all-files
prek run ruff --files src/x.py
```

`install` writes `.git/hooks` — confirm with the user before running it.

## rtk — compress output before it reaches context

`rtk <subcommand> [args]` → runs the real tool, returns condensed output.

`ls` · `tree` · `read` · `smart` · `git` · `gh` · `glab` · `aws` · `psql` · `pnpm`
`err CMD...` · `test CMD...` · `json` · `deps` · `env` · `find` · `diff`

```bash
rtk test cargo test           # failures only
rtk err npm run build         # errors and warnings only
rtk git diff                  # changed lines only
rtk json data.json --keys-only
rtk find -name '*.ts'
```

Use it when output is noisy and you only need the verdict. When you need exact
bytes to edit or diff, run the command plainly.

## jq — JSON

`jq [opts] FILTER [file...]` · input from stdin or files.

`-r` raw output (no quotes) · `-c` compact · `-e` exit status from filter · `-s` slurp
`-n` null input · `-j` join without newlines · `-S` sort keys · `-f FILE` filter file
`--arg k v` string var · `--argjson k v` JSON var · `--slurpfile` · `-C` colour · `-M` monochrome

```bash
jq -r '.items[].name' data.json
jq -c 'select(.level == "error")' log.jsonl
jq -e '.ok' <<< '{"ok":true}' >/dev/null && echo pass
jq -S --arg n "$USER" '. + {user: $n}' in.json
```

`-r` is the difference between usable and quoted output in a pipeline. Prefer `gron`
for exploring an unknown document and `jq` for a filter you already know.

## yq — YAML/JSON/XML

`yq [opts] EXPRESSION [file...]` · **mikefarah/yq v4** (Go). kislyuk/yq is a
different Python tool with different flags; do not mix their syntax.

`-r` raw · `-o json|yaml|props|xml|csv|tsv` output format · `-i` in place
`-e` exit status · `-N` no doc separator · `-P` pretty print · `-I N` indent
`env(NAME)`/`strenv(NAME)` read the environment (there is no `--arg`) · `-n` null input

```bash
yq '.services.web.image' compose.yaml
yq -o json '.spec' k8s.yaml | jq .replicas
yq -i '.version = "2"' chart/Chart.yaml
yq -r '.users[].email' users.yaml
```

`-i` writes the file: print first, then re-run with `-i`.

## fzf — fuzzy select

`fzf [opts]` · **needs a TTY for interactive use**, which pi's bash does not provide.
Interactive selection fails; filtering does not.

`--filter TEXT` non-interactive match · `-f` alias · `--select-1` · `--exit-0`
`-1/--first` · `-n` field index · `--delimiter` · `-q` query · `--height` · `--preview`

```bash
fd -e ts | fzf --filter auth          # works without a TTY
fd -e ts | fzf --filter auth -1        # best single match
rg -l TODO | fzf --filter '' --select-1
```

There is no pipe-friendly interactive mode: use `--filter` to narrow, or ask the user.

## uv — Python packaging

`uv <cmd>` · also installs `uvx` (run a tool without installing it globally).

`uv run` · `uvx` · `uv pip install|sync|compile` · `uv venv` · `uv add|remove`
`uv lock` · `uv sync --frozen` · `uv python install|pin` · `uv tool install`

```bash
uv run pytest -q                     # project env, no activation
uvx ruff check .                     # ephemeral tool run
uv sync --frozen                     # exactly the lockfile
uv pip compile requirements.in -o requirements.txt
```

`uv` creates Python toolchains and caches outside this bin directory. Prefer
`uv run <cmd>` so the project's own pinned version is used.

## gh — GitHub CLI

`gh <cmd>` · **credential-bearing**: it stores an OAuth token in `~/.config/gh/hosts.yml`.

`gh pr|issue|repo|run|release|api|search|auth` · `--json FIELDS` · `-q JQ`
`gh api` for anything the porcelain lacks · `GH_TOKEN` overrides stored auth

```bash
gh pr list --json number,title --jq '.[].title'
gh run list --limit 5
gh api repos/{owner}/{repo}/pulls --jq '.[].title'
gh pr diff 123
```

`gh pr diff` is content you must read — do not pipe it through `rtk`.

## bd — issue tracker

`bd <cmd>` · gastownhall/beads, a Dolt-backed issue tracker stored in `.beads/`
in the current project. Dolt is embedded, so the single binary is enough.

Reading (safe): `list` · `show <id>` · `status` · `count` · `search TEXT` ·
`query <expr>` · `graph` · `children <id>` · `stale` · `lint` · `history <id>`

Writing: `create` · `q` (quick capture, prints only the ID) · `update` ·
`close` · `reopen` · `comment` · `note` · `dep` · `label` · `priority` · `assign`

Sync: `bd dolt push` / `bd dolt pull`

```bash
bd list --status open
bd show bd-42
bd q "login button does nothing on safari"    # prints just the new ID
bd query 'status=open priority>2'
bd graph
bd comment bd-42 --body "reproduced on main"
```

**`bd init` mutates the project.** It creates `.beads/` with a Dolt database,
**rewrites `AGENTS.md` by default**, and installs editor/agent integration files
unless given `--skip-agents` or `--stealth`. `bd setup <tool>` writes those
integration files too (`--global` writes into your home directory). Ask before
running either; prefer the read-only commands otherwise.

Not present: there is no `.beads/` until someone runs `bd init`, so an empty
`bd list` usually means "not initialised", not "no issues".

`bd` sends **anonymous usage metrics by default** (command names, version, OS —
not issues, paths or identities). Set `DO_NOT_TRACK=1` to disable it; that is the
user's call, not something to set for them.

## agent-browser — browser automation

`agent-browser <command>` — drives a real browser through a **daemon**, so the
page survives between separate invocations.

`open <url>` · `read [url]` · `snapshot` (accessibility tree with `@eN` refs) ·
`click @eN` · `fill @eN TEXT` · `type` · `press KEY` · `wait <sel|ms>` ·
`screenshot [path]` · `pdf <path>` · `eval <js>` · `close [--all]`
`get text|html|value|attr <name>|title|url|count|box|styles`
`--session NAME` · `--restore` · `session id|info` · `--profile Default` ·
`connect <port|url>` (CDP) · `chat "..."`

```bash
agent-browser open example.com && agent-browser snapshot -i
agent-browser fill @e1 "user@example.com" && agent-browser click @e2
agent-browser read https://example.com
agent-browser screenshot /tmp/shot.png
```

Snapshot first, then act on the `@eN` refs it returns — do not guess selectors.

Three things this build does not give you: it needs a local Chrome/Chromium (or an
existing browser via `connect`), it leaves a daemon running (stop it with
`close --all`), and **`agent-browser skills get core` fails** — the release binary
ships no skills directory despite what `--help` says. No win32-arm64 build.

## ruff — Python lint and format

`ruff check [paths]` · `ruff format [paths]`

`--select CODE` · `--ignore CODE` · `--fix` · `--diff` (preview) · `--unsafe-fixes`
`--output-format concise|json|github|gitlab|junit|sarif` · `--statistics` ·
`--no-cache` · `--line-length N` · `--check` (format only)

```bash
ruff check --statistics .
ruff check --diff --fix .          # preview the fix, change nothing
ruff format --check .
ruff check --select E,F --output-format json .
```

Most repositories pin ruff in their own environment. Prefer `uv run ruff ...` so
the pinned version decides the rules; use the managed copy for a quick check
outside a project environment, and never let it rewrite files the project's own
version would format differently.

## mise — dev tool and task runner

`mise <cmd>` — installs toolchains and runs project tasks. It is a **version
manager**, and pi's `bash` never sources rc files, so `mise activate` is inert
here: use `mise exec` instead.

`mise exec -- CMD` (alias `x`) · `mise run TASK` · `mise ls` · `mise current` ·
`mise env` · `mise install` · `mise use` · `mise trust` · `mise doctor` ·
`mise bin-paths` · `mise tasks`

```bash
mise exec -- node --version
mise run test
mise ls --current
mise doctor
```

Ask before `mise install`, `mise use` or `mise trust`: they write `mise.toml` and
install toolchains under `~/.local/share/mise`, outside this bin directory.
`mise exec --` is the only form that reliably picks up a project's pins from here.

## scc — lines of code

`scc [flags] [paths...]` · ignores vendor/generated files by default.

`-f/--format tabular|wide|json|json2|csv|sql|html|openmetrics` · `--by-file` ·
`-i/--include-ext` · `-x/--exclude-ext` · `--exclude-dir` · `--no-gen` ·
`-c/--no-complexity` · `--no-cocomo`

```bash
scc .
scc --by-file -f csv . | head
scc -i go,ts --no-gen .
```

## duckdb — SQL over files

`duckdb [OPTIONS] [FILENAME] [SQL]` · no filename means an in-memory database, and
CSV/Parquet/JSON are queryable directly by path.

`-c COMMAND` run and exit · `-csv` · `-json` · `-jsonlines` · `-header` · `-f FILE` ·
`-no-agent` · dot-commands via `.help`

```bash
duckdb -c "select 1"
duckdb -csv -no-agent -c "select * from 'data.csv' limit 5"
duckdb -json -c "select count(*) n from read_parquet('x.parquet')"
duckdb -c "create table t as select * from 'a.csv'; select count(*) from t"
```

Agent mode prints a banner before every result when `AI_AGENT` is set and stdout is
not a terminal — i.e. always here — so pass `-no-agent` (or `DUCKDB_AGENT_MODE=0`)
when the banner would pollute the output.

## miller — CSV, TSV and JSON

`mlr [flags] [verb] [verb options] [files...]` · with no verb it behaves like `cat`;
chain verbs with `then`.

`--csv` · `--tsv` · `--json` · `--icsv`/`--ojson` · `--c2j` · `-N` no header ·
verbs: `cut` `filter` `put` `sort` `join` `stats1` `count-distinct` `nest`
`flatten` `head` `tail`

```bash
mlr --csv cut -f name,email users.csv
mlr --c2j cat data.csv
mlr --csv filter '$qty > 10' then sort -f sku data.csv
mlr --csv stats1 -a mean -f price sales.csv
```

## sd — find and replace

`sd [OPTIONS] <FIND> <REPLACE_WITH> [FILES]...` · regex by default ·
**rewrites files in place**; with no files it filters stdin to stdout.

`-p/--preview` · `-F/--fixed-strings` · `-n/--max-replacements N` · `-f/--flags` ·
`-A/--across`

```bash
sd -p '\d+' 'N' file.txt        # preview, changes nothing
sd 'foo' 'bar' src/*.ts         # rewrites in place
sd -F 'a.b' 'a-b' file.txt      # literal, not regex
echo 'x=1' | sd 'x' 'y'
```

Always preview with `-p` first: without it the matched files are rewritten.

## busybox — 236 applets in one binary

`busybox <applet> [args]` · v1.39.0, statically linked. Dispatches on **argv[0]**, so
the installed file must stay named `busybox`.

```bash
busybox --list                 # all 236 applet names
busybox hexdump -C file.bin
busybox sha256sum file
busybox unzip archive.zip
busybox date -u +%FT%TZ
```

Per-applet read-only vs mutating classification, including which flags cause a
write, is in the `busybox-applets` skill — load it before running any applet that
is not obviously an inspection command.

**Do not run `busybox --install -s <dir>`.** In pi's bin directory (first on `PATH`)
it would put 236 applets ahead of the real coreutils, and busybox `sed`, `grep`,
`find`, `tar` and `awk` are not GNU-compatible. Prefer this package's dedicated
tools (`rg`, `fd`, `bat`, `jq`, `scc`, `difft`) and use busybox for what nothing
else covers: `hexdump`, `xxd`, `unzip`, `gzip`, `patch`, `cpio`, `dpkg-deb`,
`sha*sum`, `date`, `hostname`.

## difftastic — structural diffs

`difft [OPTIONS] OLD-PATH NEW-PATH` · compares syntax trees; unknown languages fall
back to line diffs.

`--display inline|side-by-side|json` · `--color WHEN` · `--background dark|light` ·
`-c/--context N` · `--skip-unchanged` · `--check-only` · `--list-languages` ·
`--byte-limit N`

```bash
difft old.ts new.ts
difft --display inline --color never a.go b.go
difft --check-only a.py b.py
```
