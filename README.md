# pi-managed-tools

Pi ships no `fd` and no `rg` binary. It downloads exactly two static binaries on
demand, into the directory it searches first, and uses them for two built-in
tools:

| Tool | From | Used by | Installed to |
|---|---|---|---|
| `fd` | [sharkdp/fd](https://github.com/sharkdp/fd) | the `find` tool | `<agent dir>/bin/fd` (`fd.exe` on Windows) |
| `rg` (ripgrep) | [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep) | the `grep` tool | `<agent dir>/bin/rg` (`rg.exe` on Windows) |
| `bat` | [sharkdp/bat](https://github.com/sharkdp/bat) | `bash` only | `<agent dir>/bin/bat` |
| `prek` | [j178/prek](https://github.com/j178/prek) | `bash` only | `<agent dir>/bin/prek` |
| `rtk` | [rtk-ai/rtk](https://github.com/rtk-ai/rtk) `rtk-oss-*` build (Apache-2.0) | `bash` only | `<agent dir>/bin/rtk` |
| `just` | [casey/just](https://github.com/casey/just) | `bash` only | `<agent dir>/bin/just` |
| `gron` | [tomnomnom/gron](https://github.com/tomnomnom/gron) | `bash` only | `<agent dir>/bin/gron` |
| `shellcheck` | [koalaman/shellcheck](https://github.com/koalaman/shellcheck) | `bash` only | `<agent dir>/bin/shellcheck` |
| `ast-grep` | [ast-grep/ast-grep](https://github.com/ast-grep/ast-grep) | `bash` only | `<agent dir>/bin/ast-grep` and `sg` |
| `ninja` | [ninja-build/ninja](https://github.com/ninja-build/ninja) | `bash` only | `<agent dir>/bin/ninja` |
| `jq` | [jqlang/jq](https://github.com/jqlang/jq) | `bash` only | `<agent dir>/bin/jq` |
| `yq` | [mikefarah/yq](https://github.com/mikefarah/yq) (v4, Go) | `bash` only | `<agent dir>/bin/yq` |
| `fzf` | [junegunn/fzf](https://github.com/junegunn/fzf) | `bash` only | `<agent dir>/bin/fzf` |
| `uv` | [astral-sh/uv](https://github.com/astral-sh/uv) | `bash` only | `<agent dir>/bin/uv` and `uvx` |
| `gh` | [cli/cli](https://github.com/cli/cli) | `bash` only | `<agent dir>/bin/gh` |
| `bd` | [gastownhall/beads](https://github.com/gastownhall/beads) | `bash` only | `<agent dir>/bin/bd` |
| `agent-browser` | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | `bash` only | `<agent dir>/bin/agent-browser` |
| `ruff` | [astral-sh/ruff](https://github.com/astral-sh/ruff) | `bash` only | `<agent dir>/bin/ruff` |
| `mise` | [jdx/mise](https://github.com/jdx/mise) | `bash` only | `<agent dir>/bin/mise` |
| `scc` | [boyter/scc](https://github.com/boyter/scc) | `bash` only | `<agent dir>/bin/scc` |
| `duckdb` | [duckdb/duckdb](https://github.com/duckdb/duckdb) | `bash` only | `<agent dir>/bin/duckdb` |
| `miller` | [johnkerl/miller](https://github.com/johnkerl/miller) | `bash` only | `<agent dir>/bin/mlr` |
| `sd` | [chmln/sd](https://github.com/chmln/sd) | `bash` only | `<agent dir>/bin/sd` |
| `difftastic` | [Wilfred/difftastic](https://github.com/Wilfred/difftastic) | `bash` only | `<agent dir>/bin/difft` |
| `busybox` | [rob-c/busybox-static](https://github.com/rob-c/busybox-static) | `bash` only | `<agent dir>/bin/busybox` (236 applets) |

That download logic lives in `dist/utils/tools-manager.js` of
`@earendil-works/pi-coding-agent`: `ensureTool()` downloads the latest release
**only when the file is missing**, and `getToolPath()` prefers `<agent dir>/bin`
over anything on `PATH`. So a machine that installed pi a year ago keeps
whatever `fd`/`rg` release it fetched then, however many newer releases exist.

This package fills that gap. On a session start (at most once per interval) it
resolves the latest release of each project, compares it with the managed copy,
and replaces the copy in place — the same path pi already uses. pi's `find` and
`grep` tools call `getToolPath()` for every run, and pi puts `<agent dir>/bin`
first on the `PATH` of every `bash` command it runs, so both see the new binary
immediately.

Note that `find` and `grep` are not enabled by default: pi's `defaultTools` is
`read`, `bash`, `edit`, `write`. Turn them on with `pi --tools +grep,+find` or
`"defaultTools": ["+grep", "+find"]` in settings (see `docs/settings.md`
inside the pi package). The binaries and the update are the same either way —
pi's interactive mode prepares them at startup regardless of which tools are
enabled.

**Only `fd` and `rg` back a pi built-in tool.** Everything else is installed so
`bash` commands can use it, and `/managed-tools` reports that distinction rather
than implying otherwise.

### `tree` is not here

Upstream (`Old-Man-Programmer/tree`) publishes git tags but **no release
assets**, so there is no binary to download and nothing to verify. `fd -d 2 -td`
covers most of what `tree` is used for, from a binary this package already
manages.

### Command shadowing

pi searches `<agent dir>/bin` first, so these win over anything else on `PATH`.
That is intended for `fd`/`rg`/`bat`. Two cases are worth knowing:

- `ast-grep` also installs its deprecated `sg` shim, which shadows util-linux's
  `/usr/bin/sg` on Linux (the group-switching helper used by `newgrp`). Delete
  `<agent dir>/bin/sg` if you need the system one.
- `git`, `python3`, `node`, `tree` and the rest of the toolchain still come from
  the system. Nothing here replaces an *interpreter* — their versions belong to
  each project's lockfile. `uv` is the one exception in spirit: it is a package
  manager, so it creates its own Python toolchains and caches outside this bin
  directory. Prefer `uv run <cmd>` so the project's pinned version is used.
- `yq` here is **mikefarah/yq v4** (Go). `kislyuk/yq` is a different tool with
  different flags and no releases of this shape.
- `gh` is **credential-bearing**: it keeps an OAuth token in
  `~/.config/gh/hosts.yml`. Its downloads are digest-verified like every other
  tool, but auto-updating a binary that holds a token is a trust decision worth
  making deliberately.
- `fzf` needs a TTY for interactive use, and pi's `bash` tool does not provide
  one. `fzf --filter` works; the interactive picker does not.
- **`bd init` mutates the project.** It creates `.beads/` with an embedded Dolt
  database, **rewrites `AGENTS.md` by default**, and installs editor/agent
  integration files unless given `--skip-agents` or `--stealth`. `bd setup <tool>`
  writes those integration files too. The read-only commands (`list`, `show`,
  `status`, `query`) are safe.
- **`bd` sends anonymous usage metrics by default** — command names, version and
  OS platform, not issues or paths. Set `DO_NOT_TRACK=1` to disable it. That is
  the user's decision, so this package does not set it for you.
- **`agent-browser` needs a browser and leaves a daemon running.** It drives a
  local Chrome/Chromium (or an existing one via `connect`), keeps state across
  invocations through a background daemon, and `close --all` stops it. Its own
  `agent-browser skills get core` **fails** on this build — the release binary
  ships no skills directory, whatever `--help` claims. No win32-arm64 release.
- **`mise` is a version manager.** A managed copy sits ahead of whatever the user
  installed, and its `activate` shell hook never runs in pi's `bash`, so only
  `mise exec -- <cmd>` reliably picks up a project's pins. It installs toolchains
  under `~/.local/share/mise`, outside this bin directory. This is the one entry
  here that deliberately manages a tool whose job is managing other versions.
- **`busybox` is a multicall binary** that dispatches on `argv[0]`, so it is only
  installed under the name `busybox` — renaming or copying it breaks every applet.
  Use it as `busybox <applet>`. **Never run `busybox --install -s <dir>`**: in pi's
  bin directory, which is first on `PATH`, that would put 236 applets ahead of the
  real coreutils, and busybox `sed`/`grep`/`find`/`tar` are not GNU-compatible.
  Per-applet read-only vs mutating classification is in the `busybox-applets` skill.
- **`sd` rewrites files in place.** With no file arguments it filters stdin to
  stdout, but `sd FIND REPLACE file...` edits those files. Use `-p` to preview.
  Its release binary also reports `sd 1.0.0` for tag `v1.1.0`; the tag is trusted
  for version comparison (the digest already proves the asset), so it does not
  reinstall in a loop.
- **`duckdb` prints an agent-mode banner** before every result when `AI_AGENT` is
  set and stdout is not a terminal — which is always true inside pi. Pass
  `-no-agent` (or set `DUCKDB_AGENT_MODE=0`).
- **`ruff` is normally pinned by the project.** Prefer `uv run ruff ...` so the
  version CI uses decides the rules; the managed copy is for a check outside a
  project environment, and should never rewrite files the project's own version
  would format differently.

## Skills

The package ships two skills:

## How it integrates with pi

Three surfaces, in order of how reliably they reach the model:

1. **`tool_call`** (deterministic) — an absolute host path for a managed binary is
   rewritten to its bare name before the command runs, so `/usr/bin/jq -r .a`
   executes as `jq -r .a` and the packaged build runs. Only command-position tokens
   are touched and only names this package manages. `PI_MANAGED_TOOLS_REWRITE=off`
   turns it off.
2. **`before_agent_start`** (deterministic) — the two environment rules are appended
   to `systemPromptOptions.promptGuidelines`, and a `managed_tools_environment`
   section states the facts outright: that the bin directory is first on `PATH`,
   which packaged versions that means, and that no probing turn is needed.
   Idempotent, and the section text is stable so pi does not re-patch it each turn.
3. **Skills** (opportunistic) — name, description and path are always in the system
   prompt; the body loads only when the model decides it is relevant, which it does
   not do for one-liners.

`/managed-tools status` reports how many absolute paths were rewritten this session.

The always-on skill also pins two environment rules, because both are silent when
broken: call the packaged binaries by **bare name** (an absolute path like
`/usr/bin/jq` bypasses pi's `PATH` prepend and `getToolPath()`), and run multi-step
shell logic through **`busybox sh -c '…'`** so the shell does not depend on which
bash the host resolved. `busybox sh` covers `[[ ]]`, `<(…)`, `<<<`, `$'…'`, `local`
and `pipefail`, but not arrays, `${v^^}`, `read -a`, `mapfile` or `coproc`.

- **`managed-tools`** — always advertised. pi adds every skill's *name and
description* to the system prompt and nothing else, so this description is the
advert: it sets the preference order (rtk first, then these binaries over the
system ones), names all twenty-five tools, and routes to the reference for flags.
- **`busybox-applets`** — loaded on demand, only when busybox is in play. All 236
  applets classified read-only / mutating / destructive / exec, with the flags that
  cause a write.
- **`managed-tools-reference`** — loaded on demand. The exact flag set and one
  or two worked examples per tool, transcribed from the binaries this package
  installs rather than from upstream docs, because the versions are pinned.

Both skills are explicit about the trap in `rtk`: it summarises, so it is right
for "did it pass" (`rtk test`, `rtk err`, `rtk deps`) and wrong for "show me what
changed" — `rtk git diff` reduces a diff to a file list, and `rtk err` keeps
stderr while dropping stdout. The rule is stated as verdict-versus-content, with
plain commands as the fallback when unsure.

That pinning is the point: the tool surface is fully known at install time, so
the skills can state flag names instead of telling the model to run `--help` and
spend the tokens anyway. `tests/skills.test.ts` keeps them honest — adding a tool
without documenting it in both skills fails the suite, as does a description over
the Agent Skills 1024-character limit or a version list that disagrees between
the two files.

## Verification

Every archive is checked against the sha256 digest GitHub records for the
release asset, **before** it is extracted. That digest is computed by GitHub at
upload time, so it does not depend on the project publishing sidecar checksums —
`fd` and `bat` publish none at all. It also means a compromised release page
cannot pass by replacing a binary and its `.sha256` sidecar together.

Verification is **fail-closed**:

- a digest mismatch fails the install and keeps the previous binary;
- a release API that cannot be reached fails the install rather than guessing;
- an asset published without a digest fails the install.

The single opt-out is `PI_MANAGED_TOOLS_ALLOW_UNVERIFIED=1`, which installs the
archive and records its digest anyway. Such an install is reported as
`UNVERIFIED` rather than `verified`, including in the TUI update line.

Digests are read from `api.github.com`, whose anonymous quota is 60 requests per
hour **per IP** and shared with everything else on the host. A verification only
runs when an update is actually downloaded, so a normal cycle costs one request
per outdated tool. If the quota is exhausted, installs fail closed with a
message saying so; set `GITHUB_TOKEN` (or `GH_TOKEN`) to raise the limit. The
installed binaries are never damaged by a failed verification.

After the swap the installed binary is **executed** and its version read back. A
binary that cannot run — wrong architecture, glibc against a musl build, a
truncated download — is rolled back to the previous copy and reported as a
failure. Reporting the version that was requested instead would claim success
for a dead file.

Installs land through a staged file on the same filesystem, so a failed download
or extraction never leaves a partial binary where pi expects a working one. On
POSIX the final rename replaces the old inode atomically, so a running pi keeps
working.

## Install

```bash
pi install /path/to/pi-managed-tools
pi list                      # shows the package
```

Then in a session:

```text
/managed-tools                       # status: versions, path, and any damaged binary
/managed-tools update                # download the latest releases now
/managed-tools reinstall             # replace every managed binary that cannot run
/managed-tools reinstall bat         # force one tool to be re-downloaded
```

The model can do the same through the `managed_tools` tool (`action: "status"`,
optionally `check_latest: false` to stay offline; `action: "update"`; or
`action: "reinstall"` with an optional `tool`).

### Repairing a damaged binary

A managed binary can be broken without looking broken: truncated by a killed
download, left behind by a disk error, or copied from another architecture. A
version check misses all three, because the file is still at the expected path.
`status` therefore *executes* each managed binary and flags any that fail to run:

```text
bat: installed 0.26.1 - DAMAGED (present but does not execute); run reinstall
```

`/managed-tools reinstall` with no argument replaces only those. Naming a tool
forces a fresh download even when the version already matches upstream, which is
what you want when the file is wrong in a way that still reports a version.

Bundled shims are covered. `ast-grep`'s archive also installs `sg`, a deprecated
alias that is a small binary which **execs `ast-grep`** — so it dies the moment
its sibling is missing or unreadable. `status` probes every name an archive
provides and names the broken one:

```text
ast-grep: installed 0.51.3 - DAMAGED (sg does not execute); run reinstall
```

`/managed-tools reinstall sg` resolves to `ast-grep`, because that archive is
where `sg` comes from, and reinstalls the bundle.

An install is atomic per archive: every target is backed up, swapped, then
probed, and any failure restores all of them. A broken shim in a release can
never leave a new primary beside a dead one.

A repair still verifies the archive digest, still rolls back if the new binary
will not run, and falls back to the version already on disk when the release
lookup fails — so it works with a broken network, which is when a repair is most
likely to be needed.

To remove it: `pi remove /path/to/pi-managed-tools`.

To use the same binaries in your own shell (pi only adds them to the `PATH` of
its own `bash` tool):

```bash
export PATH="$HOME/.pi/agent/bin:$PATH"     # add to ~/.zshrc or ~/.bashrc
```

Because pi searches that directory first, a managed copy **shadows** a copy you
installed yourself with Homebrew, cargo, `uv`, or a version manager. That is the
point for `fd`/`rg`/`bat`; if you deliberately pin `prek` or `rtk` to a specific
version, check `/managed-tools` before assuming which binary ran.

## What a session start does

1. A managed binary is missing, or the last check is older than the interval:
   resolve `https://github.com/<repo>/releases/latest` (the redirect, not the
   rate-limited API; the API is only a fallback).
2. Each binary whose installed version is older — or absent — is downloaded,
   verified against GitHub's digest, extracted and renamed into place. The
   archive is fetched and unpacked inside the bin directory so the final rename
   stays on one filesystem and cannot leave a truncated binary where pi expects
   a working one.
3. The result is recorded in `<agent dir>/bin/.pi-managed-tools.json`, which is
   what the interval is measured against.
4. Otherwise nothing happens and no network request is made.

Status lines are shown in the TUI only when something changed. Print mode
(`pi -p`) still updates, silently.

A tool with no release for the current platform is skipped and does **not**
force a check on every start. `rtk` publishes no `aarch64-pc-windows-msvc`
archive, so on Windows on ARM it is reported as unsupported while the other 20
keep working. `sd` has no Windows arm64 build either, `busybox` has no Windows
build at all, and `difftastic` uses the gnu Linux build because it publishes no
linux-arm64 musl asset.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PI_MANAGED_TOOLS` | on | `off`/`0`/`false` disables the startup check (the `/managed-tools update` command and `managed_tools` tool still work) |
| `PI_MANAGED_TOOLS_INTERVAL_HOURS` | `12` | Minimum hours between startup checks; `0` checks every start |
| `PI_MANAGED_TOOLS_ALLOW_UNVERIFIED` | unset | `1`/`true`/`yes` installs an archive whose digest cannot be confirmed |
| `PI_MANAGED_TOOLS_REWRITE` | on | `off`/`0`/`false` disables rewriting absolute tool paths in bash tool calls |
| `GITHUB_TOKEN` / `GH_TOKEN` | unset | Optional. Raises the 60/hour anonymous quota used to read release digests |
| `PI_OFFLINE` | unset | Same `1`/`true`/`yes` values pi itself honours; disables startup checks |

## Platform support

Downloads match what pi would have fetched itself:

| Platform | Archive |
|---|---|
| macOS (arm64 / x64) | `…-apple-darwin.tar.gz` |
| Linux (arm64 / x64, musl) | `…-unknown-linux-musl.tar.gz` |
| Windows (arm64 / x64) | `…-pc-windows-msvc.zip` |

Other architectures are left alone: these projects publish no matching prebuilt
binary and pi does not guess one either. Three of the projects deviate from the
Rust triple convention and are handled per tool:

| Tool | Asset scheme | Notable gaps |
|---|---|---|
| `rtk` | `rtk-oss-<rust triple>` | no Windows arm64 |
| `gron` | `gron-<os>-<go arch>-<version>.tgz` (`.zip` on Windows) | no 32-bit arm |
| `shellcheck` | `shellcheck-v<ver>.<os>.<arch>.tar.gz` | one arch-less `.zip` for Windows x64 only |
| `ast-grep` | `app-<rust triple>.zip` (zip on every platform) | none |
| `just` | `just-<ver>-<rust triple>` | none |
| `ninja` | `ninja-mac.zip` / `ninja-linux.zip` / `ninja-linux-aarch64.zip` / `ninja-win.zip` / `ninja-winarm64.zip` | none; the macOS asset is universal2, so one file covers x86_64 and arm64 |
| `jq` | bare executable: `jq-macos-arm64`, `jq-linux-amd64` | no archive at all — the download is the binary |
| `yq` | bare executable: `yq_darwin_arm64`, `yq_linux_amd64` | no archive at all |
| `fzf` | `fzf-<ver>-darwin_arm64.tar.gz` (`.zip` on Windows) | none |
| `uv` | `uv-<rust triple>.tar.gz` / `.zip` | archive also contains `uvx` |
| `gh` | `gh_<ver>_linux_amd64.tar.gz`, `gh_<ver>_macOS_arm64.zip` | macOS ships a **zip**, Linux a tar.gz |
| `bd` | `beads_<ver>_darwin_arm64.tar.gz` | assets are named after the project, the binary is `bd`; Dolt is embedded |
| `agent-browser` | bare executable `agent-browser-darwin-arm64` | `x64` not `amd64`; **no win32-arm64** |
| `ruff` | `ruff-<rust triple>` | bare version tags |
| `mise` | `mise-v<ver>-macos-arm64.tar.gz` | dated tags; binary nests at `mise/bin/mise` |
| `scc` | `scc_Darwin_arm64.tar.gz` | capitalised OS, underscore, no version |
| `duckdb` | `duckdb-cli-osx-arm64.tar.gz` | says `osx`/`amd64`; bare binary in the archive |
| `miller` | `miller-6.22.0-darwin-arm64.tar.gz` | installs `mlr`, not `miller` |
| `sd` | `sd-v1.1.0-aarch64-apple-darwin.tar.gz` | keeps the `v`; **binary reports 1.0.0 for tag 1.1.0** |
| `difftastic` | `difft-0.72.0-aarch64-apple-darwin.tar.gz` | installs `difft`; linux uses gnu |
| `busybox` | `busybox-static-1.39.0-aac079e-darwin-universal` | bare binary; one universal2 mac asset; **no Windows build** |

`gron`'s release build reports no version at all (`gron version dev`), so its
installed version is recorded in the state file rather than read back from the
binary.

`rtk` is installed from the **`rtk-oss-`** family. The plain `rtk-<target>`
release bundles a BUSL-1.1 engine (`LICENSE-ENGINE`); `rtk-oss-` is the
Apache-2.0-only build of the same tool, with the same binary name and version
banner. Nothing here is redistributed — the binary is fetched from GitHub on the
user's own machine — but the distinction is kept explicit so the default install
is not silently pulling a source-available component.

## Layout

```
package.json            pi manifest: loads src/extension.ts
src/extension.ts        session_start check, /managed-tools command, managed_tools tool
src/tools.ts            registry, release targets, digests, download/extract/install, cooldown
skills/managed-tools/           always-advertised short skill
skills/managed-tools-reference/ exact flags and examples per tool
tests/tools.test.ts     offline tests: fixtures are real archives served by a fake fetch
tests/extension.test.ts loads the extension against a stand-in pi and agent directory
tests/skills.test.ts    keeps the two skills in step with the tool registry
scripts/verify.sh       runs the installed plugin inside the pi on PATH
```

## Tests

```bash
npm test                # node --test; no network access
npm run typecheck       # tsc --noEmit
./scripts/verify.sh     # end-to-end inside the installed pi (needs a model key)
```

The suite builds real `tar.gz` release archives in a temp directory, serves them
through a stub `fetch` that also synthesises the release API response from the
same bytes, and asserts the installed binary runs, reports the expected version,
replaces the old copy, and leaves no archive or staging directory behind. The
stub computes real digests, so verification is exercised rather than bypassed:
a tampered asset, a missing digest, and a binary that exits without printing a
version are each asserted to fail without damaging the installed copy. A second
file loads the extension itself against a stand-in `pi` to check registration,
the command, the tool, and that a startup inside the check interval, or with
`PI_MANAGED_TOOLS=off`/`PI_OFFLINE`, makes no network request at all.

## Licence

GPL-2.0-only. See [LICENSE](LICENSE).

This is a deliberate choice: the plugin itself is copyleft, so anyone distributing a
modified version must publish their source under the same terms.

Two things it does not cover, both by design:

- **The binaries it downloads are not distributed here.** `shellcheck` (GPL-3.0) and
  `busybox` (GPL-2.0) among them are fetched from their own upstream releases onto
  the user's machine. Bundling any of them into this package would create a licence
  conflict, so don't.
- **pi itself is MIT** and is declared as a `peerDependency`, never bundled. Its own
  dependency tree contains Apache-2.0 packages, which is fine precisely because none
  of it ships in this tarball.
