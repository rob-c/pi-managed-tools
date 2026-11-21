/**
 * Tests for the release-resolution, install and cooldown logic.
 *
 * Everything runs offline: the GitHub endpoints are replaced by a fake fetch
 * that serves real release archives built in a temp directory, so the download,
 * extraction, staging and rename steps are exercised for real.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	allowUnverified,
	compareVersions,
	fetchAssetDigest,
	fetchLatestVersion,
	installTool,
	inspectTools,
	MANAGED_TOOL_IDS,
	MANAGED_TOOLS,
	parseVersion,
	readSettings,
	readState,
	readToolVersion,
	findToolId,
	releaseTarget,
	rewriteToolPaths,
	sha256File,
	shouldCheck,
	statePath,
	targetFor,
	type ToolId,
	updateTools,
	writeState,
} from "../src/tools.ts";

const DARWIN_ARM = { plat: "darwin", architecture: "arm64" };
const TARGET = "aarch64-apple-darwin.tar.gz";
const onlyOnPosix: { skip?: string } = process.platform === "win32" ? { skip: "fixtures are shell scripts" } : {};

/** Latest version per repo, as the stub release API reports it. */
const FIXTURE_VERSIONS: Record<string, string> = {
	"sharkdp/fd": "10.5.2",
	"BurntSushi/ripgrep": "15.2.0",
	"sharkdp/bat": "0.26.1",
	"j178/prek": "0.5.11",
	"rtk-ai/rtk": "1.2.1",
	"casey/just": "1.59.0",
	"tomnomnom/gron": "0.7.1",
	"koalaman/shellcheck": "0.11.0",
	"ast-grep/ast-grep": "0.51.3",
	"ninja-build/ninja": "1.13.2",
	"jqlang/jq": "1.8.2",
	"mikefarah/yq": "4.54.3",
	"junegunn/fzf": "0.75.0",
	"astral-sh/uv": "0.13.9",
	"cli/cli": "2.105.0",
	"gastownhall/beads": "1.3.4",
	"vercel-labs/agent-browser": "0.43.0",
	"astral-sh/ruff": "0.17.6",
	"jdx/mise": "2026.11.11",
	"boyter/scc": "4.1.0",
	"duckdb/duckdb": "2.0.1",
	"johnkerl/miller": "6.22.0",
	"chmln/sd": "1.1.0",
	"Wilfred/difftastic": "0.72.0",
	"rob-c/busybox-static": "1.39.0-aac079e",
};

/** Installed version per tool, equal to FIXTURE_VERSIONS so nothing looks stale. */
const SEEDED_VERSIONS = Object.fromEntries(
	MANAGED_TOOL_IDS.map((id) => [id, FIXTURE_VERSIONS[MANAGED_TOOLS[id].repo]]),
) as Partial<Record<ToolId, string>>;

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "pi-managed-tools-test-"));
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

/** Seed a bin directory with a valid stand-in for every managed tool. */
function seedAllBinaries(
	binDir: string,
	versions: Partial<Record<ToolId, string>> = {},
	plat: string = process.platform,
): void {
	mkdirSync(binDir, { recursive: true });
	for (const toolId of MANAGED_TOOL_IDS) {
		const tool = MANAGED_TOOLS[toolId];
		// Seed every name the archive provides, not just the primary: a bundle with
		// a missing shim is reported as damaged.
		for (const provided of tool.provides ?? [tool.binaryName]) {
			const path = join(binDir, provided + (plat === "win32" ? ".exe" : ""));
			writeFileSync(path, `#!/bin/sh\necho "${tool.name} ${versions[toolId] ?? "1.0.0"}"\n`);
			chmodSync(path, 0o755);
		}
	}
}

/** Build the archive upstream publishes, in whatever layout that tool uses. */
function buildReleaseArchive(
	toolId: ToolId,
	version: string,
	plat = "darwin",
	architecture = "arm64",
	broken: string[] = [],
): string {
	const tool = MANAGED_TOOLS[toolId];
	const target = targetFor(tool, plat, architecture);
	assert.ok(target, `${toolId} has no release for ${plat}/${architecture}`);
	const asset = tool.assetName(version, target);
	const bannerFor = (name: string) =>
		broken.includes(name) ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\necho "${bannerText}"\n`;
	const bannerText =
		toolId === "rg"
			? `ripgrep ${version} (rev abc123)`
			: toolId === "gron"
				? "gron version dev" // gron's release build embeds no version at all
				: `${tool.name} ${version}`;

	if (tool.raw) {
		// The release asset is the executable itself, with no archive.
		const path = join(workDir, asset);
		writeFileSync(path, bannerFor(tool.binaryName));
		chmodSync(path, 0o755);
		return path;
	}

	const root = asset.replace(/\.(tar\.gz|tgz|zip)$/, "");
	const stage = join(workDir, `stage-${toolId}-${asset}`);
	const inner = join(stage, root);
	mkdirSync(inner, { recursive: true });

	for (const name of tool.provides ?? [tool.binaryName]) {
		const binary = join(inner, name);
		writeFileSync(binary, bannerFor(name));
		chmodSync(binary, 0o755);
	}

	const archive = join(stage, asset);
	const packaged = asset.endsWith(".zip")
		? spawnSync("zip", ["-qr", archive, root], { cwd: stage, encoding: "utf-8" })
		: spawnSync("tar", ["czf", archive, "-C", stage, root], { encoding: "utf-8" });
	assert.equal(packaged.status, 0, packaged.stderr);

	const bytes = readFileSync(archive);
	rmSync(stage, { recursive: true, force: true });
	writeFileSync(join(workDir, asset), bytes);
	return join(workDir, asset);
}

interface FakeFetchOptions {
	latest: Record<string, string>;
	assets?: Record<string, string>;
	/** Asset name -> digest hex to serve instead of the real one, to force a mismatch. */
	wrongDigest?: Record<string, string>;
	/** Serve assets with no digest field at all. */
	noDigest?: boolean;
}

/**
 * A fetch stand-in: `latest` maps a repo to a tag, `assets` maps a download
 * URL to a file on disk, and the release API is synthesised from those files so
 * digests are the real sha256 of the bytes being served. Records every URL so
 * tests can assert on network use.
 */
function fakeFetch(options: FakeFetchOptions): {
	fetchImpl: typeof fetch;
	calls: string[];
} {
	const calls: string[] = [];
	const fetchImpl = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push(url);

		const latestMatch = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/latest$/);
		if (latestMatch) {
			const repo = latestMatch[1] as string;
			const tag = options.latest[repo];
			if (!tag) return new Response("not found", { status: 404 });
			const tool = Object.values(MANAGED_TOOLS).find((entry) => entry.repo === repo);
			return new Response(null, {
				status: 302,
				headers: { location: `https://github.com/${repo}/releases/tag/${tool?.tagPrefix ?? ""}${tag}` },
			});
		}

		const tagMatch = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases\/tags\/(.+)$/);
		if (tagMatch) {
			const repo = tagMatch[1] as string;
			const tag = decodeURIComponent(tagMatch[2] as string);
			const assets: Array<{ name: string; digest?: string }> = [];
			for (const [downloadUrl, file] of Object.entries(options.assets ?? {})) {
				const parsed = downloadUrl.match(
					/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/(.+)$/,
				);
				if (!parsed || parsed[1] !== repo || parsed[2] !== tag) continue;
				const name = parsed[3] as string;
				if (options.noDigest) {
					assets.push({ name });
					continue;
				}
				assets.push({ name, digest: `sha256:${options.wrongDigest?.[name] ?? sha256File(file)}` });
			}
			if (assets.length === 0) return new Response("not found", { status: 404 });
			return new Response(JSON.stringify({ assets }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}

		const assetPath = options.assets?.[url];
		if (assetPath) {
			return new Response(readFileSync(assetPath), { status: 200 });
		}
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

describe("release targets", () => {
	test("maps the platforms pi itself downloads for", () => {
		assert.equal(releaseTarget("darwin", "arm64"), "aarch64-apple-darwin.tar.gz");
		assert.equal(releaseTarget("darwin", "x64"), "x86_64-apple-darwin.tar.gz");
		assert.equal(releaseTarget("linux", "arm64"), "aarch64-unknown-linux-musl.tar.gz");
		assert.equal(releaseTarget("linux", "x64"), "x86_64-unknown-linux-musl.tar.gz");
		assert.equal(releaseTarget("win32", "x64"), "x86_64-pc-windows-msvc.zip");
		assert.equal(releaseTarget("win32", "arm64"), "aarch64-pc-windows-msvc.zip");
	});

	test("refuses architectures without a prebuilt release rather than falling back to x86-64", () => {
		assert.equal(releaseTarget("linux", "arm"), undefined);
		assert.equal(releaseTarget("linux", "ia32"), undefined);
		assert.equal(releaseTarget("darwin", "ppc64"), undefined);
		assert.equal(releaseTarget("freebsd", "x64"), undefined);
	});

	test("asset names match the two projects' release pages", () => {
		assert.equal(MANAGED_TOOLS.fd.assetName("10.5.2", TARGET), "fd-v10.5.2-aarch64-apple-darwin.tar.gz");
		assert.equal(MANAGED_TOOLS.rg.assetName("15.2.0", TARGET), "ripgrep-15.2.0-aarch64-apple-darwin.tar.gz");
	});
});

describe("versions", () => {
	test("reads the version out of each tool's --version banner", () => {
		assert.equal(parseVersion("fd 10.5.2\n"), "10.5.2");
		assert.equal(parseVersion("ripgrep 15.2.0 (rev e89fff89ac)\n"), "15.2.0");
		assert.equal(parseVersion("fd 10.5.2-foo\n"), "10.5.2-foo");
	});

	test("returns undefined for output with no version", () => {
		assert.equal(parseVersion("fd\n"), undefined);
		assert.equal(parseVersion(""), undefined);
	});

	test("orders versions numerically, not as strings", () => {
		assert.equal(compareVersions("10.5.2", "10.5.1"), 1);
		assert.equal(compareVersions("10.5.9", "10.5.10"), -1);
		assert.equal(compareVersions("15.2.0", "15.2.0"), 0);
		assert.equal(compareVersions("9.1.0", "10.0.0"), -1);
		// A release outranks a prerelease of the same core version.
		assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
		assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
	});
});

describe("latest release lookup", () => {
	test("follows the release redirect and drops the v prefix", async () => {
		const { fetchImpl, calls } = fakeFetch({ latest: { "sharkdp/fd": "10.5.2" } });
		assert.equal(await fetchLatestVersion(MANAGED_TOOLS.fd, { fetchImpl }), "10.5.2");
		assert.deepEqual(calls, ["https://github.com/sharkdp/fd/releases/latest"]);
	});

	test("ripgrep tags carry no prefix", async () => {
		const { fetchImpl } = fakeFetch({ latest: { "BurntSushi/ripgrep": "15.2.0" } });
		assert.equal(await fetchLatestVersion(MANAGED_TOOLS.rg, { fetchImpl }), "15.2.0");
	});

	test("falls back to the GitHub API when GitHub answers without a redirect", async () => {
		const fetchImpl = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "https://github.com/sharkdp/fd/releases/latest") {
				return new Response("<html>rate limited</html>", { status: 200 });
			}
			if (url === "https://api.github.com/repos/sharkdp/fd/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "v10.5.2" }), { status: 200 });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;
		assert.equal(await fetchLatestVersion(MANAGED_TOOLS.fd, { fetchImpl }), "10.5.2");
	});

	test("surfaces an HTTP failure instead of guessing a version", async () => {
		const fetchImpl = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
		await assert.rejects(() => fetchLatestVersion(MANAGED_TOOLS.fd, { fetchImpl }), /HTTP 404|HTTP 403/);
	});
});

describe("install", () => {
	test("installs the release binary where pi looks for it", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin");
		const fdArchive = buildReleaseArchive("fd", "10.5.2");
		const { fetchImpl } = fakeFetch({
			latest: { "sharkdp/fd": "10.5.2" },
			assets: {
				"https://github.com/sharkdp/fd/releases/download/v10.5.2/fd-v10.5.2-aarch64-apple-darwin.tar.gz":
					fdArchive,
			},
		});

		const result = await installTool("fd", "10.5.2", { binDir, fetchImpl, ...DARWIN_ARM });

		assert.equal(result.path, join(binDir, "fd"));
		assert.equal(result.version, "10.5.2");
		assert.equal(readToolVersion(join(binDir, "fd")), "10.5.2");
		// Nothing but the binary survives: no archive, no staging directory.
		assert.deepEqual(readdirSync(binDir), ["fd"]);
	});

	test("replaces an old binary atomically and leaves one copy behind", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(binDir, "fd"), '#!/bin/sh\necho "fd 10.5.1"\n');
		chmodSync(join(binDir, "fd"), 0o755);

		const fdArchive = buildReleaseArchive("fd", "10.5.2");
		const { fetchImpl } = fakeFetch({
			latest: { "sharkdp/fd": "10.5.2" },
			assets: {
				"https://github.com/sharkdp/fd/releases/download/v10.5.2/fd-v10.5.2-aarch64-apple-darwin.tar.gz":
					fdArchive,
			},
		});

		await installTool("fd", "10.5.2", { binDir, fetchImpl, ...DARWIN_ARM });

		assert.equal(readToolVersion(join(binDir, "fd")), "10.5.2");
		assert.deepEqual(readdirSync(binDir), ["fd"]);
	});

	test("reports the unsupported platform before touching the network", async () => {
		const { fetchImpl, calls } = fakeFetch({ latest: {} });
		await assert.rejects(
			() => installTool("fd", "10.5.2", { binDir: join(workDir, "bin"), fetchImpl, plat: "linux", architecture: "arm" }),
			/linux\/arm/,
		);
		assert.deepEqual(calls, []);
	});
});

describe("update", () => {
	test("installs a missing binary", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin");
		const fdArchive = buildReleaseArchive("fd", "10.5.2");
		const rgArchive = buildReleaseArchive("rg", "15.2.0");
		const { fetchImpl } = fakeFetch({
			latest: { "sharkdp/fd": "10.5.2", "BurntSushi/ripgrep": "15.2.0" },
			assets: {
				"https://github.com/sharkdp/fd/releases/download/v10.5.2/fd-v10.5.2-aarch64-apple-darwin.tar.gz":
					fdArchive,
				"https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin.tar.gz":
					rgArchive,
			},
		});

		const report = await updateTools({ binDir, fetchImpl, ...DARWIN_ARM });

		// Only fd and ripgrep have fixtures here; the other three stay failed.
		assert.deepEqual(
			report.tools
				.filter((tool) => tool.tool === "fd" || tool.tool === "rg")
				.map((tool) => [tool.name, tool.action, tool.version]),
			[
				["fd", "installed", "10.5.2"],
				["ripgrep", "installed", "15.2.0"],
			],
		);
	});

	test("updates only the outdated binary and leaves the current one alone", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(binDir, "fd"), '#!/bin/sh\necho "fd 10.5.1"\n');
		writeFileSync(join(binDir, "rg"), '#!/bin/sh\necho "ripgrep 15.2.0 (rev abc)"\n');
		chmodSync(join(binDir, "fd"), 0o755);
		chmodSync(join(binDir, "rg"), 0o755);

		const fdArchive = buildReleaseArchive("fd", "10.5.2");
		const { fetchImpl, calls } = fakeFetch({
			latest: { "sharkdp/fd": "10.5.2", "BurntSushi/ripgrep": "15.2.0" },
			assets: {
				"https://github.com/sharkdp/fd/releases/download/v10.5.2/fd-v10.5.2-aarch64-apple-darwin.tar.gz":
					fdArchive,
			},
		});

		const report = await updateTools({ binDir, fetchImpl, ...DARWIN_ARM });

		assert.equal(report.tools[0]?.action, "updated");
		assert.equal(report.tools[0]?.previousVersion, "10.5.1");
		assert.equal(report.tools[0]?.version, "10.5.2");
		assert.equal(report.tools[1]?.action, "unchanged");
		// The current ripgrep is not downloaded again.
		assert.equal(calls.filter((url) => url.includes("ripgrep/releases/download")).length, 0);
	});

	test("reports a failed download without losing the working binary", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(binDir, "fd"), '#!/bin/sh\necho "fd 10.5.1"\n');
		chmodSync(join(binDir, "fd"), 0o755);

		const { fetchImpl } = fakeFetch({ latest: { "sharkdp/fd": "10.5.2" } });
		const report = await updateTools({ binDir, fetchImpl, ...DARWIN_ARM });

		assert.equal(report.tools[0]?.action, "failed");
		assert.match(report.tools[0]?.error ?? "", /404/);
		assert.equal(readToolVersion(join(binDir, "fd")), "10.5.1");
	});
});

describe("status", () => {
	test("reports the managed binary pi will use and the latest release", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(binDir, "fd"), '#!/bin/sh\necho "fd 10.5.1"\n');
		chmodSync(join(binDir, "fd"), 0o755);

		const { fetchImpl } = fakeFetch({ latest: { "sharkdp/fd": "10.5.2", "BurntSushi/ripgrep": "15.2.0" } });
		const report = await inspectTools({ binDir, fetchImpl, ...DARWIN_ARM });

		assert.equal(report.binDir, binDir);
		assert.equal(report.supported, true);
		assert.equal(report.tools[0]?.path, join(binDir, "fd"));
		assert.equal(report.tools[0]?.version, "10.5.1");
		assert.equal(report.tools[0]?.latest, "10.5.2");
		assert.equal(report.tools[1]?.path, undefined);
		assert.equal(report.tools[1]?.latest, "15.2.0");
	});

	test("check_latest false stays offline", async () => {
		const fetchImpl = (async () => {
			throw new Error("network must not be touched");
		}) as unknown as typeof fetch;
		const report = await inspectTools({ binDir: join(workDir, "bin"), fetchImpl, checkLatest: false, ...DARWIN_ARM });
		assert.equal(report.tools.every((tool) => tool.latest === undefined), true);
	});
});

describe("check cooldown and settings", () => {
	test("a state file round-trips", async () => {
		const binDir = join(workDir, "bin");
		const { fetchImpl } = fakeFetch({ latest: {} });
		mkdirSync(binDir, { recursive: true });
		const report = await inspectTools({ binDir, fetchImpl, ...DARWIN_ARM });
		writeState(binDir, report);
		const state = readState(binDir);
		assert.ok(state);
		assert.equal(typeof state.checkedAt, "number");
		assert.ok(existsSync(statePath(binDir)));
	});

	test("checks when nothing is installed", () => {
		assert.equal(shouldCheck(undefined, 12, join(workDir, "bin")), true);
	});

	test("skips a check inside the interval and checks again after it", () => {
		const binDir = join(workDir, "bin");
		seedAllBinaries(binDir);

		const now = Date.now();
		assert.equal(shouldCheck({ checkedAt: now, latest: {} }, 12, binDir, "darwin", "arm64", now), false);
		assert.equal(
			shouldCheck({ checkedAt: now - 13 * 60 * 60 * 1000, latest: {} }, 12, binDir, "darwin", "arm64", now),
			true,
		);
		// A clock that jumped backwards must not disable checks forever.
		assert.equal(shouldCheck({ checkedAt: now + 60_000, latest: {} }, 12, binDir, "darwin", "arm64", now), true);
		// Interval 0 means every start.
		assert.equal(shouldCheck({ checkedAt: now, latest: {} }, 0, binDir, "darwin", "arm64", now), true);
	});

	test("a tool that just failed does not force a check on every start", () => {
		const binDir = join(workDir, "bin-failure-memory");
		seedAllBinaries(binDir, SEEDED_VERSIONS);
		rmSync(join(binDir, "gron"), { force: true });
		const now = Date.now();

		// Without a recorded failure a missing binary means "check now".
		assert.equal(shouldCheck({ checkedAt: now, latest: {} }, 12, binDir, "darwin", "arm64", now), true);
		// With one it waits out the interval, so one uninstallable tool cannot drag
		// a full download cycle into every single start.
		assert.equal(
			shouldCheck(
				{ checkedAt: now, latest: {}, failures: { gron: { at: now, reason: "no digest published" } } },
				12,
				binDir,
				"darwin",
				"arm64",
				now,
			),
			false,
		);
		// An old failure is retried.
		assert.equal(
			shouldCheck(
				{
					checkedAt: now - 13 * 60 * 60 * 1000,
					latest: {},
					failures: { gron: { at: now - 13 * 60 * 60 * 1000, reason: "x" } },
				},
				12,
				binDir,
				"darwin",
				"arm64",
				now,
			),
			true,
		);
	});

	test("a missing binary forces a check even inside the interval", () => {
		const binDir = join(workDir, "bin");
		seedAllBinaries(binDir);
		rmSync(join(binDir, "prek"), { force: true });
		assert.equal(shouldCheck({ checkedAt: Date.now(), latest: {} }, 12, binDir, "darwin", "arm64"), true);
	});

	test("an asset-name check covers every tool and platform combination", () => {
		// Guards the naming tables against a silent typo: these are the exact
		// strings each project publishes.
		assert.equal(MANAGED_TOOLS.just.assetName("1.59.0", TARGET), "just-1.59.0-aarch64-apple-darwin.tar.gz");
		assert.equal(
			MANAGED_TOOLS.gron.assetName("0.7.1", "darwin-arm64"),
			"gron-darwin-arm64-0.7.1.tgz",
		);
		assert.equal(
			MANAGED_TOOLS.gron.assetName("0.7.1", "windows-amd64"),
			"gron-windows-amd64-0.7.1.zip",
		);
		assert.equal(
			MANAGED_TOOLS.shellcheck.assetName("0.11.0", "darwin.aarch64.tar.gz"),
			"shellcheck-v0.11.0.darwin.aarch64.tar.gz",
		);
		assert.equal(MANAGED_TOOLS.shellcheck.assetName("0.11.0", "zip"), "shellcheck-v0.11.0.zip");
		assert.equal(
			MANAGED_TOOLS["ast-grep"].assetName("0.51.3", "aarch64-apple-darwin.zip"),
			"app-aarch64-apple-darwin.zip",
		);
		// jq, yq: bare executables, no version in the name.
		assert.equal(MANAGED_TOOLS.jq.assetName("1.8.2", "macos-arm64"), "jq-macos-arm64");
		assert.equal(MANAGED_TOOLS.jq.assetName("1.8.2", "windows-amd64"), "jq-windows-amd64.exe");
		assert.equal(MANAGED_TOOLS.yq.assetName("4.54.3", "darwin-arm64"), "yq_darwin_arm64");
		assert.equal(MANAGED_TOOLS.yq.assetName("4.54.3", "windows-amd64"), "yq_windows_amd64.exe");
		// fzf and gh carry the version, and gh changes extension per platform.
		assert.equal(MANAGED_TOOLS.fzf.assetName("0.75.0", "darwin-arm64"), "fzf-0.75.0-darwin_arm64.tar.gz");
		assert.equal(MANAGED_TOOLS.fzf.assetName("0.75.0", "windows-arm64"), "fzf-0.75.0-windows_arm64.zip");
		assert.equal(MANAGED_TOOLS.gh.assetName("2.105.0", "linux_amd64"), "gh_2.105.0_linux_amd64.tar.gz");
		assert.equal(MANAGED_TOOLS.gh.assetName("2.105.0", "macOS_arm64"), "gh_2.105.0_macOS_arm64.zip");
		assert.equal(MANAGED_TOOLS.uv.assetName("0.13.9", TARGET), "uv-aarch64-apple-darwin.tar.gz");
		// beads names its assets after the project, but installs the `bd` binary.
		assert.equal(MANAGED_TOOLS.bd.assetName("1.3.4", "darwin-arm64"), "beads_1.3.4_darwin_arm64.tar.gz");
		assert.equal(MANAGED_TOOLS.bd.assetName("1.3.4", "linux_amd64".replace("_", "-")), "beads_1.3.4_linux_amd64.tar.gz");
		assert.equal(MANAGED_TOOLS.bd.assetName("1.3.4", "windows-arm64"), "beads_1.3.4_windows_arm64.zip");
		// agent-browser: bare executables named os-arch with x64 (not amd64).
		assert.equal(MANAGED_TOOLS["agent-browser"].assetName("0.43.0", "darwin-arm64"), "agent-browser-darwin-arm64");
		assert.equal(MANAGED_TOOLS["agent-browser"].assetName("0.43.0", "win32-x64"), "agent-browser-win32-x64.exe");
		// ruff: Rust triples, bare version tags.
		assert.equal(MANAGED_TOOLS.ruff.assetName("0.17.6", TARGET), "ruff-aarch64-apple-darwin.tar.gz");
		// mise: dated tag repeated in the name, macos/x64 naming.
		assert.equal(MANAGED_TOOLS.mise.assetName("2026.11.11", "macos-arm64"), "mise-v2026.11.11-macos-arm64.tar.gz");
		assert.equal(MANAGED_TOOLS.mise.assetName("2026.11.11", "windows-x64"), "mise-v2026.11.11-windows-x64.zip");
		// scc capitalises the OS and uses underscores; no version in the name.
		assert.equal(MANAGED_TOOLS.scc.assetName("4.1.0", "Darwin_arm64"), "scc_Darwin_arm64.tar.gz");
		assert.equal(MANAGED_TOOLS.scc.assetName("4.1.0", "Windows_x86_64"), "scc_Windows_x86_64.zip");
		// duckdb says osx and amd64; the archive holds a bare duckdb binary.
		assert.equal(MANAGED_TOOLS.duckdb.assetName("2.0.1", "osx-amd64"), "duckdb-cli-osx-amd64.tar.gz");
		// miller names the file after the project but installs mlr.
		assert.equal(MANAGED_TOOLS.miller.binaryName, "mlr");
		assert.equal(MANAGED_TOOLS.miller.assetName("6.22.0", "darwin-arm64"), "miller-6.22.0-darwin-arm64.tar.gz");
		// sd keeps the v in its asset name.
		assert.equal(MANAGED_TOOLS.sd.assetName("1.1.0", "aarch64-apple-darwin"), "sd-v1.1.0-aarch64-apple-darwin.tar.gz");
		// difftastic uses gnu on linux because arm64 has no musl asset.
		assert.equal(
			MANAGED_TOOLS.difftastic.assetName("0.72.0", "aarch64-unknown-linux-gnu"),
			"difft-0.72.0-aarch64-unknown-linux-gnu.tar.gz",
		);
		// busybox: bare binary, no v in the asset despite a v-prefixed tag.
		assert.equal(
			MANAGED_TOOLS.busybox.assetName("1.39.0-aac079e", "darwin-universal"),
			"busybox-static-1.39.0-aac079e-darwin-universal",
		);
		// BusyBox dispatches on argv[0], so the installed name is load-bearing.
		assert.equal(MANAGED_TOOLS.busybox.binaryName, "busybox");
		assert.equal(MANAGED_TOOLS.busybox.raw, true);
		// It reports v1.39.0.git, so only the tag can be compared.
		assert.equal(MANAGED_TOOLS.busybox.trustTagVersion, true);
		assert.equal(MANAGED_TOOLS.ninja.assetName("1.13.2", "mac"), "ninja-mac.zip");
		assert.equal(MANAGED_TOOLS.ninja.assetName("1.13.2", "linux-aarch64"), "ninja-linux-aarch64.zip");
	});

	test("maps tool-specific platform naming, including the platforms each one lacks", () => {
		// just and ast-grep follow the Rust triple; gron uses Go's amd64/arm64.
		assert.equal(targetFor(MANAGED_TOOLS.just, "linux", "x64"), "x86_64-unknown-linux-musl.tar.gz");
		assert.equal(targetFor(MANAGED_TOOLS.gron, "linux", "x64"), "linux-amd64");
		assert.equal(targetFor(MANAGED_TOOLS.gron, "win32", "arm64"), "windows-arm64");
		assert.equal(targetFor(MANAGED_TOOLS.gron, "linux", "arm"), undefined);
		// shellcheck publishes one arch-less Windows zip, so only x64 is supported.
		assert.equal(targetFor(MANAGED_TOOLS.shellcheck, "win32", "x64"), "zip");
		assert.equal(targetFor(MANAGED_TOOLS.shellcheck, "win32", "arm64"), undefined);
		// ast-grep ships a zip for every platform, including macOS and Linux.
		assert.equal(targetFor(MANAGED_TOOLS["ast-grep"], "darwin", "arm64"), "aarch64-apple-darwin.zip");
		assert.equal(
			targetFor(MANAGED_TOOLS["ast-grep"], "linux", "x64"),
			"x86_64-unknown-linux-musl.zip",
		);
		// ninja: one universal macOS asset for both architectures, per-arch elsewhere.
		assert.equal(targetFor(MANAGED_TOOLS.ninja, "darwin", "arm64"), "mac");
		assert.equal(targetFor(MANAGED_TOOLS.ninja, "darwin", "x64"), "mac");
		assert.equal(targetFor(MANAGED_TOOLS.ninja, "linux", "arm64"), "linux-aarch64");
		assert.equal(targetFor(MANAGED_TOOLS.ninja, "win32", "arm64"), "winarm64");
		assert.equal(targetFor(MANAGED_TOOLS.ninja, "linux", "arm"), undefined);
		// Go-style names for jq/yq/fzf; gh capitalises macOS; uv uses Rust triples.
		assert.equal(targetFor(MANAGED_TOOLS.jq, "darwin", "arm64"), "macos-arm64");
		assert.equal(targetFor(MANAGED_TOOLS.yq, "linux", "x64"), "linux-amd64");
		assert.equal(targetFor(MANAGED_TOOLS.fzf, "darwin", "x64"), "darwin-amd64");
		assert.equal(targetFor(MANAGED_TOOLS.gh, "darwin", "arm64"), "macOS_arm64");
		assert.equal(targetFor(MANAGED_TOOLS.uv, "linux", "x64"), "x86_64-unknown-linux-musl.tar.gz");
		assert.equal(targetFor(MANAGED_TOOLS.jq, "linux", "arm"), undefined);
		assert.equal(targetFor(MANAGED_TOOLS.bd, "darwin", "arm64"), "darwin-arm64");
		assert.equal(targetFor(MANAGED_TOOLS.bd, "linux", "x64"), "linux-amd64");
		assert.equal(targetFor(MANAGED_TOOLS["agent-browser"], "darwin", "x64"), "darwin-x64");
		// The plain linux build needs glibc; only the musl one is statically linked.
		assert.equal(targetFor(MANAGED_TOOLS["agent-browser"], "linux", "arm64"), "linux-musl-arm64");
		assert.equal(targetFor(MANAGED_TOOLS["agent-browser"], "win32", "arm64"), undefined);
		assert.equal(targetFor(MANAGED_TOOLS.mise, "darwin", "arm64"), "macos-arm64");
		assert.equal(targetFor(MANAGED_TOOLS.scc, "linux", "x64"), "Linux_x86_64");
		assert.equal(targetFor(MANAGED_TOOLS.duckdb, "darwin", "x64"), "osx-amd64");
		assert.equal(targetFor(MANAGED_TOOLS.miller, "win32", "arm64"), "windows-arm64");
		assert.equal(targetFor(MANAGED_TOOLS.sd, "win32", "arm64"), undefined);
		assert.equal(targetFor(MANAGED_TOOLS.difftastic, "linux", "arm64"), "aarch64-unknown-linux-gnu");
		// One universal2 macOS asset covers both architectures; no Windows build.
		assert.equal(targetFor(MANAGED_TOOLS.busybox, "darwin", "arm64"), "darwin-universal");
		assert.equal(targetFor(MANAGED_TOOLS.busybox, "darwin", "x64"), "darwin-universal");
		assert.equal(targetFor(MANAGED_TOOLS.busybox, "linux", "x64"), "linux-amd64");
		assert.equal(targetFor(MANAGED_TOOLS.busybox, "win32", "x64"), undefined);
		assert.equal(targetFor(MANAGED_TOOLS.ruff, "linux", "x64"), "x86_64-unknown-linux-musl.tar.gz");
	});

	test("a tool with no release for this platform never forces a check", () => {
		const binDir = join(workDir, "bin");
		seedAllBinaries(binDir, {}, "win32");
		// rtk publishes no aarch64-pc-windows-msvc archive, so its absence there is
		// permanent. It must not make every Windows-on-ARM start hit the network.
		rmSync(join(binDir, "rtk.exe"), { force: true });
		const now = Date.now();
		assert.equal(shouldCheck({ checkedAt: now, latest: {} }, 12, binDir, "win32", "arm64", now), false);
		assert.equal(shouldCheck({ checkedAt: now, latest: {} }, 12, binDir, "win32", "x64", now), true);
	});

	test("settings honour the disable switch, offline mode and the interval", () => {
		assert.deepEqual(readSettings({}), { enabled: true, intervalHours: 12, rewritePaths: true });
		assert.equal(readSettings({ PI_MANAGED_TOOLS: "off" }).enabled, false);
		assert.equal(readSettings({ PI_MANAGED_TOOLS: "0" }).enabled, false);
		assert.equal(readSettings({ PI_OFFLINE: "1" }).enabled, false);
		assert.equal(readSettings({ PI_MANAGED_TOOLS_INTERVAL_HOURS: "0" }).intervalHours, 0);
		assert.equal(readSettings({ PI_MANAGED_TOOLS_INTERVAL_HOURS: "-1" }).intervalHours, 12);
		assert.equal(readSettings({ PI_MANAGED_TOOLS_INTERVAL_HOURS: "nonsense" }).intervalHours, 12);
		// Absolute-path rewriting is on by default and can be switched off.
		assert.equal(readSettings({}).rewritePaths, true);
		assert.equal(readSettings({ PI_MANAGED_TOOLS_REWRITE: "off" }).rewritePaths, false);
		assert.equal(readSettings({ PI_MANAGED_TOOLS_REWRITE: "0" }).rewritePaths, false);
	});
});

describe("extended registry", () => {
	test("asset names match each project's release page, including the version-less ones", () => {
		assert.equal(MANAGED_TOOLS.bat.assetName("0.26.1", TARGET), "bat-v0.26.1-aarch64-apple-darwin.tar.gz");
		// prek and rtk publish no version in the filename, so a version bump must
		// not change the asset the plugin asks for.
		assert.equal(MANAGED_TOOLS.prek.assetName("0.5.11", TARGET), "prek-aarch64-apple-darwin.tar.gz");
		// The plain rtk- build bundles a BUSL-1.1 engine; rtk-oss is the Apache-2.0 build.
		assert.equal(MANAGED_TOOLS.rtk.assetName("1.2.1", TARGET), "rtk-oss-aarch64-apple-darwin.tar.gz");
	});

	test("only fd and ripgrep are consumed by a pi built-in tool", () => {
		assert.deepEqual(MANAGED_TOOLS.fd.consumedBy, ["find"]);
		assert.deepEqual(MANAGED_TOOLS.rg.consumedBy, ["grep"]);
		for (const toolId of ["bat", "prek", "rtk"] as const) {
			assert.deepEqual(MANAGED_TOOLS[toolId].consumedBy, []);
		}
	});

	test("a tool's own platform gate overrides the shared one", () => {
		assert.equal(targetFor(MANAGED_TOOLS.rtk, "win32", "arm64"), undefined);
		assert.equal(targetFor(MANAGED_TOOLS.rtk, "win32", "x64"), "x86_64-pc-windows-msvc.zip");
		assert.equal(targetFor(MANAGED_TOOLS.rtk, "darwin", "arm64"), TARGET);
		// A tool without a gate still refuses an architecture with no prebuilt build.
		assert.equal(targetFor(MANAGED_TOOLS.bat, "linux", "arm"), undefined);
	});

	test("prek on aarch64 debian-named bat is found under either system name", () => {
		assert.deepEqual(MANAGED_TOOLS.bat.systemBinaryNames, ["bat", "batcat"]);
	});

	test("installs every tool, resolving each one's own release layout", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin");
		const versions: Record<string, string> = FIXTURE_VERSIONS;
		const assets: Record<string, string> = {};
		for (const toolId of MANAGED_TOOL_IDS) {
			const tool = MANAGED_TOOLS[toolId];
			const version = versions[tool.repo];
			assert.ok(version, `no fixture version for ${tool.repo}`);
			const target = targetFor(tool, "darwin", "arm64");
			assert.ok(target);
			const archive = buildReleaseArchive(toolId, version);
			assets[
				`https://github.com/${tool.repo}/releases/download/${tool.tagPrefix}${version}/${tool.assetName(version, target)}`
			] = archive;
		}

		const { fetchImpl } = fakeFetch({ latest: versions, assets });
		const report = await updateTools({ binDir, fetchImpl, ...DARWIN_ARM });

		assert.deepEqual(
			report.tools.map((tool) => [tool.name, tool.action]),
			MANAGED_TOOL_IDS.map((id) => [MANAGED_TOOLS[id].name, "installed"]),
		);
		for (const tool of report.tools) {
			assert.match(tool.digest ?? "", /^[0-9a-f]{64}$/);
			assert.equal(tool.verified, true);
			assert.ok(tool.path);
			if (MANAGED_TOOLS[tool.tool].versionOptional) {
				// No version to read back: the requested version is recorded instead.
				assert.equal(tool.version, versions[MANAGED_TOOLS[tool.tool].repo]);
				assert.equal(readToolVersion(tool.path), undefined);
			} else {
				assert.equal(readToolVersion(tool.path), tool.version);
			}
		}
		// uv ships uv and uvx in one archive.
		assert.ok(existsSync(join(binDir, "uv")));
		assert.ok(existsSync(join(binDir, "uvx")));
		// ast-grep ships two commands and both are installed from one archive.
		assert.ok(existsSync(join(binDir, "ast-grep")));
		assert.ok(existsSync(join(binDir, "sg")));
	});

	test("rtk is skipped rather than failed on windows arm64", async () => {
		const { fetchImpl } = fakeFetch({ latest: { "rtk-ai/rtk": "1.2.1" } });
		const report = await inspectTools({
			binDir: join(workDir, "bin"),
			fetchImpl,
			plat: "win32",
			architecture: "arm64",
		});
		const rtk = report.tools.find((tool) => tool.tool === "rtk");
		assert.equal(rtk?.supported, false);
		assert.equal(rtk?.latest, undefined);
		// Other tools on the same platform are still checked.
		assert.equal(report.tools.find((tool) => tool.tool === "fd")?.supported, true);
	});
});

describe("path rewriting", () => {
	test("replaces absolute host paths for managed binaries with bare names", () => {
		assert.equal(rewriteToolPaths("/usr/bin/jq -r .a").command, "jq -r .a");
		assert.equal(rewriteToolPaths("/opt/homebrew/bin/gh pr list").command, "gh pr list");
		assert.equal(rewriteToolPaths("cat <(/usr/bin/jq .x f.json)").command, "cat <(jq .x f.json)");
		assert.equal(rewriteToolPaths("ls && /usr/bin/rg foo").command, "ls && rg foo");
	});

	test("leaves anything that is not a managed binary in command position alone", () => {
		// tar is not managed by this package.
		assert.equal(rewriteToolPaths("/usr/bin/tar xf a.tar").command, "/usr/bin/tar xf a.tar");
		// Inside quotes it is data, not an invocation.
		assert.equal(rewriteToolPaths('echo "/usr/bin/jq"').command, 'echo "/usr/bin/jq"');
		// A path that only looks similar.
		assert.equal(rewriteToolPaths("/usr/bin/jq-config --x").command, "/usr/bin/jq-config --x");
	});

	test("reports what it rewrote, including pi's own bin directory", () => {
		const agentBin = "/Users/someone/.pi/agent/bin";
		const result = rewriteToolPaths(`${agentBin}/rg foo`, undefined, [agentBin]);
		assert.equal(result.command, "rg foo");
		assert.deepEqual(result.rewrites, [`${agentBin}/rg`]);
		assert.deepEqual(rewriteToolPaths("rg foo").rewrites, []);
	});

	test("covers the secondaries this package installs", () => {
		// sg ships inside ast-grep's archive; uvx inside uv's.
		assert.equal(rewriteToolPaths("/usr/bin/sg run -p 'x'").command, "sg run -p 'x'");
		assert.equal(rewriteToolPaths("/usr/bin/uvx ruff check").command, "uvx ruff check");
	});
});

describe("repair", () => {
	test("a plain update repairs a damaged binary instead of comparing versions", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin-auto-repair");
		seedAllBinaries(binDir, SEEDED_VERSIONS);
		// Damaged, but the recorded version equals the latest: a version comparison
		// alone reports this as "up to date" and never fixes it.
		writeFileSync(join(binDir, "bat"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(binDir, "bat"), 0o755);

		const archive = buildReleaseArchive("bat", "0.26.1");
		const { fetchImpl } = fakeFetch({
			latest: FIXTURE_VERSIONS,
			assets: {
				"https://github.com/sharkdp/bat/releases/download/v0.26.1/bat-v0.26.1-aarch64-apple-darwin.tar.gz":
					archive,
			},
		});

		const report = await updateTools({ binDir, fetchImpl, ...DARWIN_ARM });
		const bat = report.tools.find((tool) => tool.tool === "bat");
		assert.equal(bat?.action, "reinstalled");
		assert.equal(readToolVersion(join(binDir, "bat")), "0.26.1");
	});

	test("a run where every tool fails does not advance the check timestamp", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin-all-failed");
		seedAllBinaries(binDir, SEEDED_VERSIONS);
		const stale = Date.now() - 13 * 60 * 60 * 1000;
		writeFileSync(
			statePath(binDir),
			JSON.stringify({ checkedAt: stale, latest: {}, installed: SEEDED_VERSIONS }),
		);

		// Every release lookup 404s: nothing can be resolved, nothing installs.
		const { fetchImpl } = fakeFetch({ latest: {} });
		const report = await updateTools({ binDir, fetchImpl, ...DARWIN_ARM });

		assert.equal(report.tools.every((tool) => tool.action === "failed"), true);
		// The next start must try again rather than waiting out the whole interval.
		assert.equal(readState(binDir)?.checkedAt, stale);
	});

	test("resolves a provided binary to the tool that installs it", () => {
		// `sg` ships inside ast-grep's archive, so repairing it means repairing that tool.
		assert.equal(findToolId("sg"), "ast-grep");
		assert.equal(findToolId("SG"), "ast-grep");
	});

	test("a corrupt secondary shim is reported as damage", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin-sg-damaged");
		seedAllBinaries(binDir, SEEDED_VERSIONS);
		// ast-grep itself is fine; only its shim is broken.
		writeFileSync(join(binDir, "sg"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(binDir, "sg"), 0o755);

		const { fetchImpl } = fakeFetch({ latest: FIXTURE_VERSIONS });
		const report = await inspectTools({ binDir, fetchImpl, ...DARWIN_ARM });
		const astGrep = report.tools.find((tool) => tool.tool === "ast-grep");
		assert.match(astGrep?.damaged ?? "", /sg does not execute/);
	});

	test("a shim deleted on its own is reported as a partial bundle", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin-sg-missing");
		seedAllBinaries(binDir, SEEDED_VERSIONS);
		rmSync(join(binDir, "sg"), { force: true });

		const { fetchImpl } = fakeFetch({ latest: FIXTURE_VERSIONS });
		const report = await inspectTools({ binDir, fetchImpl, ...DARWIN_ARM });
		const astGrep = report.tools.find((tool) => tool.tool === "ast-grep");
		assert.match(astGrep?.damaged ?? "", /sg missing/);
	});

	test("reinstall sg repairs the shim through the tool that owns it", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin-sg-repair");
		seedAllBinaries(binDir, SEEDED_VERSIONS);
		writeFileSync(join(binDir, "sg"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(binDir, "sg"), 0o755);

		const archive = buildReleaseArchive("ast-grep", "0.51.3");
		const { fetchImpl } = fakeFetch({
			latest: FIXTURE_VERSIONS,
			assets: {
				"https://github.com/ast-grep/ast-grep/releases/download/0.51.3/app-aarch64-apple-darwin.zip": archive,
			},
		});
		const target = findToolId("sg");
		assert.equal(target, "ast-grep");
		const report = await updateTools({ binDir, fetchImpl, ...DARWIN_ARM, reinstall: [target as ToolId] });
		const astGrep = report.tools.find((tool) => tool.tool === "ast-grep");
		assert.equal(astGrep?.action, "reinstalled");
		assert.equal(astGrep?.damaged, undefined);
		assert.equal(readToolVersion(join(binDir, "sg")), "0.51.3");
	});

	test("a broken shim in the archive leaves no half-installed bundle", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin-bundle-atomic");
		// The archive extracts fine but its `sg` cannot run.
		const archive = buildReleaseArchive("ast-grep", "0.51.3", "darwin", "arm64", ["sg"]);
		const { fetchImpl } = fakeFetch({
			latest: { "ast-grep/ast-grep": "0.51.3" },
			assets: {
				"https://github.com/ast-grep/ast-grep/releases/download/0.51.3/app-aarch64-apple-darwin.zip": archive,
			},
		});

		await assert.rejects(
			() => installTool("ast-grep", "0.51.3", { binDir, fetchImpl, ...DARWIN_ARM }),
			/did not run: .*sg$/
		);
		// The healthy half must not be left behind.
		assert.equal(existsSync(join(binDir, "ast-grep")), false);
		assert.equal(existsSync(join(binDir, "sg")), false);
	});

	test("a failed tool is remembered in state, and a successful one is forgotten", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin-failure-state");
		seedAllBinaries(binDir, SEEDED_VERSIONS);

		const { fetchImpl } = fakeFetch({ latest: {} });
		await updateTools({ binDir, fetchImpl, ...DARWIN_ARM });
		const afterFailure = readState(binDir);
		assert.ok(afterFailure?.failures?.fd, "a failed tool must be recorded");

		const archive = buildReleaseArchive("fd", "10.5.2");
		const retry = fakeFetch({
			latest: FIXTURE_VERSIONS,
			assets: {
				"https://github.com/sharkdp/fd/releases/download/v10.5.2/fd-v10.5.2-aarch64-apple-darwin.tar.gz": archive,
			},
		});
		await updateTools({ binDir, fetchImpl: retry.fetchImpl, ...DARWIN_ARM });
		assert.equal(readState(binDir)?.failures?.fd, undefined);
	});

	test("a tool whose upstream publishes no digest still installs, marked unverified", onlyOnPosix, async () => {
		// gron's release predates GitHub's per-asset digest field. Fail-closed would
		// make it permanently uninstallable, so it carries a documented exception.
		assert.equal(MANAGED_TOOLS.gron.digestOptional, true);
		const binDir = join(workDir, "bin-gron-unverified");
		const archive = buildReleaseArchive("gron", "0.7.1");
		const { fetchImpl } = fakeFetch({
			latest: { "tomnomnom/gron": "0.7.1" },
			assets: { "https://github.com/tomnomnom/gron/releases/download/v0.7.1/gron-darwin-arm64-0.7.1.tgz": archive },
			noDigest: true,
		});

		const report = await updateTools({ binDir, fetchImpl, ...DARWIN_ARM });
		const gron = report.tools.find((tool) => tool.tool === "gron");
		assert.equal(gron?.action, "installed");
		assert.equal(gron?.verified, false);
		assert.equal(readState(binDir)?.unverified?.gron, true);
	});

	test("digest and verification outcome are persisted for later checks", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin-digest-state");
		const archive = buildReleaseArchive("bat", "0.26.1");
		const { fetchImpl } = fakeFetch({
			latest: { "sharkdp/bat": "0.26.1" },
			assets: {
				"https://github.com/sharkdp/bat/releases/download/v0.26.1/bat-v0.26.1-aarch64-apple-darwin.tar.gz": archive,
			},
		});
		await updateTools({ binDir, fetchImpl, ...DARWIN_ARM });
		const state = readState(binDir);
		assert.equal(state?.digests?.bat, sha256File(archive));
		assert.equal(state?.unverified?.bat, undefined);
	});

	test("a tool whose build string lags its tag is pinned to the tag, not reinstalled forever", onlyOnPosix, async () => {
		// sd 1.1.0 ships a binary that still prints "sd 1.0.0". Without trusting the
		// tag, every check would read 1.0.0, decide it is outdated, and re-download.
		assert.equal(MANAGED_TOOLS.sd.trustTagVersion, true);
		const binDir = join(workDir, "bin-sd-tag");
		seedAllBinaries(binDir, SEEDED_VERSIONS);
		// Overwrite sd with the stale build string its release actually ships.
		writeFileSync(join(binDir, "sd"), '#!/bin/sh\necho "sd 1.0.0"\n');
		chmodSync(join(binDir, "sd"), 0o755);
		writeFileSync(
			statePath(binDir),
			JSON.stringify({ checkedAt: Date.now(), latest: {}, installed: { sd: "1.1.0" } }),
		);

		const archive = buildReleaseArchive("sd", "1.1.0");
		const { fetchImpl, calls } = fakeFetch({
			latest: FIXTURE_VERSIONS,
			assets: {
				"https://github.com/chmln/sd/releases/download/v1.1.0/sd-v1.1.0-aarch64-apple-darwin.tar.gz": archive,
			},
		});
		const report = await updateTools({ binDir, fetchImpl, ...DARWIN_ARM, reinstall: [] });
		const sd = report.tools.find((tool) => tool.tool === "sd");
		assert.equal(sd?.version, "1.1.0");
		assert.equal(sd?.action, "unchanged");
		assert.equal(calls.filter((url) => url.includes("/releases/download/")).length, 0);
	});

	test("resolves a tool by id or by display name", () => {
		assert.equal(findToolId("rg"), "rg");
		assert.equal(findToolId("ripgrep"), "rg");
		assert.equal(findToolId("AST-GREP"), "ast-grep");
		assert.equal(findToolId("  bat "), "bat");
		assert.equal(findToolId("nope"), undefined);
	});

	test("status flags a managed binary that is present but cannot execute", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin-damaged");
		seedAllBinaries(binDir, SEEDED_VERSIONS);
		writeFileSync(join(binDir, "bat"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(binDir, "bat"), 0o755);

		const { fetchImpl } = fakeFetch({ latest: FIXTURE_VERSIONS });
		const report = await inspectTools({ binDir, fetchImpl, ...DARWIN_ARM });

		const damaged = report.tools.filter((tool) => tool.damaged);
		assert.equal(damaged.length, 1);
		assert.equal(damaged[0]?.tool, "bat");
		assert.match(damaged[0]?.damaged ?? "", /does not execute/);
	});

	test("reinstall repairs only the damaged binary", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin-repair");
		seedAllBinaries(binDir, SEEDED_VERSIONS);
		// Present and executable but exits non-zero: the shape a version check misses.
		writeFileSync(join(binDir, "bat"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(binDir, "bat"), 0o755);

		const archive = buildReleaseArchive("bat", "0.26.1");
		const { fetchImpl, calls } = fakeFetch({
			latest: FIXTURE_VERSIONS,
			assets: {
				"https://github.com/sharkdp/bat/releases/download/v0.26.1/bat-v0.26.1-aarch64-apple-darwin.tar.gz":
					archive,
			},
		});

		const report = await updateTools({ binDir, fetchImpl, ...DARWIN_ARM, reinstall: "damaged" });
		const bat = report.tools.find((tool) => tool.tool === "bat");
		assert.equal(bat?.action, "reinstalled");
		assert.equal(bat?.damaged, undefined);
		assert.equal(readToolVersion(join(binDir, "bat")), "0.26.1");
		// Exactly one download, and every healthy tool left alone.
		assert.equal(calls.filter((url) => url.includes("/releases/download/")).length, 1);
		assert.equal(
			report.tools.filter((tool) => tool.action === "unchanged").length,
			MANAGED_TOOL_IDS.length - 1,
		);
	});

	test("reinstall forces a fresh download even when the version already matches", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin-force");
		seedAllBinaries(binDir, SEEDED_VERSIONS);

		const archive = buildReleaseArchive("bat", "0.26.1");
		const { fetchImpl, calls } = fakeFetch({
			latest: FIXTURE_VERSIONS,
			assets: {
				"https://github.com/sharkdp/bat/releases/download/v0.26.1/bat-v0.26.1-aarch64-apple-darwin.tar.gz":
					archive,
			},
		});

		const report = await updateTools({ binDir, fetchImpl, ...DARWIN_ARM, reinstall: ["bat"] });
		const bat = report.tools.find((tool) => tool.tool === "bat");
		assert.equal(bat?.action, "reinstalled");
		assert.equal(bat?.previousVersion, "0.26.1");
		assert.equal(calls.filter((url) => url.includes("/releases/download/")).length, 1);
	});

	test("reinstall with nothing damaged downloads nothing", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin-clean-repair");
		seedAllBinaries(binDir, SEEDED_VERSIONS);

		const { fetchImpl, calls } = fakeFetch({ latest: FIXTURE_VERSIONS });
		const report = await updateTools({ binDir, fetchImpl, ...DARWIN_ARM, reinstall: "damaged" });

		assert.equal(
			report.tools.every((tool) => tool.action === "unchanged"),
			true,
		);
		assert.equal(calls.filter((url) => url.includes("/releases/download/")).length, 0);
	});

	test("a truncated binary is reported damaged rather than as a version", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin-truncated");
		seedAllBinaries(binDir, SEEDED_VERSIONS);
		writeFileSync(join(binDir, "just"), "");
		chmodSync(join(binDir, "just"), 0o755);

		const { fetchImpl } = fakeFetch({ latest: FIXTURE_VERSIONS });
		const report = await inspectTools({ binDir, fetchImpl, ...DARWIN_ARM });
		const just = report.tools.find((tool) => tool.tool === "just");
		assert.match(just?.damaged ?? "", /does not execute/);
	});
});

describe("integrity", () => {
	test("records the digest GitHub published for the archive", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin");
		const archive = buildReleaseArchive("bat", "0.26.1");
		const { fetchImpl } = fakeFetch({
			latest: { "sharkdp/bat": "0.26.1" },
			assets: { "https://github.com/sharkdp/bat/releases/download/v0.26.1/bat-v0.26.1-aarch64-apple-darwin.tar.gz": archive },
		});
		const report = await updateTools({ binDir, fetchImpl, ...DARWIN_ARM });
		assert.equal(report.tools[2]?.action, "installed");
		assert.equal(report.tools[2]?.digest, sha256File(archive));
		// Verified means the digest came from the release API, not from our own file.
		assert.equal(report.tools[2]?.verified, true);
	});

	test("a digest that was not confirmed by the API is reported as unverified", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin-unverified");
		const archive = buildReleaseArchive("bat", "0.26.1");
		const url = "https://github.com/sharkdp/bat/releases/download/v0.26.1/bat-v0.26.1-aarch64-apple-darwin.tar.gz";
		const { fetchImpl } = fakeFetch({ latest: { "sharkdp/bat": "0.26.1" }, assets: { [url]: archive }, noDigest: true });

		const report = await updateTools({ binDir, fetchImpl, ...DARWIN_ARM, allowUnverified: true });
		const bat = report.tools.find((tool) => tool.tool === "bat");
		assert.equal(bat?.action, "installed");
		assert.equal(bat?.verified, false);
	});

	test("refuses an archive whose digest does not match, leaving the old binary working", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin");
		seedAllBinaries(binDir, { fd: "10.5.1" });
		const archive = buildReleaseArchive("fd", "10.5.2");
		const asset = "fd-v10.5.2-aarch64-apple-darwin.tar.gz";
		const { fetchImpl } = fakeFetch({
			latest: { "sharkdp/fd": "10.5.2" },
			assets: { [`https://github.com/sharkdp/fd/releases/download/v10.5.2/${asset}`]: archive },
			wrongDigest: { [asset]: "0".repeat(64) },
		});

		const report = await updateTools({ binDir, fetchImpl, ...DARWIN_ARM });
		const fd = report.tools[0];
		assert.equal(fd?.action, "failed");
		assert.match(fd?.error ?? "", /digest mismatch/);
		// The previous binary is untouched, and no staging artifact was left behind.
		assert.equal(readToolVersion(join(binDir, "fd")), "10.5.1");
		assert.deepEqual(
			readdirSync(binDir).filter(
				(entry) => entry.startsWith(".") && entry !== ".pi-managed-tools.json",
			),
			[],
		);
	});

	test("fails closed when no digest is published, unless explicitly allowed", onlyOnPosix, async () => {
		const archive = buildReleaseArchive("bat", "0.26.1");
		const url = "https://github.com/sharkdp/bat/releases/download/v0.26.1/bat-v0.26.1-aarch64-apple-darwin.tar.gz";
		const { fetchImpl } = fakeFetch({ latest: { "sharkdp/bat": "0.26.1" }, assets: { [url]: archive }, noDigest: true });

		await assert.rejects(
			() =>
				installTool("bat", "0.26.1", {
					binDir: join(workDir, "bin-a"),
					fetchImpl,
					...DARWIN_ARM,
					allowUnverified: false,
				}),
			/allow_unverified|ALLOW_UNVERIFIED/i,
		);

		const result = await installTool("bat", "0.26.1", {
			binDir: join(workDir, "bin-b"),
			fetchImpl,
			...DARWIN_ARM,
			allowUnverified: true,
		});
		assert.equal(result.version, "0.26.1");
		assert.equal(result.digest, sha256File(archive));
		assert.equal(result.verified, false);
	});

	test("rolls back when the installed binary does not run", onlyOnPosix, async () => {
		const binDir = join(workDir, "bin");
		seedAllBinaries(binDir, { fd: "10.5.1" });

		// A real archive whose payload cannot run: extracts cleanly, so only the
		// post-install probe can catch it.
		const asset = "fd-v10.5.2-aarch64-apple-darwin.tar.gz";
		const root = "fd-v10.5.2-aarch64-apple-darwin";
		const stage = join(workDir, "stage-broken");
		const inner = join(stage, root);
		mkdirSync(inner, { recursive: true });
		writeFileSync(join(inner, "fd"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(inner, "fd"), 0o755);
		const archive = join(stage, asset);
		spawnSync("tar", ["czf", archive, "-C", stage, root]);

		const { fetchImpl } = fakeFetch({
			latest: { "sharkdp/fd": "10.5.2" },
			assets: { [`https://github.com/sharkdp/fd/releases/download/v10.5.2/${asset}`]: archive },
		});

		const report = await updateTools({ binDir, fetchImpl, ...DARWIN_ARM });
		assert.equal(report.tools[0]?.action, "failed");
		assert.match(report.tools[0]?.error ?? "", /did not run/);
		assert.equal(readToolVersion(join(binDir, "fd")), "10.5.1");
		// No backup file is left behind in the directory pi searches first.
		assert.deepEqual(
			readdirSync(binDir).filter((entry) => entry.includes("previous")),
			[],
		);
	});

	test("the update path marks an unsupported platform as skipped, not failed", async () => {
		const { fetchImpl } = fakeFetch({ latest: { "rtk-ai/rtk": "1.2.1", "sharkdp/fd": "10.5.2" } });
		const report = await updateTools({
			binDir: join(workDir, "bin-win-arm"),
			fetchImpl,
			plat: "win32",
			architecture: "arm64",
		});
		const rtk = report.tools.find((tool) => tool.tool === "rtk");
		assert.equal(rtk?.supported, false);
		assert.equal(rtk?.action, "skipped");
		// The global verdict stays true because other tools do have a release here.
		assert.equal(report.supported, true);
	});

	test("distinguishes a rate-limited API from a missing digest", onlyOnPosix, async () => {
		const archive = buildReleaseArchive("bat", "0.26.1");
		const url = "https://github.com/sharkdp/bat/releases/download/v0.26.1/bat-v0.26.1-aarch64-apple-darwin.tar.gz";
		const fetchImpl = (async (input: string | URL | Request) => {
			const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (href.includes("api.github.com")) return new Response("rate limited", { status: 403 });
			if (href === url) return new Response(readFileSync(archive), { status: 200 });
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

		await assert.rejects(
			() => installTool("bat", "0.26.1", { binDir: join(workDir, "bin-rl"), fetchImpl, ...DARWIN_ARM }),
			/GITHUB_TOKEN/,
		);
	});

	test("the unverified opt-out reads the documented environment variable", () => {
		assert.equal(allowUnverified({}), false);
		assert.equal(allowUnverified({ PI_MANAGED_TOOLS_ALLOW_UNVERIFIED: "1" }), true);
		assert.equal(allowUnverified({ PI_MANAGED_TOOLS_ALLOW_UNVERIFIED: "YES" }), true);
		assert.equal(allowUnverified({ PI_MANAGED_TOOLS_ALLOW_UNVERIFIED: "0" }), false);
	});

	test("reads the digest out of the release API response", async () => {
		const hex = "a".repeat(64);
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ assets: [{ name: "fd-v10.5.2-aarch64-apple-darwin.tar.gz", digest: `sha256:${hex}` }] }), {
				status: 200,
			})) as unknown as typeof fetch;
		assert.equal(
			await fetchAssetDigest(MANAGED_TOOLS.fd, "10.5.2", "fd-v10.5.2-aarch64-apple-darwin.tar.gz", { fetchImpl }),
			hex,
		);
	});
});
