# Changelog

## [0.15.0]

- Relicensed from MIT to **GPL-2.0-only**, before the first commit so no published
  version was ever MIT. Every package this project imports is MIT, which is why the
  relicence is permissible; Apache-2.0 in a direct dependency would have blocked it.
- Add `LICENSE` (GPLv2), SPDX headers in `src/tools.ts` and `src/extension.ts`, and
  `author`/`repository`/`homepage`/`bugs` in `package.json`.
- Stop publishing `tests/` and `scripts/` in the npm tarball; they stay in the repo.
- Add `.github/workflows/test.yml` (node 22 on ubuntu and macos) and a `.gitignore`
  covering `node_modules/`, `.pi/` and `.probe/`.

## [0.14.0]

- State the CLI environment in the system prompt instead of leaving the model to
  discover it. `before_agent_start` now adds a `managed_tools_environment` section:
  that `<agent dir>/bin` is first on `PATH`, which packaged versions that means
  (read from the state file, so no extra subprocesses), that bare names are correct,
  and that multi-step logic goes in `busybox sh -c '…'` — ending with "do not spend
  a turn probing it". The string is built once per process and is stable across
  turns; pi diffs sections, so a changing one would patch the prompt every turn.
- Measured with a treadmill of six graded prompts on two models: adoption was
  12/12 and fully consistent on both, but the model established the environment
  first on only **2 of 12** runs — it probed when asked to and dived straight in
  otherwise. Stating the facts up front removes the need for that turn.
- The treadmill also caught a scoring mistake worth recording: a run that used pi's
  built-in `grep` tool looked like a miss for `rg`, but that tool is backed by the
  managed `rg` through `getToolPath()`, so it is adoption.

## [0.13.0]

- Integrate with pi's extension API instead of relying on prompt text alone.
  **`before_agent_start`** now injects the two environment rules into
  `systemPromptOptions.promptGuidelines`, so they are in the system prompt of every
  turn rather than only when a skill happens to load — verified present in the JSON
  event stream. The injection is idempotent; duplicates would be paid for every turn.
- **`tool_call`** rewrites an absolute host path for a managed binary to its bare
  name before execution: `/usr/bin/jq -r .a` runs as `jq -r .a`. Only a token in
  command position is touched (so `echo "/usr/bin/jq"` is data) and only names this
  package manages (so `/usr/bin/tar` is untouched). `PI_MANAGED_TOOLS_REWRITE=off`
  disables it; `/managed-tools status` reports how many rewrites happened.
- Proven end to end: asked to run `/usr/bin/jq --version` verbatim, the session
  printed `jq-1.8.2` — the packaged build — not the host's `1.7.1-apple`.
- A treadmill of six graded prompts re-run twice each now reports 6/6 tasks
  consistent and zero absolute-path violations, up from 4/6 before the injection.

## [0.12.0]

- The always-on skill now pins two environment rules that were previously only
  implicit: use the packaged binaries by **bare name** (never `/usr/bin/jq` or
  `/opt/homebrew/bin/gh`, which bypasses both of pi's resolution mechanisms), and
  run multi-step shell logic as **`busybox sh -c '...'`** so the shell is the same
  static ash everywhere instead of whichever bash/zsh the host resolved.
- Document exactly where `busybox sh` stops: it supports `[[ ]]`, `<(…)`, `<<<`,
  `$'…'`, `local`, `pipefail`, `${v//a/b}` and `${v:1:2}`, but not arrays,
  `${v^^}`/`${v,,}`, `read -a`, `mapfile`, `coproc` or `extglob` — for those, drop
  the prefix and let pi's own shell run the command.
- Both rules were verified by measurement, not assumed. The shell clause appended at
  the end of the description did **not** fire (the model ran a bare `for` loop);
  moved into the middle of the description it did (`busybox sh -c '…'`), and a
  follow-up asking for a bash array correctly dropped the prefix instead of writing
  a shell that cannot run it.

## [0.11.1]

- Sharpen the always-on skill after measuring real model behaviour. Four adoption
  probes in an isolated pi profile showed the model used `scc`, `ast-grep`, `fd`
  and `bat` correctly once it had loaded the reference skill, but fell back to
  `python3 -c` and `awk` for small one-liners. The always-on text now names the
  tool for those shapes explicitly — `jq` to read or query JSON, `bat -n -r A:B`
  for a line range, `gron` to explore a document — and says the preference applies
  to one-liners, not just large tasks. Both failing probes now pass.

## [0.11.0]

- Add `busybox` from [rob-c/busybox-static](https://github.com/rob-c/busybox-static):
  upstream BusyBox built static, with one universal2 macOS asset covering both
  architectures and separate Linux amd64/arm64 builds. No Windows build exists.
- BusyBox dispatches on `argv[0]`, so it is installed strictly as `busybox` and used
  as `busybox <applet>`. Renaming it breaks every applet, and
  `busybox --install -s` is called out as forbidden: inside pi's bin directory it
  would put 236 applets ahead of the real coreutils.
- `busybox` reports `v1.39.0.git` while its tags carry the build commit
  (`v1.39.0-aac079e`), so it uses the `trustTagVersion` path added for `sd` — the
  recorded version stays at the tag and a rebuild still registers as an update.
- Add a third skill, `busybox-applets`: every one of the 236 applets classified
  **R** read-only, **M** writes, **M★** destructive/system-level, or **E** runs a
  program you name, with the flags that cause the write. Its roster is asserted in
  `tests/skills.test.ts`, which fails if an applet is dropped from the doc.

## [0.10.1]

- Add a read-only vs mutating map to `managed-tools-reference`: one row per tool
  listing what cannot change state, what mutates it, and which operations are
  destructive. Every entry was taken from the installed binary's own help output,
  and the dangerous ones were exercised: `sd` rewrites files with no flag,
  `ruff format` rewrites by default while `format --check` does not, `mlr tee`
  overwrites its target, `yq -i` touches only the first file, `scc --report=PATH`
  overwrites silently, `ast-grep` writes only with `-U`/`-i` (`scan` has no
  `--fix`), `duckdb FILE` creates a database, and `agent-browser screenshot` writes
  a file even with no path.
- The always-on skill now points at that map before any writing command, and lists
  the dry-run form for the tools that mutate with no flag at all.
- `tests/skills.test.ts` fails if a tool is added without a mutation-map row, or if
  a row loses its read-only or mutating statement.

## [0.10.0]

- Add `scc` (lines of code), `duckdb` (SQL over CSV/Parquet/JSON), `miller`
  (CSV/TSV/JSON transforms, installed as `mlr`), `sd` (find and replace) and
  `difftastic` (structural diffs, installed as `difft`). All five publish assets
  for darwin/linux arm64 and x64, and every emitted asset name was verified
  against the live releases before merging.
- Add `trustTagVersion` for a release whose binary reports a version that lags its
  tag: `sd` ships `sd 1.0.0` under tag `v1.1.0`. Without it the version
  comparison would read the stale build string, decide the tool was outdated, and
  re-download it on every check. The digest already proves the asset is the
  intended one, so the tag is trusted for comparison instead.
- `difftastic` resolves to the gnu Linux build because it publishes no
  linux-arm64 musl asset; `sd` has no Windows arm64 build.
- Document two behaviours worth knowing before use: `sd` edits files in place
  unless given `-p` for a preview, and `duckdb` prints an agent-mode banner on
  every result inside pi unless given `-no-agent`.

## [0.9.1]

Fixes from a full adversarial pass over v0.9.0.

- **Per-tool failure memory.** A tool that cannot install on this host kept its
  binary missing, and a missing binary forced a full update cycle on *every*
  start. Failures are now recorded in the state file and skipped until the
  interval elapses; a success clears them. A run where everything failed still
  records those failures without advancing `checkedAt`.
- **`gron` was permanently uninstallable.** Its release predates GitHub's
  per-asset digest field, so fail-closed verification refused it forever. Tools
  can now declare `digestOptional`, which installs and reports the result as
  **unverified** — and `gron` is the only tool with that exception.
- **`agent-browser` picked the glibc build on Linux.** `file` shows the plain
  asset needs `/lib64/ld-linux` while `linux-musl-*` is statically linked, so the
  static one is now selected and runs on glibc and musl both.
- **The all-failed guard was dead code.** The extension wrote state after
  `updateTools` had already persisted, undoing the guard and deferring the next
  attempt by a full interval. The redundant writes are gone, and a `status` call
  no longer stamps `checkedAt` just because someone looked.
- **Unverified installs are visible.** Digest and verification outcome are
  persisted, and the startup notice appends `(UNVERIFIED)` — previously the
  README claimed this and the code did not do it.
- A staging file is now registered before `chmod`, so a failing `chmod` cannot
  leave an executable behind in the PATH directory.
- Skill corrections, each verified against the installed binary: `jq -C`/`-M`
  were inverted; `bat` needs `--decorations=always` when piped or the style is
  dropped; `rg --json` emits `begin`/`end` records so the jq example produced
  nulls; `yq` v4 has no `--arg` (use `env()`); `rg` skips hidden and
  gitignored files by default, which is now stated.

## [0.9.0]

- Add `agent-browser` ([vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)),
  `ruff` and `mise`.
- `agent-browser` ships bare executables named `agent-browser-<os>-<arch>` with
  `x64` rather than `amd64`, and publishes no win32-arm64 build.
- `mise` nests its binary at `mise/bin/mise` inside a dated-tag archive
  (`mise-v2026.11.11-macos-arm64.tar.gz`).
- Record three behaviours worth knowing before this is left unattended:
  `agent-browser` needs a local Chrome/Chromium and leaves a daemon running, and
  its own `skills get core` fails on this build; `mise` is a version manager whose
  `activate` hook never runs in pi's `bash`, so only `mise exec --` sees project
  pins; `ruff` is normally pinned by the project, so `uv run ruff` should win.

## [0.8.0]

- Add `bd` ([gastownhall/beads](https://github.com/gastownhall/beads)), a
  Dolt-backed issue tracker for agents. Assets are named after the project
  (`beads_1.3.4_darwin_arm64.tar.gz`) while the binary is `bd`; Dolt is embedded,
  so the single binary is self-contained.
- Document two behaviours of `bd` that matter when it is installed automatically:
  `bd init` creates `.beads/`, **rewrites `AGENTS.md` by default** and installs
  editor/agent integrations unless told otherwise; and `bd` sends **anonymous
  usage metrics by default** (command names, version, OS — not issues or paths),
  which `DO_NOT_TRACK=1` disables. The package does not set that variable for the
  user.

## [0.7.0]

- Add `jq`, `yq`, `fzf`, `uv` and `gh`. All five ship ready-made binaries for
  linux/macos on x86_64 and arm64, plus Windows builds.
- Support releases whose asset **is** the executable, with no archive around it.
  `jq` publishes `jq-macos-arm64` and `yq` publishes `yq_linux_amd64`, so a raw
  download is staged directly and chmodded instead of being extracted.
- Strip each tool's own tag prefix when resolving versions. `jq` tags are
  `jq-1.8.2`, which the previous `^v`-only strip could not turn into `1.8.2`.
- `uv` installs both `uv` and `uvx`, which are two binaries in one archive.
- Note the sharp edges in the README and both skills: `gh` holds an OAuth token,
  `fzf` needs a TTY that pi's bash does not provide, `uv` manages Python
  toolchains outside the bin directory, `yq` here is mikefarah v4 and not
  kislyuk's Python tool, and `jq` now shadows the system copy.

## [0.6.0]

- Detect and repair bundled shims, not just the primary binary. `ast-grep` ships
  a deprecated `sg` shim that is a 398 KB binary which **execs its sibling** — it
  exits 1 the moment `ast-grep` is missing or will not run. `status` now probes
  every name an archive provides and reports the specific one that is broken
  (`sg does not execute`) or gone (`sg missing`).
- `reinstall sg` works: a provided binary name resolves to the tool that owns its
  archive, so the whole bundle is reinstalled rather than reporting an unknown
  tool.
- Installs are atomic per archive. Every target is backed up, swapped, then
  probed, and any failure restores all of them. Previously each binary was
  swapped and probed in turn, so a broken shim could leave a new `ast-grep`
  beside a dead `sg` while the install reported success.
- Probes run with the bin directory on `PATH`, which is what lets a delegating
  shim resolve its sibling.
- A missing secondary is only treated as damage when the primary is installed;
  a fresh install is not a repair.
- The always-advertised skill now states a preference order: `rtk` first to shrink
  command output, then these binaries over the system copies, plain commands
  last. It also draws the line `rtk` makes easy to miss — it returns a *verdict*
  (`rtk test`, `rtk err`, `rtk deps`) and is wrong for *content* you must read,
  since `rtk git diff` reduces a diff to `a.txt | 1 +` and `rtk err` discards
  stdout. `tests/skills.test.ts` fails if the description stops leading with
  `rtk`, or if either skill drops the verdict/content split.

## [0.5.0]

- Add a repair path: `managed_tools` takes `action: "reinstall"` and an optional
  `tool`, and `/managed-tools reinstall [tool]` does the same from the command
  line. With no tool it replaces every managed binary that is present but cannot
  execute; with a tool name it forces a fresh verified download even when the
  installed version already matches upstream.
- Detect damaged binaries. `status` now reports a tool whose file exists but
  fails to run. Version comparison alone never caught this: a truncated or
  wrong-architecture file can sit at the expected path with a plausible version
  recorded beside it.
- A forced reinstall falls back to the version recorded on disk when the release
  lookup fails, so a repair still works on a broken network.
- `updateTools` now writes the check state itself. A tool that cannot report its
  own version (`gron`) is compared against that record, so any caller that forgot
  to persist it reinstalled `gron` on every run.

## [0.4.0]

- Add `ninja`. Its macOS asset (`ninja-mac.zip`) is a universal2 binary that runs
  natively on x86_64 and arm64, so one download serves both mac architectures;
  Linux and Windows each have a separate `aarch64`/`arm64` asset. Asset names
  carry no version.
- Ship two skills. `managed-tools` is the always-advertised one: its description
  is what pi puts in every system prompt, so it names all ten tools and the
  rules for reaching for them. `managed-tools-reference` carries the exact flag
  set and worked examples for each tool at the version this package installs.
- Add `tests/skills.test.ts`, which fails if a tool is added to the registry
  without a matching section in both skills, if a description exceeds the Agent
  Skills 1024-character limit, or if the two skills disagree about versions.

## [0.3.0]

- Add `just`, `gron`, `shellcheck` and `ast-grep`. Each project names its
  release assets differently, so the registry now carries a per-tool platform
  resolver alongside the per-tool asset-name closure.
- `ast-grep` ships two commands (`ast-grep` and the deprecated `sg`); both are
  installed from the one verified archive. Only the primary command is probed
  after install, because `sg` does not answer `--version`.
- Support `.tgz` archives (`gron`) and zips on macOS/Linux (`ast-grep`).
- Handle a tool whose release build reports no version: `gron --version` prints
  `gron version dev`. Such a tool is no longer treated as a failed install, and
  its installed version is read back from the recorded state so it is not
  reinstalled on every check.
- Record installed versions in the state file alongside the latest known ones.
- `tree` is **not** managed: upstream (`Old-Man-Programmer/tree`) publishes tags
  but no release assets, so there is no binary to download.

## [0.2.0]

- Verify every download against the sha256 digest GitHub records for the
  release asset, before extracting it. Verification is fail-closed: a release
  API that cannot be reached, or an asset published without a digest, is
  reported as a failure rather than installed. `PI_MANAGED_TOOLS_ALLOW_UNVERIFIED=1`
  is the only opt-out.
- Add `bat`, `prek` and `rtk` alongside `fd` and `rg`. `fd` and `rg` back pi's
  built-in `find` and `grep` tools; the other three are reachable from `bash`
  only, and `managed_tools` reports which is which.
- Give each tool its own platform gate. `rtk` publishes no
  `aarch64-pc-windows-msvc` archive, so it is now reported as unsupported there
  instead of failing with a 404.
- Stop letting a tool with no release for the platform force a network check on
  every start, which previously made the check interval inert.
- Report per-tool support instead of one global platform verdict, so one
  unsupported tool no longer hides the others.
- Prove an install runs before reporting success: the binary is executed, and a
  binary that cannot run is rolled back to the previous copy. The old code
  reported the version it asked for, which claimed success for a dead file.
- Fix a staged executable left behind in pi's bin directory when an install
  failed, and a Windows replacement path that removed the installed binary
  before the new one was in place.
- Handle asset names that carry no version (`prek`, `rtk`), which a version bump
  must not change.

## [0.1.0]

- Keep pi's managed `fd` and `rg` binaries at the latest upstream release:
  resolve `sharkdp/fd` and `BurntSushi/ripgrep` latest releases, compare with the
  copies in pi's bin directory, and replace outdated or missing ones in place.
- Startup check on `session_start`, at most once every 12 hours (configurable),
  skipped in offline mode, reported in the TUI only when something changed.
- `/managed-tools` command and `managed_tools` tool for on-demand status and
  update; `status` reports which path pi resolves for each binary.
- darwin/linux/win32 on arm64 and x64, using the same archives pi fetches.
