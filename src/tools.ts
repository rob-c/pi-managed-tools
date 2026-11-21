/*
 * pi-managed-tools — keep a set of developer binaries at their latest upstream release.
 * Copyright (C) 2026 Robert Currie
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; version 2 of the License only.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
 * PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with this
 * program; if not, see <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.
 */
/**
 * Keep a small set of developer binaries at the latest upstream release.
 *
 * pi downloads exactly two static binaries itself - fd for the `find` tool and
 * ripgrep for the `grep` tool - into `<agent dir>/bin` (dist/utils/tools-manager.js,
 * `getBinDir()`), and `getToolPath()` prefers that copy over anything on PATH.
 * `ensureTool()` only downloads when the file is *missing*: it never resolves a
 * newer release, so an install keeps whichever release it first fetched for as
 * long as the file exists. This module does the part pi does not - resolve the
 * latest release, compare it with the managed copy, and replace it in place.
 *
 * Two tools are consumed by pi itself (`consumedBy`); the rest are installed for
 * `bash` only, because pi prepends this directory to every command's PATH.
 *
 * Nothing here imports pi packages: the extension passes in its bin directory
 * and the tests run this module directly.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	createWriteStream,
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type ToolId =
	| "fd"
	| "rg"
	| "bat"
	| "prek"
	| "rtk"
	| "just"
	| "gron"
	| "shellcheck"
	| "ast-grep"
	| "ninja"
	| "jq"
	| "yq"
	| "fzf"
	| "uv"
	| "gh"
	| "bd"
	| "agent-browser"
	| "ruff"
	| "mise"
	| "scc"
	| "duckdb"
	| "miller"
	| "sd"
	| "difftastic"
	| "busybox";

export interface ManagedTool {
	id: ToolId;
	/** Name used in messages, matching what pi calls the tool. */
	name: string;
	repo: string;
	binaryName: string;
	/** Release tag prefix: fd tags are `v`-prefixed, ripgrep's are not. */
	tagPrefix: string;
	/** Asset name, which differs between the projects. */
	assetName(version: string, target: string): string;
	/** Names to look for when only a system copy exists. */
	systemBinaryNames: string[];
	/**
	 * Platform gate for a tool whose release matrix is narrower than pi's.
	 * Defaults to `releaseTarget()`. A tool that publishes no archive for a
	 * platform must answer `undefined` here instead of letting the download 404.
	 */
	resolveTarget?(plat: string, architecture: string): string | undefined;
	/**
	 * pi built-in tools that resolve this binary through `getToolPath()`. An
	 * empty list means the binary is only ever reached through `bash`'s PATH.
	 */
	consumedBy: string[];
	/**
	 * Every binary to take from the archive, keyed by its basename in the
	 * archive. Defaults to `[binaryName]`. Listed names are installed unchanged.
	 */
	provides?: string[];
	/**
	 * Set when the upstream build cannot report its own version (`gron --version`
	 * prints "gron version dev"). A missing version is then not a failed install,
	 * and the installed version is read back from the recorded state instead.
	 */
	versionOptional?: boolean;
	/**
	 * The release asset IS the executable, with no archive around it (`jq` ships
	 * `jq-macos-arm64` and `yq` ships `yq_linux_amd64`). Such an asset is staged
	 * directly instead of being extracted.
	 */
	raw?: boolean;
	/**
	 * Set only when upstream assets predate GitHub's digest field, which would
	 * otherwise make the tool permanently uninstallable under a fail-closed rule.
	 * Such an install is reported as unverified, never as verified.
	 */
	digestOptional?: boolean;
	/**
	 * Set when the shipped binary's build string lags its release tag (sd reports
	 * "sd 1.0.0" for tag v1.1.0). The digest already proves the asset is right, so
	 * the tag is trusted for version comparison; otherwise every check would read
	 * the stale number, decide the tool is outdated, and reinstall it forever.
	 */
	trustTagVersion?: boolean;
}

export const MANAGED_TOOLS: Record<ToolId, ManagedTool> = {
	fd: {
		id: "fd",
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		tagPrefix: "v",
		assetName: (version, target) => `fd-v${version}-${target}`,
		systemBinaryNames: ["fd", "fdfind"],
		consumedBy: ["find"],
	},
	rg: {
		id: "rg",
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		assetName: (version, target) => `ripgrep-${version}-${target}`,
		systemBinaryNames: ["rg"],
		consumedBy: ["grep"],
	},
	bat: {
		id: "bat",
		name: "bat",
		repo: "sharkdp/bat",
		binaryName: "bat",
		tagPrefix: "v",
		assetName: (version, target) => `bat-v${version}-${target}`,
		// Debian and Ubuntu install it as `batcat` to avoid clashing with `bat`.
		systemBinaryNames: ["bat", "batcat"],
		consumedBy: [],
	},
	prek: {
		id: "prek",
		name: "prek",
		repo: "j178/prek",
		binaryName: "prek",
		tagPrefix: "v",
		// prek publishes `prek-<target>` with no version in the filename. Tags at
		// or below v0.0.22 used the old `prefligit-` prefix; `latest` never resolves one.
		assetName: (_version, target) => `prek-${target}`,
		systemBinaryNames: ["prek"],
		consumedBy: [],
	},
	rtk: {
		id: "rtk",
		name: "rtk",
		repo: "rtk-ai/rtk",
		binaryName: "rtk",
		tagPrefix: "v",
		// `rtk-oss-<target>`, no version. The plain `rtk-<target>` build bundles a
		// BUSL-1.1 engine (LICENSE-ENGINE); `rtk-oss-` is the Apache-2.0-only build
		// with the same binary name and version banner. Do not switch to `rtk-`
		// without changing the licence note in the README.
		assetName: (_version, target) => `rtk-oss-${target}`,
		systemBinaryNames: ["rtk"],
		// No aarch64-pc-windows-msvc archive is published for any rtk variant.
		resolveTarget: (plat, architecture) =>
			plat === "win32" && architecture === "arm64" ? undefined : releaseTarget(plat, architecture),
		consumedBy: [],
	},
	just: {
		id: "just",
		name: "just",
		repo: "casey/just",
		binaryName: "just",
		// just tags are bare versions (1.59.0) and the asset repeats the version.
		tagPrefix: "",
		assetName: (version, target) => `just-${version}-${target}`,
		systemBinaryNames: ["just"],
		consumedBy: [],
	},
	gron: {
		id: "gron",
		name: "gron",
		repo: "tomnomnom/gron",
		binaryName: "gron",
		tagPrefix: "v",
		// gron names assets by OS and Go arch, not by Rust triple, and ships .tgz
		// on unix and .zip on Windows: gron-darwin-arm64-0.7.1.tgz
		resolveTarget: gronTarget,
		assetName: (version, target) =>
			`gron-${target}-${version}.${target.startsWith("windows") ? "zip" : "tgz"}`,
		systemBinaryNames: ["gron"],
		// Release builds print "gron version dev": no version to compare.
		versionOptional: true,
		// gron's newest release predates GitHub's per-asset digest field, so the
		// release API returns none. Without this it could never install at all;
		// the install is reported as unverified.
		digestOptional: true,
		consumedBy: [],
	},
	shellcheck: {
		id: "shellcheck",
		name: "shellcheck",
		repo: "koalaman/shellcheck",
		binaryName: "shellcheck",
		tagPrefix: "v",
		// shellcheck uses dot-separated OS.arch and has one arch-less zip for
		// Windows x86_64: shellcheck-v0.11.0.darwin.aarch64.tar.gz, shellcheck-v0.11.0.zip
		resolveTarget: shellcheckTarget,
		assetName: (version, target) =>
			target === "zip" ? `shellcheck-v${version}.zip` : `shellcheck-v${version}.${target}`,
		systemBinaryNames: ["shellcheck"],
		consumedBy: [],
	},
	"ast-grep": {
		id: "ast-grep",
		name: "ast-grep",
		repo: "ast-grep/ast-grep",
		binaryName: "ast-grep",
		// ast-grep tags are bare versions (0.51.3).
		tagPrefix: "",
		// Every platform gets a zip named app-<rust triple>.zip, which holds BOTH
		// `ast-grep` and the deprecated `sg` entry point.
		resolveTarget: (plat, architecture) => releaseTarget(plat, architecture)?.replace(/\.tar\.gz$/, ".zip"),
		assetName: (_version, target) => `app-${target}`,
		provides: ["ast-grep", "sg"],
		systemBinaryNames: ["ast-grep"],
		consumedBy: [],
	},
	ninja: {
		id: "ninja",
		name: "ninja",
		repo: "ninja-build/ninja",
		binaryName: "ninja",
		tagPrefix: "v",
		// Arch-less names, and the macOS build is one universal2 binary that runs
		// natively on x86_64 and arm64: ninja-mac.zip, ninja-linux.zip,
		// ninja-linux-aarch64.zip, ninja-win.zip, ninja-winarm64.zip.
		resolveTarget: ninjaTarget,
		assetName: (_version, target) => `ninja-${target}.zip`,
		systemBinaryNames: ["ninja"],
		consumedBy: [],
	},
	jq: {
		id: "jq",
		name: "jq",
		repo: "jqlang/jq",
		binaryName: "jq",
		// jq tags carry their own prefix (jq-1.8.2), and the assets are bare
		// executables with no version in the name: jq-macos-arm64.
		tagPrefix: "jq-",
		resolveTarget: (plat, architecture) => goOsArch(plat, architecture, "macos"),
		assetName: (_version, target) => `jq-${target}${target.startsWith("windows") ? ".exe" : ""}`,
		systemBinaryNames: ["jq"],
		raw: true,
		consumedBy: [],
	},
	yq: {
		id: "yq",
		name: "yq",
		// mikefarah/yq, the Go rewrite (v4 CLI). The other `yq` in the ecosystem is
		// kislyuk/yq, a Python wrapper with a different flag surface.
		repo: "mikefarah/yq",
		binaryName: "yq",
		tagPrefix: "v",
		resolveTarget: (plat, architecture) => goOsArch(plat, architecture, "darwin"),
		assetName: (_version, target) => {
			const name = `yq_${target.replace("-", "_")}`;
			return target.startsWith("windows") ? `${name}.exe` : name;
		},
		systemBinaryNames: ["yq"],
		raw: true,
		consumedBy: [],
	},
	fzf: {
		id: "fzf",
		name: "fzf",
		repo: "junegunn/fzf",
		binaryName: "fzf",
		tagPrefix: "v",
		resolveTarget: (plat, architecture) => goOsArch(plat, architecture, "darwin"),
		assetName: (version, target) => {
			const name = `fzf-${version}-${target.replace("-", "_")}`;
			return target.startsWith("windows") ? `${name}.zip` : `${name}.tar.gz`;
		},
		systemBinaryNames: ["fzf"],
		consumedBy: [],
	},
	uv: {
		id: "uv",
		name: "uv",
		repo: "astral-sh/uv",
		binaryName: "uv",
		tagPrefix: "",
		// Rust triples. The archive also carries `uvx`, which is the same tool's
		// tool-runner entry point, so both commands are installed.
		assetName: (_version, target) => `uv-${target}`,
		provides: ["uv", "uvx"],
		systemBinaryNames: ["uv"],
		consumedBy: [],
	},
	gh: {
		id: "gh",
		name: "gh",
		repo: "cli/cli",
		binaryName: "gh",
		tagPrefix: "v",
		// Linux ships tar.gz; macOS and Windows ship zips, so the extension is part
		// of the target rather than the tool: gh_2.105.0_macOS_arm64.zip
		resolveTarget: (plat, architecture) => ghTarget(plat, architecture),
		assetName: (version, target) => {
			const ext = target.startsWith("linux") ? ".tar.gz" : ".zip";
			return `gh_${version}_${target}${ext}`;
		},
		systemBinaryNames: ["gh"],
		consumedBy: [],
	},
	bd: {
		id: "bd",
		name: "bd",
		// gastownhall/beads: a Dolt-backed issue tracker. The assets are named
		// after the project but the binary is `bd`.
		repo: "gastownhall/beads",
		binaryName: "bd",
		tagPrefix: "v",
		resolveTarget: (plat, architecture) => goOsArch(plat, architecture, "darwin"),
		assetName: (version, target) => {
			const name = `beads_${version}_${target.replace("-", "_")}`;
			return target.startsWith("windows") ? `${name}.zip` : `${name}.tar.gz`;
		},
		systemBinaryNames: ["bd"],
		consumedBy: [],
	},
	"agent-browser": {
		id: "agent-browser",
		name: "agent-browser",
		repo: "vercel-labs/agent-browser",
		binaryName: "agent-browser",
		tagPrefix: "v",
		// Bare executables, Go-style names, `.exe` on win32. No win32-arm64 asset.
		resolveTarget: agentBrowserTarget,
		assetName: (_version, target) =>
			`agent-browser-${target}${target.startsWith("win32") ? ".exe" : ""}`,
		systemBinaryNames: ["agent-browser"],
		raw: true,
		consumedBy: [],
	},
	ruff: {
		id: "ruff",
		name: "ruff",
		repo: "astral-sh/ruff",
		binaryName: "ruff",
		// ruff tags are bare versions (0.17.6) and assets use Rust triples.
		tagPrefix: "",
		assetName: (_version, target) => `ruff-${target}`,
		systemBinaryNames: ["ruff"],
		consumedBy: [],
	},
	mise: {
		id: "mise",
		name: "mise",
		repo: "jdx/mise",
		binaryName: "mise",
		tagPrefix: "v",
		// Dated tags (v2026.11.11) and `x64`/`macos` naming. The archive nests the
		// binary at mise/bin/mise.
		resolveTarget: (plat, architecture) => osArchX64(plat, architecture, "macos"),
		assetName: (version, target) =>
			`mise-v${version}-${target}${target.startsWith("windows") ? ".zip" : ".tar.gz"}`,
		systemBinaryNames: ["mise"],
		consumedBy: [],
	},
	scc: {
		id: "scc",
		name: "scc",
		repo: "boyter/scc",
		binaryName: "scc",
		tagPrefix: "v",
		// Capitalised OS and underscore: scc_Darwin_arm64.tar.gz, scc_Windows_x86_64.zip
		resolveTarget: (plat, architecture) => {
			const os = plat === "darwin" ? "Darwin" : plat === "linux" ? "Linux" : plat === "win32" ? "Windows" : undefined;
			const cpu = architecture === "arm64" ? "arm64" : architecture === "x64" ? "x86_64" : undefined;
			if (!os || !cpu) return undefined;
			return `${os}_${cpu}`;
		},
		assetName: (_version, target) =>
			`scc_${target}${target.startsWith("Windows") ? ".zip" : ".tar.gz"}`,
		systemBinaryNames: ["scc"],
		consumedBy: [],
	},
	duckdb: {
		id: "duckdb",
		name: "duckdb",
		repo: "duckdb/duckdb",
		binaryName: "duckdb",
		tagPrefix: "v",
		// osx/linux/windows with amd64: duckdb-cli-osx-arm64.tar.gz
		resolveTarget: (plat, architecture) => goTarget(plat, architecture, "osx", "amd64"),
		assetName: (_version, target) => `duckdb-cli-${target}.tar.gz`,
		systemBinaryNames: ["duckdb"],
		consumedBy: [],
	},
	miller: {
		id: "miller",
		name: "miller",
		repo: "johnkerl/miller",
		binaryName: "mlr",
		tagPrefix: "v",
		// The asset repeats the version without its v: miller-6.22.0-darwin-arm64
		resolveTarget: (plat, architecture) => goTarget(plat, architecture, "darwin", "amd64"),
		assetName: (version, target) =>
			`miller-${version}-${target}${target.startsWith("windows") ? ".zip" : ".tar.gz"}`,
		systemBinaryNames: ["mlr"],
		consumedBy: [],
	},
	sd: {
		id: "sd",
		name: "sd",
		repo: "chmln/sd",
		binaryName: "sd",
		tagPrefix: "v",
		// The asset keeps the v in its name (sd-v1.1.0-...) and there is no
		// win32-arm64 build.
		resolveTarget: (plat, architecture) => {
			const cpu = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : undefined;
			if (!cpu) return undefined;
			if (plat === "darwin") return `${cpu}-apple-darwin`;
			if (plat === "linux") return `${cpu}-unknown-linux-musl`;
			if (plat === "win32") return cpu === "x86_64" ? "x86_64-pc-windows-msvc" : undefined;
			return undefined;
		},
		assetName: (version, target) =>
			`sd-v${version}-${target}${target.includes("windows") ? ".zip" : ".tar.gz"}`,
		systemBinaryNames: ["sd"],
		// sd 1.1.0 ships a binary that still reports 1.0.0.
		trustTagVersion: true,
		consumedBy: [],
	},
	difftastic: {
		id: "difftastic",
		name: "difftastic",
		repo: "Wilfred/difftastic",
		binaryName: "difft",
		// difftastic tags are bare versions (0.72.0).
		tagPrefix: "",
		// Linux arm64 publishes gnu only, so gnu is used for both linux arches.
		resolveTarget: (plat, architecture) => {
			const cpu = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : undefined;
			if (!cpu) return undefined;
			if (plat === "darwin") return `${cpu}-apple-darwin`;
			if (plat === "linux") return `${cpu}-unknown-linux-gnu`;
			if (plat === "win32") return `${cpu}-pc-windows-msvc`;
			return undefined;
		},
		assetName: (version, target) =>
			`difft-${version}-${target}${target.includes("windows") ? ".zip" : ".tar.gz"}`,
		systemBinaryNames: ["difft"],
		consumedBy: [],
	},
	busybox: {
		id: "busybox",
		name: "busybox",
		// rob-c/busybox-static: upstream BusyBox built static (musl/zig on Linux,
		// Mach-O with Darwin port patches on macOS). Assets are bare executables.
		repo: "rob-c/busybox-static",
		binaryName: "busybox",
		tagPrefix: "v",
		// macOS ships one universal2 binary, so a single asset covers both
		// architectures. There is no Windows build.
		resolveTarget: (plat, architecture) => {
			if (plat === "darwin") {
				return architecture === "arm64" || architecture === "x64" ? "darwin-universal" : undefined;
			}
			if (plat === "linux") {
				return architecture === "arm64" ? "linux-arm64" : architecture === "x64" ? "linux-amd64" : undefined;
			}
			return undefined;
		},
		// No v in the asset name despite the v-prefixed tag.
		assetName: (version, target) => `busybox-static-${version}-${target}`,
		systemBinaryNames: ["busybox"],
		raw: true,
		// The binary reports "BusyBox v1.39.0.git" while the tag carries the commit
		// (v1.39.0-aac079e), so the tag is the only version that can be compared.
		trustTagVersion: true,
		consumedBy: [],
	},
};

/** Same order pi's startup download uses, so messages read predictably. */
export const MANAGED_TOOL_IDS: ToolId[] = [
	"fd",
	"rg",
	"bat",
	"prek",
	"rtk",
	"just",
	"gron",
	"shellcheck",
	"ast-grep",
	"ninja",
	"jq",
	"yq",
	"fzf",
	"uv",
	"gh",
	"bd",
	"agent-browser",
	"ruff",
	"mise",
	"scc",
	"duckdb",
	"miller",
	"sd",
	"difftastic",
	"busybox",
];

/** Release target for one tool on this platform, or undefined when it has none. */
export function targetFor(tool: ManagedTool, plat: string, architecture: string): string | undefined {
	return tool.resolveTarget ? tool.resolveTarget(plat, architecture) : releaseTarget(plat, architecture);
}

/** gron encodes OS and Go arch: darwin-arm64, linux-amd64, windows-arm64. */
function gronTarget(plat: string, architecture: string): string | undefined {
	const os = plat === "darwin" ? "darwin" : plat === "linux" ? "linux" : plat === "win32" ? "windows" : undefined;
	const cpu = architecture === "arm64" ? "arm64" : architecture === "x64" ? "amd64" : undefined;
	if (!os || !cpu) return undefined;
	return `${os}-${cpu}`;
}

/** os-cpu pairs for projects whose CPU label differs (x86_64 vs amd64). */
function goTarget(plat: string, architecture: string, darwinOs: string, x64: string): string | undefined {
	const os =
		plat === "darwin" ? darwinOs : plat === "linux" ? "linux" : plat === "win32" ? "windows" : undefined;
	const cpu = architecture === "arm64" ? "arm64" : architecture === "x64" ? x64 : undefined;
	if (!os || !cpu) return undefined;
	return `${os}-${cpu}`;
}

/** Go-style os-arch pairs, as jq, yq and fzf name their assets. */
function goOsArch(plat: string, architecture: string, darwinName: string): string | undefined {
	const os =
		plat === "darwin" ? darwinName : plat === "linux" ? "linux" : plat === "win32" ? "windows" : undefined;
	const cpu = architecture === "arm64" ? "arm64" : architecture === "x64" ? "amd64" : undefined;
	if (!os || !cpu) return undefined;
	return `${os}-${cpu}`;
}

/** os/arch pairs where the x86_64 build is called `x64`, as mise names them. */
function osArchX64(plat: string, architecture: string, darwinName: string): string | undefined {
	const os =
		plat === "darwin" ? darwinName : plat === "linux" ? "linux" : plat === "win32" ? "windows" : undefined;
	const cpu = architecture === "arm64" ? "arm64" : architecture === "x64" ? "x64" : undefined;
	if (!os || !cpu) return undefined;
	return `${os}-${cpu}`;
}

/**
 * agent-browser keeps the OS names lowercase and calls Windows `win32`.
 *
 * The plain linux asset is dynamically linked against glibc (`/lib64/ld-linux`),
 * while the `linux-musl` one is statically linked and so runs on glibc and musl
 * both. Verified with `file` on both linux-x64 builds.
 */
function agentBrowserTarget(plat: string, architecture: string): string | undefined {
	const cpu = architecture === "arm64" ? "arm64" : architecture === "x64" ? "x64" : undefined;
	if (!cpu) return undefined;
	if (plat === "darwin") return `darwin-${cpu}`;
	if (plat === "linux") return `linux-musl-${cpu}`;
	// No win32-arm64 asset is published.
	if (plat === "win32") return cpu === "x64" ? "win32-x64" : undefined;
	return undefined;
}

/** gh names its macOS asset with a capital OS and an underscore. */
function ghTarget(plat: string, architecture: string): string | undefined {
	const target = goOsArch(plat, architecture, "macOS");
	return target?.replace("-", "_");
}

/** shellcheck encodes OS and arch with dots, and only ships an x64 zip for Windows. */
/**
 * ninja publishes arch-less names, and its macOS asset is a universal2 binary,
 * so one download serves both mac architectures. Linux and Windows carry a
 * separate asset per architecture.
 */
function ninjaTarget(plat: string, architecture: string): string | undefined {
	if (plat === "darwin") return architecture === "arm64" || architecture === "x64" ? "mac" : undefined;
	if (plat === "linux") return architecture === "arm64" ? "linux-aarch64" : architecture === "x64" ? "linux" : undefined;
	if (plat === "win32") return architecture === "arm64" ? "winarm64" : architecture === "x64" ? "win" : undefined;
	return undefined;
}

function shellcheckTarget(plat: string, architecture: string): string | undefined {
	if (plat === "win32") return architecture === "x64" ? "zip" : undefined;
	if (plat !== "darwin" && plat !== "linux") return undefined;
	const cpu = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : undefined;
	if (!cpu) return undefined;
	return `${plat}.${cpu}.tar.gz`;
}

const NETWORK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const STATE_FILE = ".pi-managed-tools.json";
const DEFAULT_INTERVAL_HOURS = 12;

// =============================================================================
// Platform targets
// =============================================================================

/**
 * Release suffix shared by the fd and ripgrep archives. Mirrors pi's own
 * `getReleaseTarget()`: only x64 and arm64 have prebuilt binaries, and an
 * unknown architecture must not fall back to an x86-64 download.
 */
export function releaseTarget(plat: string, architecture: string): string | undefined {
	const archName = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : undefined;
	if (!archName) return undefined;
	if (plat === "darwin") return `${archName}-apple-darwin.tar.gz`;
	if (plat === "linux") return `${archName}-unknown-linux-musl.tar.gz`;
	if (plat === "win32") return `${archName}-pc-windows-msvc.zip`;
	return undefined;
}

export function binaryFileName(tool: ManagedTool, plat: string): string {
	return tool.binaryName + (plat === "win32" ? ".exe" : "");
}

/** Path pi's `getToolPath()` checks first. */
export function managedBinaryPath(tool: ManagedTool, binDir: string, plat: string = platform()): string {
	return join(binDir, binaryFileName(tool, plat));
}

// =============================================================================
// Versions
// =============================================================================

/** `fd --version` prints "fd 10.5.2"; `rg --version` prints "ripgrep 15.2.0 (rev ...)". */
export function parseVersion(output: string): string | undefined {
	const match = output.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
	return match?.[1];
}

/** Ordered compare for the "x.y.z(-prerelease)" versions these projects ship. */
export function compareVersions(a: string, b: string): number {
	const [aCore, aPre] = splitVersion(a);
	const [bCore, bPre] = splitVersion(b);
	for (let i = 0; i < Math.max(aCore.length, bCore.length); i++) {
		const left = aCore[i] ?? 0;
		const right = bCore[i] ?? 0;
		if (left !== right) return left < right ? -1 : 1;
	}
	// A release outranks any prerelease of the same core version.
	if (aPre === bPre) return 0;
	if (!aPre) return 1;
	if (!bPre) return -1;
	return aPre < bPre ? -1 : 1;
}

function splitVersion(version: string): [number[], string] {
	const [core, pre = ""] = version.replace(/^v/, "").split("-", 2);
	const numbers = core.split(".").map((part) => Number.parseInt(part, 10) || 0);
	return [numbers, pre];
}

/**
 * Run the binary once: did it execute, and did it name a version?
 *
 * Both halves matter. A binary that cannot execute (wrong architecture, glibc
 * against a musl build, a truncated file) exits non-zero or fails to spawn, and
 * a few upstreams build without embedding a version at all (`gron --version`
 * prints "gron version dev"), which is not the same thing as a broken install.
 */
export function probeBinary(binaryPath: string, pathDir?: string): { ran: boolean; version?: string } {
	if (!existsSync(binaryPath)) return { ran: false };
	// A bundled shim can delegate to a sibling in the same directory (ast-grep's
	// `sg` execs `ast-grep`), so the probe may need that directory on PATH.
	const env = pathDir
		? { ...process.env, PATH: [pathDir, process.env.PATH ?? ""].join(delimiter) }
		: process.env;
	const result = spawnSync(binaryPath, ["--version"], {
		encoding: "utf-8",
		timeout: 10_000,
		env,
		// A Windows copy is sometimes a shim that needs the real file beside it.
		windowsHide: true,
	});
	if (result.error) return { ran: false };
	const stdout = typeof result.stdout === "string" ? result.stdout : "";
	const stderr = typeof result.stderr === "string" ? result.stderr : "";
	return { ran: result.status === 0, version: parseVersion(stdout) ?? parseVersion(stderr) };
}

/** Version of an installed binary, or undefined when it cannot report one. */
export function readToolVersion(binaryPath: string): string | undefined {
	return probeBinary(binaryPath).version;
}

/** Where a plain `fd`/`rg` in the user's PATH lives, which pi falls back to. */
export function findSystemBinary(tool: ManagedTool, plat: string = platform()): string | undefined {
	const locator = plat === "win32" ? "where" : "which";
	for (const name of tool.systemBinaryNames) {
		const result = spawnSync(locator, [name], { encoding: "utf-8", timeout: 5000, windowsHide: true });
		if (result.status !== 0 || typeof result.stdout !== "string") continue;
		const first = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
		if (first) return first;
	}
	return undefined;
}

// =============================================================================
// Network
// =============================================================================

export interface NetworkOptions {
	/** Injectable for tests; defaults to the global fetch. */
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
	userAgent?: string;
}

class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One controller for the caller's abort signal plus our own timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms);
	timer.unref?.();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

function isRetryable(error: unknown): boolean {
	if (error instanceof HttpError) return error.status === 429 || error.status >= 500;
	// Network failures surface as TypeError("fetch failed") with the cause hidden
	// one level down (DNS, TLS, connection reset). An aborted request is the
	// caller's own shutdown, not a transient fault.
	if (error instanceof Error && error.name === "AbortError") return false;
	return error instanceof TypeError;
}

async function fetchWithRetries(
	url: string,
	init: RequestInit,
	options: NetworkOptions,
	attempts = 3,
): Promise<Response> {
	const fetchImpl = options.fetchImpl ?? fetch;
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		const timeout = withTimeout(options.signal, options.timeoutMs ?? NETWORK_TIMEOUT_MS);
		try {
			const response = await fetchImpl(url, {
				...init,
				signal: timeout.signal,
				headers: { "User-Agent": options.userAgent ?? "pi-managed-tools", ...(init.headers as object) },
			});
			if (response.status === 429 || response.status >= 500) {
				throw new HttpError(response.status, `HTTP ${response.status} for ${url}`);
			}
			return response;
		} catch (error) {
			lastError = error;
			if (options.signal?.aborted) throw error;
			if (!isRetryable(error) || attempt === attempts - 1) throw error;
			await sleep(500 * 2 ** attempt);
		} finally {
			timeout.dispose();
		}
	}
	throw lastError;
}

/**
 * Latest release tag, without the `v` prefix.
 *
 * The redirect from `/releases/latest` is used first because the
 * api.github.com endpoint counts against the anonymous 60 requests/hour quota,
 * which shared egress IPs exhaust; the API is only a fallback for the rare
 * answer without a redirect.
 */
export async function fetchLatestVersion(tool: ManagedTool, options: NetworkOptions = {}): Promise<string> {
	const response = await fetchWithRetries(
		`https://github.com/${tool.repo}/releases/latest`,
		{ redirect: "manual" },
		options,
	);
	try {
		await response.body?.cancel();
	} catch {
		// Discarding the body is best-effort.
	}
	const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
	if (location?.includes("/releases/tag/")) {
		const tag = new URL(location, "https://github.com").pathname.split("/").pop();
		if (tag) return stripTagPrefix(decodeURIComponent(tag), tool.tagPrefix);
	}

	const api = await fetchWithRetries(
		`https://api.github.com/repos/${tool.repo}/releases/latest`,
		{ headers: { Accept: "application/vnd.github+json" } },
		options,
	);
	if (!api.ok) throw new HttpError(api.status, `HTTP ${api.status} for api.github.com/${tool.repo}/releases/latest`);
	const payload = (await api.json()) as { tag_name?: unknown };
	if (typeof payload.tag_name !== "string") {
		throw new Error(`Unexpected GitHub API response for ${tool.repo}: no tag_name`);
	}
	return stripTagPrefix(payload.tag_name, tool.tagPrefix);
}

/** jq tags are jq-1.8.2; most projects use a bare or v-prefixed version. */
function stripTagPrefix(tag: string, prefix: string): string {
	if (prefix && tag.startsWith(prefix)) return tag.slice(prefix.length);
	return tag.replace(/^v/, "");
}

function downloadUrl(tool: ManagedTool, version: string, asset: string): string {
	return `https://github.com/${tool.repo}/releases/download/${tool.tagPrefix}${version}/${asset}`;
}

async function downloadFile(url: string, dest: string, options: NetworkOptions): Promise<void> {
	const response = await fetchWithRetries(url, {}, { ...options, timeoutMs: DOWNLOAD_TIMEOUT_MS });
	if (!response.ok) throw new HttpError(response.status, `Download failed with HTTP ${response.status}: ${url}`);
	if (!response.body) throw new Error(`No response body for ${url}`);
	await pipeline(Readable.fromWeb(response.body as never), createWriteStream(dest));
}

// =============================================================================
// Integrity
// =============================================================================

/** Set to `1`/`true`/`yes` to install an archive whose digest cannot be confirmed. */
const ALLOW_UNVERIFIED_ENV = "PI_MANAGED_TOOLS_ALLOW_UNVERIFIED";

/**
 * Verification is fail-closed: an unreachable release API means "cannot prove",
 * not "proved good". The opt-out exists for air-gapped mirrors and for the rare
 * asset a project uploads without a digest.
 */
export function allowUnverified(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = (env[ALLOW_UNVERIFIED_ENV] ?? "").trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

export function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The digest GitHub recorded for one release asset, as a bare lowercase hex sha256.
 *
 * GitHub computes this at upload time, so it does not depend on the project
 * publishing sidecar checksums - fd and bat publish none at all. Returns
 * undefined when the release or the asset is not visible to the API.
 */
export async function fetchAssetDigest(
	tool: ManagedTool,
	version: string,
	asset: string,
	options: NetworkOptions = {},
): Promise<string | undefined> {
	const tag = `${tool.tagPrefix}${version}`;
	const url = `https://api.github.com/repos/${tool.repo}/releases/tags/${encodeURIComponent(tag)}`;
	// The anonymous quota is 60 requests/hour per IP, shared with everything else
	// on the host. A token is optional and only raises that limit.
	const token = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "").trim();
	const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
	if (token) headers.Authorization = `Bearer ${token}`;
	const response = await fetchWithRetries(url, { headers }, options);
	if (!response.ok) throw new HttpError(response.status, `HTTP ${response.status} for ${url}`);
	const payload = (await response.json()) as { assets?: Array<{ name?: unknown; digest?: unknown }> };
	const match = payload.assets?.find((entry) => entry?.name === asset);
	if (!match || typeof match.digest !== "string") return undefined;
	const separator = match.digest.indexOf(":");
	if (separator < 0) return undefined;
	const algorithm = match.digest.slice(0, separator).toLowerCase();
	const hex = match.digest.slice(separator + 1).toLowerCase();
	if (algorithm !== "sha256" || !/^[0-9a-f]{64}$/.test(hex)) return undefined;
	return hex;
}

/**
 * Check the downloaded archive against GitHub's digest, and return the digest
 * that was accepted.
 *
 * A `.sha256` sidecar would not be enough on its own: an attacker who can
 * replace a release asset can usually replace the sidecar beside it. The digest
 * comes from the release resource instead.
 */
export interface VerifiedArchive {
	digest: string;
	/** False only when the unverified opt-out let an unconfirmed archive through. */
	verified: boolean;
}

/**
 * Check the downloaded archive against GitHub's digest.
 *
 * A `.sha256` sidecar would not be enough on its own: an attacker who can
 * replace a release asset can usually replace the sidecar beside it. The digest
 * comes from the release resource instead.
 */
export async function verifyArchive(
	tool: ManagedTool,
	version: string,
	asset: string,
	archivePath: string,
	options: NetworkOptions & { allowUnverified?: boolean } = {},
): Promise<VerifiedArchive> {
	const actual = sha256File(archivePath);
	const permitted = options.allowUnverified ?? allowUnverified();
	let expected: string | undefined;
	try {
		expected = await fetchAssetDigest(tool, version, asset, options);
	} catch (error) {
		if (permitted || tool.digestOptional) return { digest: actual, verified: false };
		const status = error instanceof HttpError ? error.status : undefined;
		const cause =
			status === 403 || status === 429
				? `GitHub API rate limit or access denied (${status}); set GITHUB_TOKEN to raise the limit`
				: errorMessage(error);
		throw new Error(
			`${tool.name}: cannot verify ${asset}: ${cause}; set ${ALLOW_UNVERIFIED_ENV}=1 to install it unverified`,
		);
	}
	if (!expected) {
		if (permitted || tool.digestOptional) return { digest: actual, verified: false };
		throw new Error(
			`${tool.name}: no digest published for ${asset}; set ${ALLOW_UNVERIFIED_ENV}=1 to install it unverified`,
		);
	}
	if (expected !== actual) {
		throw new Error(`${tool.name}: digest mismatch for ${asset}: expected ${expected}, got ${actual}`);
	}
	return { digest: actual, verified: true };
}

// =============================================================================
// Archives
// =============================================================================

function runExtraction(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { encoding: "utf-8", windowsHide: true });
	if (!result.error && result.status === 0) return null;
	const detail = result.error?.message || String(result.stderr ?? "").trim() || `exit status ${result.status}`;
	return `${command}: ${detail}`;
}

/** Windows ships bsdtar as tar.exe; Git Bash's GNU tar cannot read zip archives. */
function windowsTar(): string {
	const systemRoot = process.env.SystemRoot;
	if (systemRoot) {
		const systemTar = join(systemRoot, "System32", "tar.exe");
		if (existsSync(systemTar)) return systemTar;
	}
	return "tar.exe";
}

function extractZip(archivePath: string, extractDir: string): void {
	const failures: string[] = [];
	if (process.platform === "win32") {
		const tarFailure = runExtraction(windowsTar(), ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);
		const script =
			"& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
		const powershellFailure = runExtraction("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
			archivePath,
			extractDir,
		]);
		if (!powershellFailure) return;
		failures.push(powershellFailure);
	} else {
		const unzipFailure = runExtraction("unzip", ["-q", archivePath, "-d", extractDir]);
		if (!unzipFailure) return;
		failures.push(unzipFailure);
		const tarFailure = runExtraction("tar", ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);
	}
	throw new Error(`Failed to extract ${archivePath}: ${failures.join("; ")}`);
}

function findFileRecursively(rootDir: string, fileName: string): string | undefined {
	const stack = [rootDir];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const fullPath = join(current, entry.name);
			if (entry.isFile() && entry.name === fileName) return fullPath;
			if (entry.isDirectory()) stack.push(fullPath);
		}
	}
	return undefined;
}

function sleepSync(ms: number): void {
	const shared = new SharedArrayBuffer(4);
	Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/**
 * Put `staged` at `target`, then prove the result runs.
 *
 * POSIX renames over the old inode atomically, so a running pi keeps using the
 * binary it already opened. Windows refuses to replace a running image, so the
 * old file is linked aside first and restored if either the swap or the version
 * probe fails. The probe matters for a class of bug the previous version shipped:
 * reporting the version we *asked for* claims success for a binary that cannot
 * execute at all (wrong arch, glibc against a musl build, a truncated download).
 */
interface BundleEntry {
	staged: string;
	target: string;
	/** Only the tool's primary binary is required to report a version. */
	primary: boolean;
}

interface BundlePlan extends BundleEntry {
	backup: string;
	hadTarget: boolean;
	hasBackup: boolean;
}

/** Swap one staged file into place, tolerating Windows' refusal to replace a running image. */
function swapIn(entry: BundleEntry, plat: string): void {
	if (plat !== "win32") {
		renameSync(entry.staged, entry.target);
		return;
	}
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			rmSync(entry.target, { force: true });
			renameSync(entry.staged, entry.target);
			return;
		} catch (error) {
			lastError = error;
			sleepSync(200 * (attempt + 1));
		}
	}
	throw lastError;
}

/**
 * Install every binary an archive provides, as one unit.
 *
 * One archive can carry several commands (ast-grep ships `ast-grep` and the `sg`
 * shim, which execs its sibling). Swapping them one at a time and probing only
 * the first leaves a half-repaired bundle: a new `ast-grep` beside a broken `sg`
 * reports success while the damaged command is still there. So every target is
 * backed up, every target is swapped, every target is probed, and any failure
 * restores all of them.
 */
function installBundle(
	entries: BundleEntry[],
	plat: string,
	tool: ManagedTool,
	unique: string,
	binDir: string,
): string | undefined {
	const plan: BundlePlan[] = entries.map((entry) => ({
		...entry,
		// The token keeps a concurrent pi process from overwriting this run's rollback.
		backup: `${entry.target}.${unique}.previous`,
		hadTarget: existsSync(entry.target),
		hasBackup: false,
	}));

	for (const entry of plan) {
		if (!entry.hadTarget) continue;
		// Hardlink rather than copy: keeps the old inode reachable with no extra I/O.
		// Copy is the fallback for filesystems without hard links.
		try {
			linkSync(entry.target, entry.backup);
			entry.hasBackup = true;
		} catch {
			try {
				copyFileSync(entry.target, entry.backup);
				entry.hasBackup = true;
			} catch {
				entry.hasBackup = false;
			}
		}
		// Replacing a binary we could not back up would leave nothing to restore.
		if (!entry.hasBackup) {
			for (const previous of plan) rmSync(previous.backup, { force: true });
			throw new Error(`${tool.name}: cannot back up ${entry.target}; refusing to replace it`);
		}
	}

	try {
		for (const entry of plan) swapIn(entry, plat);

		let detected: string | undefined;
		for (const entry of plan) {
			const probe = probeBinary(entry.target, binDir);
			if (!probe.ran) throw new Error(`${tool.name}: installed binary did not run: ${entry.target}`);
			if (entry.primary) {
				if (!probe.version && !tool.versionOptional) {
					throw new Error(`${tool.name}: ${entry.target} reported no version; refusing to install it`);
				}
				detected = probe.version;
			}
		}

		for (const entry of plan) rmSync(entry.backup, { force: true });
		return detected;
	} catch (error) {
		for (const entry of plan) {
			if (entry.hasBackup) {
				try {
					renameSync(entry.backup, entry.target);
				} catch {
					// Nothing further to restore from.
				}
			} else if (!entry.hadTarget) {
				// Only remove what this run created.
				rmSync(entry.target, { force: true });
			}
		}
		throw error;
	}
}

// =============================================================================
// Install
// =============================================================================

export interface InstallOptions extends NetworkOptions {
	binDir: string;
	plat?: string;
	architecture?: string;
	/** Override the fail-closed digest policy for this call. */
	allowUnverified?: boolean;
	onProgress?: (message: string) => void;
}

export interface InstallResult {
	path: string;
	version: string | undefined;
	/** sha256 recorded for the archive this binary came from. */
	digest?: string;
	/** False only when the unverified opt-out let an unconfirmed archive through. */
	verified?: boolean;
}

/**
 * Download one release and put its binary where pi looks for it.
 *
 * The archive is fetched and extracted inside the bin directory so the final
 * rename stays on one filesystem - a rename across devices fails, and a
 * non-atomic copy could leave a truncated binary where pi expects a working
 * one.
 */
export async function installTool(
	toolId: ToolId,
	version: string,
	options: InstallOptions,
): Promise<InstallResult> {
	const tool = MANAGED_TOOLS[toolId];
	const plat = options.plat ?? platform();
	const architecture = options.architecture ?? arch();
	const target = targetFor(tool, plat, architecture);
	if (!target) {
		throw new Error(`${tool.name}: no prebuilt release for ${plat}/${architecture}`);
	}

	const asset = tool.assetName(version, target);
	const url = downloadUrl(tool, version, asset);
	const binDir = options.binDir;
	mkdirSync(binDir, { recursive: true });

	const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const archivePath = join(binDir, `.${asset}.${unique}.download`);
	const extractDir = join(binDir, `.extract-${tool.id}-${unique}`);
	const fileName = binaryFileName(tool, plat);
	const stagedPaths: string[] = [];

	try {
		options.onProgress?.(`downloading ${asset}`);
		await downloadFile(url, archivePath, options);
		const { digest, verified } = await verifyArchive(tool, version, asset, archivePath, options);

		const stagedFiles: Array<{ staged: string; target: string }> = [];
		if (tool.raw) {
			// Some projects publish the executable with no archive around it (jq,
			// yq), so staging the download IS the extraction step.
			const stagedPath = join(binDir, `.${fileName}.${unique}.new`);
			renameSync(archivePath, stagedPath);
			// Registered before chmod: a failing chmod must not leak the file.
			stagedPaths.push(stagedPath);
			if (plat !== "win32") chmodSync(stagedPath, 0o755);
			stagedFiles.push({ staged: stagedPath, target: join(binDir, fileName) });
		} else {
			mkdirSync(extractDir, { recursive: true });
			if (asset.endsWith(".tar.gz") || asset.endsWith(".tgz")) {
				const failure = runExtraction("tar", ["xzf", archivePath, "-C", extractDir]);
				if (failure) throw new Error(`Failed to extract ${asset}: ${failure}`);
			} else if (asset.endsWith(".zip")) {
				extractZip(archivePath, extractDir);
			} else {
				throw new Error(`Unsupported archive format: ${asset}`);
			}

			// One archive can provide several commands (ast-grep ships both ast-grep
			// and sg), so every declared name is staged before any is installed.
			for (const name of tool.provides ?? [tool.binaryName]) {
				const archiveName = name + (plat === "win32" ? ".exe" : "");
				const extracted = findFileRecursively(extractDir, archiveName);
				if (!extracted) throw new Error(`Binary not found in archive: expected ${archiveName} in ${asset}`);
				const stagedPath = join(binDir, `.${archiveName}.${unique}.new`);
				renameSync(extracted, stagedPath);
				stagedPaths.push(stagedPath);
				if (plat !== "win32") chmodSync(stagedPath, 0o755);
				stagedFiles.push({ staged: stagedPath, target: join(binDir, archiveName) });
			}
		}

		const installedPath = join(binDir, fileName);
		// The whole bundle is installed and probed as one unit; see installBundle.
		const detected = installBundle(
			stagedFiles.map((entry) => ({ ...entry, primary: entry.target === installedPath })),
			plat,
			tool,
			unique,
			binDir,
		);
		stagedPaths.length = 0;
		// A tool whose build string lags its tag is recorded at the tag version.
		return {
			path: installedPath,
			version: tool.trustTagVersion ? version : (detected ?? version),
			digest,
			verified,
		};
	} finally {
		// A failed install used to leave a 0755 executable staged in the same
		// directory pi searches first.
		for (const stagedPath of stagedPaths) rmSync(stagedPath, { force: true });
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}
}

// =============================================================================
// Reports
// =============================================================================

export type ToolAction = "installed" | "updated" | "reinstalled" | "unchanged" | "failed" | "skipped";

export interface ToolReport {
	tool: ToolId;
	name: string;
	action: ToolAction;
	/** Whether this tool publishes a release for the current platform. */
	supported: boolean;
	/** pi built-in tools that resolve this binary; empty means PATH-only. */
	consumedBy: string[];
	/** Managed binary in pi's bin directory, when one exists after the call. */
	path?: string;
	version?: string;
	previousVersion?: string;
	/** Latest upstream version, when it could be resolved. */
	latest?: string;
	systemPath?: string;
	/** sha256 recorded for the archive this binary came from. */
	digest?: string;
	/** False only when an archive could not be verified and the opt-out allowed it. */
	verified?: boolean;
	/** Set when the installed binary is present but cannot execute. */
	damaged?: string;
	error?: string;
}

export interface Report {
	plat: string;
	architecture: string;
	supported: boolean;
	binDir: string;
	checkedAt: number;
	tools: ToolReport[];
}

interface SharedOptions extends NetworkOptions {
	binDir: string;
	plat?: string;
	architecture?: string;
	/** Override the fail-closed digest policy for this call. */
	allowUnverified?: boolean;
}

function localState(tool: ManagedTool, binDir: string, plat: string, state: CheckState | undefined) {
	const path = managedBinaryPath(tool, binDir, plat);
	const installed = existsSync(path);
	// Every name the archive provides is checked, not just the primary: a bundled
	// shim can rot on its own (ast-grep's `sg` execs its sibling and breaks if that
	// sibling is replaced by something that is not there or will not run).
	const problems: string[] = [];
	let version: string | undefined;
	for (const name of tool.provides ?? [tool.binaryName]) {
		const binaryPath = join(binDir, name + (plat === "win32" ? ".exe" : ""));
		const isPrimary = binaryPath === path;
		if (!existsSync(binaryPath)) {
			// A missing primary is "not installed". A missing secondary only counts
			// when the primary is there: otherwise this is a fresh install, not
			// damage, and a repair would never be the right action.
			if (!isPrimary && installed) problems.push(`${name} missing`);
			continue;
		}
		const probe = probeBinary(binaryPath, binDir);
		if (!probe.ran) problems.push(`${name} does not execute`);
		if (isPrimary) version = probe.version;
	}
	const recorded = installed ? state?.installed?.[tool.id] : undefined;
	// For a tool that misreports its own build number, the recorded release tag is
	// the only trustworthy version; otherwise every check would reinstall it.
	const installedVersion = tool.trustTagVersion ? (recorded ?? version) : (version ?? recorded);
	return {
		path: installed ? path : undefined,
		version: installedVersion,
		damaged: problems.length > 0 ? problems.join(", ") : undefined,
		systemPath: findSystemBinary(tool, plat),
	};
}

/** Resolve a user-supplied tool name or id, for the reinstall argument. */
export function findToolId(name: string): ToolId | undefined {
	const wanted = name.trim().toLowerCase();
	if (!wanted) return undefined;
	return MANAGED_TOOL_IDS.find((id) => {
		const tool = MANAGED_TOOLS[id];
		const names = [id, tool.name.toLowerCase(), ...(tool.provides ?? []).map((provided) => provided.toLowerCase())];
		return names.includes(wanted);
	});
}

export async function inspectTools(options: SharedOptions & { checkLatest?: boolean }): Promise<Report> {
	const plat = options.plat ?? platform();
	const architecture = options.architecture ?? arch();
	const checkedAt = Date.now();
	const state = readState(options.binDir);

	const tools = await Promise.all(
		MANAGED_TOOL_IDS.map(async (toolId): Promise<ToolReport> => {
			const tool = MANAGED_TOOLS[toolId];
			const local = localState(tool, options.binDir, plat, state);
			const supported = targetFor(tool, plat, architecture) !== undefined;
			const report: ToolReport = {
				tool: toolId,
				name: tool.name,
				action: "unchanged",
				supported,
				consumedBy: [...tool.consumedBy],
				path: local.path,
				version: local.version,
				damaged: local.damaged,
				systemPath: local.systemPath,
			};
			if (options.checkLatest === false || !supported) return report;
			try {
				report.latest = await fetchLatestVersion(tool, options);
			} catch (error) {
				report.error = errorMessage(error);
			}
			return report;
		}),
	);

	return {
		plat,
		architecture,
		supported: tools.some((tool) => tool.supported),
		binDir: options.binDir,
		checkedAt,
		tools,
	};
}

export type ReinstallRequest = "damaged" | "all" | ToolId[];

export async function updateTools(
	options: SharedOptions & { onProgress?: (message: string) => void; reinstall?: ReinstallRequest },
): Promise<Report> {
	const plat = options.plat ?? platform();
	const architecture = options.architecture ?? arch();
	const checkedAt = Date.now();
	const force = options.reinstall;

	const tools: ToolReport[] = [];
	const state = readState(options.binDir);
	for (const toolId of MANAGED_TOOL_IDS) {
		const tool = MANAGED_TOOLS[toolId];
		const local = localState(tool, options.binDir, plat, state);
		const target = targetFor(tool, plat, architecture);
		const report: ToolReport = {
			tool: toolId,
			name: tool.name,
			action: "unchanged",
			supported: target !== undefined,
			consumedBy: [...tool.consumedBy],
			path: local.path,
			version: local.version,
			damaged: local.damaged,
			systemPath: local.systemPath,
		};
		tools.push(report);

		if (!target) {
			report.action = "skipped";
			report.error = `no prebuilt release for ${plat}/${architecture}`;
			continue;
		}

		// A forced reinstall ignores the version comparison: the point is to replace
		// a file that is broken, not one that is merely older.
		const forced =
			force === "all" ||
			(force === "damaged" ? local.damaged !== undefined : Array.isArray(force) && force.includes(toolId));
		const wasDamaged = local.damaged !== undefined;

		try {
			report.latest = await fetchLatestVersion(tool, options);
		} catch (error) {
			// Reinstalling still works offline from the version already on disk, which
			// is exactly when a repair is most likely to be needed.
			if (!forced || !report.version) {
				report.action = "failed";
				report.error = errorMessage(error);
				continue;
			}
			report.latest = report.version;
		}

		// A damaged binary is never "up to date", whatever version it claims. The
		// state fallback supplies a version for a tool that cannot self-report, so
		// without this check a broken gron would compare equal and never be fixed.
		if (
			!forced &&
			!wasDamaged &&
			report.version &&
			compareVersions(report.version, report.latest) >= 0
		) {
			continue;
		}

		try {
			const result = await installTool(toolId, report.latest, options);
			report.previousVersion = report.version;
			report.version = result.version;
			report.path = result.path;
			report.digest = result.digest;
			report.verified = result.verified;
			// The probe that matters is the one installBinary just ran.
			report.damaged = undefined;
			report.action = forced || wasDamaged ? "reinstalled" : report.previousVersion ? "updated" : "installed";
		} catch (error) {
			report.action = "failed";
			report.error = errorMessage(error);
		}
	}

	const report: Report = {
		plat,
		architecture,
		supported: tools.some((tool) => tool.supported),
		binDir: options.binDir,
		checkedAt,
		tools,
	};
	// Persist here rather than leaving it to the caller: a tool that cannot report
	// its own version (gron) is compared against this record, so a caller that
	// forgets to write it reinstalls that tool on every single run.
	//
	// An all-failed run does not advance the timestamp: otherwise one rate-limited
	// or offline cycle would defer the next attempt for the whole interval, which
	// is the opposite of what a broken machine needs.
	const supportedReports = tools.filter((tool) => tool.supported);
	const allFailed = supportedReports.length > 0 && supportedReports.every((tool) => tool.action === "failed");
	writeState(options.binDir, report, { advance: !allFailed });
	return report;
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		const messages = [error.message];
		for (let current = error.cause, depth = 0; current instanceof Error && depth < 3; current = current.cause, depth++) {
			if (!messages.includes(current.message)) messages.push(current.message);
		}
		return messages.join(": ");
	}
	return String(error);
}

// =============================================================================
// Check state and settings
// =============================================================================

export interface CheckState {
	checkedAt: number;
	latest: Partial<Record<ToolId, string>>;
	/**
	 * Versions this package last installed. A tool whose binary cannot report its
	 * own version (gron) is compared against this instead, so it is not reinstalled
	 * on every check.
	 */
	installed?: Partial<Record<ToolId, string>>;
	/**
	 * Last failure per tool. Without this a tool that cannot install on this host
	 * (no digest published, wrong libc, an upstream rename) keeps its binary
	 * missing, and a missing binary forces a full update cycle on every start.
	 */
	failures?: Partial<Record<ToolId, { at: number; reason: string }>>;
	/** sha256 accepted for the installed binary, so a later check can compare. */
	digests?: Partial<Record<ToolId, string>>;
	/** Tools whose installed binary was never confirmed against a digest. */
	unverified?: Partial<Record<ToolId, boolean>>;
}

export function statePath(binDir: string): string {
	return join(binDir, STATE_FILE);
}

export function readState(binDir: string): CheckState | undefined {
	try {
		const parsed = JSON.parse(readFileSync(statePath(binDir), "utf-8")) as Partial<CheckState>;
		if (typeof parsed?.checkedAt !== "number") return undefined;
		return {
			checkedAt: parsed.checkedAt,
			latest: parsed.latest ?? {},
			installed: parsed.installed ?? {},
			failures: parsed.failures ?? {},
			digests: parsed.digests ?? {},
			unverified: parsed.unverified ?? {},
		};
	} catch {
		return undefined;
	}
}

export function writeState(binDir: string, report: Report, options: { advance?: boolean } = {}): void {
	try {
		mkdirSync(binDir, { recursive: true });
		const previous = readState(binDir);
		const latest: Partial<Record<ToolId, string>> = { ...previous?.latest };
		for (const tool of report.tools) if (tool.latest) latest[tool.tool] = tool.latest;
		// Only overwrite an installed version with a version we actually saw; a
		// status check that resolved nothing must not erase it.
		const installed: Partial<Record<ToolId, string>> = { ...previous?.installed };
		for (const tool of report.tools) if (tool.version) installed[tool.tool] = tool.version;
		const failures: Partial<Record<ToolId, { at: number; reason: string }>> = { ...previous?.failures };
		const digests: Partial<Record<ToolId, string>> = { ...previous?.digests };
		const unverified: Partial<Record<ToolId, boolean>> = { ...previous?.unverified };
		for (const tool of report.tools) {
			if (tool.action === "failed") {
				failures[tool.tool] = { at: report.checkedAt, reason: tool.error ?? "unknown error" };
			} else if (tool.action !== "skipped") {
				// Any other outcome means the tool is usable; forget the failure.
				delete failures[tool.tool];
			}
			if (tool.digest) digests[tool.tool] = tool.digest;
			if (tool.verified === false) unverified[tool.tool] = true;
			else if (tool.verified === true) delete unverified[tool.tool];
		}
		// A run where everything failed still records per-tool failures, so a host
		// that cannot install a tool stops retrying it, but it must not move
		// checkedAt: that would defer the next real attempt for a whole interval.
		const checkedAt = options.advance === false ? (previous?.checkedAt ?? report.checkedAt) : report.checkedAt;
		const state: CheckState = { checkedAt, latest, installed, failures, digests, unverified };
		const path = statePath(binDir);
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
		renameSync(temporary, path);
	} catch {
		// A missing state file only costs an extra check next start.
	}
}

/**
 * Whether to look for newer releases now. A missing managed binary always
 * triggers a check: pi would otherwise download it itself with no version
 * comparison at all.
 */
export function shouldCheck(
	state: CheckState | undefined,
	intervalHours: number,
	binDir: string,
	plat: string = platform(),
	architecture: string = arch(),
	now = Date.now(),
): boolean {
	if (intervalHours <= 0) return true;
	const intervalMs = intervalHours * 60 * 60 * 1000;
	for (const toolId of MANAGED_TOOL_IDS) {
		const tool = MANAGED_TOOLS[toolId];
		// A tool with no release for this platform can never be installed here, so
		// its missing binary must not force a network check on every single start.
		if (targetFor(tool, plat, architecture) === undefined) continue;
		if (existsSync(managedBinaryPath(tool, binDir, plat))) continue;
		// Same reasoning for a tool that just failed: retrying it on every start
		// turns one uninstallable tool into a full download cycle each time.
		const failure = state?.failures?.[toolId];
		if (failure && now - failure.at >= 0 && now - failure.at < intervalMs) continue;
		return true;
	}
	if (!state) return true;
	const elapsed = now - state.checkedAt;
	return !(elapsed >= 0 && elapsed < intervalMs);
}

export interface ToolSettings {
	enabled: boolean;
	intervalHours: number;
	/** Rewrite absolute host paths to bare names on bash tool calls. */
	rewritePaths: boolean;
}

/** Every name this package installs, including provided secondaries (sg, uvx). */
export function managedBinaryNames(): Set<string> {
	const names = new Set<string>();
	for (const id of MANAGED_TOOL_IDS) {
		const tool = MANAGED_TOOLS[id];
		names.add(tool.binaryName);
		for (const name of tool.provides ?? []) names.add(name);
	}
	return names;
}

const HOST_BIN_DIRS = ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"];

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace an absolute host path for a managed tool with its bare name.
 *
 * `/usr/bin/jq -r .a` becomes `jq -r .a`, so the packaged binary runs instead of
 * the host's older build. Only a token in command position is touched (start of
 * string, or after whitespace, `;`, `|`, `&`, `(`), so `echo "/usr/bin/jq"` is
 * left alone, and only names this package manages, so `/usr/bin/tar` is untouched.
 */
export function rewriteToolPaths(
	command: string,
	names: Set<string> = managedBinaryNames(),
	extraDirs: string[] = [],
): { command: string; rewrites: string[] } {
	const rewrites: string[] = [];
	let out = command;
	for (const dir of [...HOST_BIN_DIRS, ...extraDirs]) {
		const pattern = new RegExp(`(^|[\\s;|&(])${escapeRegExp(dir)}/([A-Za-z0-9._+-]+)`, "g");
		out = out.replace(pattern, (match, lead: string, name: string) => {
			if (!names.has(name)) return match;
			rewrites.push(`${dir}/${name}`);
			return `${lead}${name}`;
		});
	}
	return { command: out, rewrites };
}

function isOffline(env: NodeJS.ProcessEnv): boolean {
	const value = (env.PI_OFFLINE ?? "").toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

export function readSettings(env: NodeJS.ProcessEnv = process.env): ToolSettings {
	const raw = (env.PI_MANAGED_TOOLS ?? "").trim().toLowerCase();
	const disabled = raw === "0" || raw === "off" || raw === "false" || raw === "no";
	const interval = Number(env.PI_MANAGED_TOOLS_INTERVAL_HOURS);
	const rewriteRaw = (env.PI_MANAGED_TOOLS_REWRITE ?? "").trim().toLowerCase();
	const rewriteOff = rewriteRaw === "0" || rewriteRaw === "off" || rewriteRaw === "false" || rewriteRaw === "no";
	return {
		enabled: !disabled && !isOffline(env),
		intervalHours: Number.isFinite(interval) && interval >= 0 ? interval : DEFAULT_INTERVAL_HOURS,
		rewritePaths: !rewriteOff,
	};
}
