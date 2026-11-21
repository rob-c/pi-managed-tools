/**
 * Loads the real extension in Node against a stand-in `pi` and a stand-in agent
 * directory, so registration, the `/managed-tools` command and the startup
 * cooldown are exercised without a TUI and without touching the network.
 *
 * The host packages are stubbed, not symlinked: the point of these tests is the
 * extension's own decisions, and `scripts/verify.sh` runs the same extension
 * inside an installed pi for the real thing.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The install fixtures build the darwin/arm64 asset name, and releaseTarget()
 * derives the target from the real host, so these tests only hold there.
 */
const onlyOnDarwinArm: { skip?: string } =
	process.platform === "darwin" && process.arch === "arm64"
		? {}
		: { skip: "fixtures assume the darwin/arm64 release asset" };

const PI_STUB = `export const VERSION = "test";
export function getAgentDir() { return process.env.PI_CODING_AGENT_DIR; }
export function isToolCallEventType(name, event) { return event?.toolName === name; }
`;

const TYPEBOX_STUB = `const f = (...a) => ({ args: a });
export const Type = new Proxy({}, { get: () => f });
`;

const PRELUDE = `
import { pathToFileURL } from "node:url";
const notes = [], statuses = [], tools = {}, commands = {}, handlers = {};
const ui = {
  notify: (message, level) => notes.push([message, level]),
  setStatus: (key, text) => statuses.push([key, text]),
  select: async () => undefined,
  confirm: async () => true,
  input: async () => undefined,
};
const ctx = {
  cwd: process.cwd(), hasUI: true, mode: "tui", ui,
  isIdle: () => true, abort: () => {}, hasPendingMessages: () => false,
  model: { id: "test-model", provider: "test" },
};
const pi = {
  registerTool: (tool) => { tools[tool.name] = tool; },
  registerCommand: (name, command) => { commands[name] = command; },
  registerFlag: () => {}, getFlag: () => undefined,
  on: (event, handler) => { (handlers[event] ??= []).push(handler); },
  exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
};
const extension = (await import(pathToFileURL(new URL("./extension.ts", import.meta.url).pathname).href)).default;
await extension(pi);
const out = (value) => console.log(JSON.stringify(value ?? null));
const tick = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));
`;

interface Scenario {
	stdout: string;
	result: unknown;
}

let temp: string;

beforeEach(() => {
	temp = mkdtempSync(join(tmpdir(), "pi-managed-tools-ext-"));
});

afterEach(() => {
	rmSync(temp, { recursive: true, force: true });
});

/** Copy the extension where a stub `pi`/`typebox` resolve, then run a scenario against it. */
function runScenario(code: string, options: { env?: NodeJS.ProcessEnv; agentDir?: string } = {}): Scenario {
	const extDir = join(temp, "ext");
	mkdirSync(join(extDir, "node_modules", "typebox"), { recursive: true });
	mkdirSync(join(extDir, "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
	writeFileSync(
		join(extDir, "node_modules", "typebox", "package.json"),
		JSON.stringify({ name: "typebox", type: "module", main: "index.js" }),
	);
	writeFileSync(join(extDir, "node_modules", "typebox", "index.js"), TYPEBOX_STUB);
	writeFileSync(
		join(extDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", main: "index.js" }),
	);
	writeFileSync(join(extDir, "node_modules", "@earendil-works", "pi-coding-agent", "index.js"), PI_STUB);

	copyFileSync(join(ROOT, "src", "extension.ts"), join(extDir, "extension.ts"));
	copyFileSync(join(ROOT, "src", "tools.ts"), join(extDir, "tools.ts"));

	const agentDir = options.agentDir ?? join(temp, "agent");
	mkdirSync(agentDir, { recursive: true });

	const script = join(extDir, "scenario.mjs");
	writeFileSync(script, PRELUDE + code);

	const run = spawnSync(process.execPath, ["--no-warnings", script], {
		cwd: temp,
		encoding: "utf-8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...(options.env ?? {}) },
	});
	assert.equal(run.status, 0, `scenario failed:\n${run.stderr}\n${run.stdout}`);
	const lines = run.stdout.trim().split("\n").filter(Boolean);
	return { stdout: run.stdout, result: JSON.parse(lines[lines.length - 1] ?? "null") };
}

describe("registration", () => {
	test("registers the managed_tools tool and the /managed-tools command", () => {
		const { result } = runScenario(`
			out({
				tools: Object.keys(tools),
				commands: Object.keys(commands),
				hasParameters: typeof tools.managed_tools.parameters === "object",
				description: commands["managed-tools"].description,
			});
		`);
		assert.deepEqual(result, {
			tools: ["managed_tools"],
			commands: ["managed-tools"],
			hasParameters: true,
			description: "Show, update, or reinstall pi's managed binaries (fd, ripgrep, bat, prek, rtk, just, gron, shellcheck, ast-grep, ninja, jq, yq, fzf, uv, gh, bd, agent-browser, ruff, mise, scc, duckdb, miller, sd, difftastic, busybox)",
		});
	});
});

describe("the managed_tools tool", () => {
	test("status reports the bin directory pi searches first and stays offline when asked", () => {
		const agentDir = join(temp, "agent");
		const { result } = runScenario(
			`
			let networkCalls = 0;
			globalThis.fetch = () => { networkCalls++; throw new Error("network used"); };
			const result = await tools.managed_tools.execute("call-1", { action: "status", check_latest: false }, undefined, undefined, ctx);
			out({ text: result.content[0].text, networkCalls });
		`,
			{ agentDir },
		);
		const { text, networkCalls } = result as { text: string; networkCalls: number };
		assert.equal(networkCalls, 0);
		assert.match(text, new RegExp(`bin dir: ${join(agentDir, "bin")}`));
		assert.match(text, /fd: not installed/);
		assert.match(text, /ripgrep: not installed/);
	});

	test("update installs the latest release into the bin directory pi uses", onlyOnDarwinArm, () => {
		const agentDir = join(temp, "agent");
		const binDir = join(agentDir, "bin");
		mkdirSync(binDir, { recursive: true });
		// A current ripgrep, so only fd needs downloading.
		writeFileSync(join(binDir, "rg"), '#!/bin/sh\necho "ripgrep 15.2.0 (rev abc)"\n');
		chmodSync(join(binDir, "rg"), 0o755);

		const fixture = buildFixture(temp, "fd", "10.5.2");

		const { result } = runScenario(
			`
			import { readFileSync } from "node:fs";
			const fixture = process.env.FIXTURE;
			const calls = [];
			globalThis.fetch = async (url) => {
				const href = String(url);
				calls.push(href);
				if (href === "https://github.com/sharkdp/fd/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/sharkdp/fd/releases/tag/v10.5.2" } });
				}
				if (href === "https://github.com/BurntSushi/ripgrep/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0" } });
				}
				if (href.startsWith("https://api.github.com/repos/sharkdp/fd/releases/tags/")) {
					const { createHash } = await import("node:crypto");
					const digest = createHash("sha256").update(readFileSync(fixture)).digest("hex");
					return new Response(
						JSON.stringify({ assets: [{ name: "fd-v10.5.2-aarch64-apple-darwin.tar.gz", digest: "sha256:" + digest }] }),
						{ status: 200 },
					);
				}
				if (href === "https://github.com/sharkdp/fd/releases/download/v10.5.2/fd-v10.5.2-aarch64-apple-darwin.tar.gz") {
					return new Response(readFileSync(fixture), { status: 200 });
				}
				return new Response("not found", { status: 404 });
			};
			const result = await tools.managed_tools.execute("call-1", { action: "update" }, undefined, undefined, ctx);
			out({ text: result.content[0].text, calls: calls.length });
		`,
			{ agentDir, env: { FIXTURE: fixture } },
		);

		const { text } = result as { text: string; calls: number };
		assert.match(text, /fd: installed 10.5\.2/);
		assert.match(text, /ripgrep: unchanged \(15\.2\.0\)/);
		const installed = join(binDir, "fd");
		assert.equal(existsSync(installed), true);
		assert.equal(spawnSync(installed, ["--version"], { encoding: "utf-8" }).stdout.trim(), "fd 10.5.2");
		// A check timestamp is recorded so the next start is quiet.
		assert.equal(existsSync(join(binDir, ".pi-managed-tools.json")), true);
	});
});

/** Every managed binary, seeded so a startup check has nothing to install. */
const SEEDED: Array<[name: string, banner: string, version: string, id?: string]> = [
	["fd", "fd", "10.5.1"],
	["rg", "ripgrep", "15.2.0"],
	["bat", "bat", "0.26.1"],
	["prek", "prek", "0.5.11"],
	["rtk", "rtk", "1.2.1"],
	["just", "just", "1.59.0"],
	// gron's release build prints no version, so its version comes from state.
	["gron", "gron version dev", ""],
	["shellcheck", "ShellCheck version:", "0.11.0"],
	["ast-grep", "ast-grep", "0.51.3"],
	// ninja prints a bare version with no program name.
	["ninja", "", "1.13.2"],
	["jq", "jq-", "1.8.2"],
	["yq", "yq", "4.54.3"],
	["fzf", "fzf", "0.75.0"],
	["uv", "uv", "0.13.9"],
	["gh", "gh", "2.105.0"],
	["bd", "bd version", "1.3.4"],
	["agent-browser", "agent-browser", "0.43.0"],
	["ruff", "ruff", "0.17.6"],
	["mise", "", "2026.11.11"],
	["scc", "scc version", "4.1.0"],
	["duckdb", "v", "2.0.1"],
	["mlr", "mlr", "6.22.0", "miller"],
	["sd", "sd", "1.1.0"],
	["difft", "Difftastic", "0.72.0", "difftastic"],
	["busybox", "BusyBox v1.39.0.git", "1.39.0-aac079e"],
];

/** State recording what is installed, including the tool that cannot self-report. */
function seedState(versions: Record<string, string> = {}): Record<string, unknown> {
	const installed: Record<string, string> = {};
	const latest: Record<string, string> = {};
	for (const [name, , version, id] of SEEDED) {
		// State is keyed by tool id, which differs from the file name for
		// miller (mlr) and difftastic (difft); gron has no version to seed.
		const key = id ?? name;
		const resolved = versions[key] ?? version ?? (key === "gron" ? "0.7.1" : "");
		installed[key] = resolved || "0.7.1";
		latest[key] = resolved || "0.7.1";
	}
	return { checkedAt: Date.now() - 60_000, latest, installed };
}

describe("environment integration", () => {
	test("injects the two environment rules into every turn, once", () => {
		const { result } = runScenario(
			`
			const options = { promptGuidelines: ["existing rule"] };
			await handlers.before_agent_start[0]({ messageType: "user", systemPromptOptions: options }, ctx);
			const first = options.promptGuidelines.slice();
			await handlers.before_agent_start[0]({ messageType: "user", systemPromptOptions: options }, ctx);
			out({ first, second: options.promptGuidelines });
		`,
			{ agentDir: join(temp, "agent-guidelines") },
		);
		const { first, second } = result as { first: string[]; second: string[] };
		assert.equal(first[0], "existing rule", "existing guidelines are kept");
		assert.equal(first.length, 3, "both rules are added once");
		assert.match(first[1] ?? "", /never an absolute path/);
		assert.match(first[2] ?? "", /busybox sh -c/);
		// Firing on every run must not stack duplicates: they are paid for every turn.
		assert.deepEqual(second, first);
	});

	test("states the CLI environment in a system-prompt section, once", () => {
		const { result } = runScenario(
			`
			const options = { sections: { existing: "keep me" } };
			await handlers.before_agent_start[0]({ messageType: "user", systemPromptOptions: options }, ctx);
			const first = { ...options.sections };
			await handlers.before_agent_start[0]({ messageType: "user", systemPromptOptions: options }, ctx);
			out({ first, second: options.sections });
		`,
			{ agentDir: join(temp, "agent-env-section") },
		);
		const { first, second } = result as { first: Record<string, string>; second: Record<string, string> };
		assert.equal(first.existing, "keep me", "other sections are kept");
		const env = first.managed_tools_environment ?? "";
		assert.match(env, /first on PATH/);
		assert.match(env, /busybox sh -c/);
		assert.match(env, /do not spend a turn probing it/);
		// Same string on the next turn: pi diffs sections, and a changing one would
		// patch the prompt every turn.
		assert.deepEqual(second, first);
	});

	test("rewrites an absolute host path in a bash call before it runs", () => {
		const { result } = runScenario(
			`
			const event = { toolName: "bash", toolCallId: "c1", input: { command: "/usr/bin/jq -r .a f.json && /opt/homebrew/bin/gh pr list" } };
			await handlers.tool_call[0](event, ctx);
			const other = { toolName: "bash", toolCallId: "c2", input: { command: "/usr/bin/tar xf a.tar" } };
			await handlers.tool_call[0](other, ctx);
			out({ rewritten: event.input.command, untouched: other.input.command });
		`,
			{ agentDir: join(temp, "agent-rewrite") },
		);
		const { rewritten, untouched } = result as { rewritten: string; untouched: string };
		assert.equal(rewritten, "jq -r .a f.json && gh pr list");
		// A binary this package does not manage keeps its absolute path.
		assert.equal(untouched, "/usr/bin/tar xf a.tar");
	});

	test("leaves bash calls alone when rewriting is switched off", () => {
		const { result } = runScenario(
			`
			const event = { toolName: "bash", toolCallId: "c1", input: { command: "/usr/bin/jq -r .a" } };
			await handlers.tool_call[0](event, ctx);
			out({ command: event.input.command });
		`,
			{ agentDir: join(temp, "agent-rewrite-off"), env: { PI_MANAGED_TOOLS_REWRITE: "off" } },
		);
		assert.deepEqual(result, { command: "/usr/bin/jq -r .a" });
	});
});

describe("startup check", () => {
	test("does not touch the network inside the check interval", () => {
		const agentDir = join(temp, "agent");
		const binDir = join(agentDir, "bin");
		mkdirSync(binDir, { recursive: true });
		for (const [name, banner, version] of SEEDED) {
			writeFileSync(join(binDir, name), `#!/bin/sh\necho "${banner} ${version}"\n`);
			chmodSync(join(binDir, name), 0o755);
		}
		// ast-grep's archive also installs the `sg` shim; a missing shim is damage.
		writeFileSync(join(binDir, "sg"), '#!/bin/sh\necho "ast-grep 0.51.3"\n');
		chmodSync(join(binDir, "sg"), 0o755);
		// uv's archive also installs uvx.
		writeFileSync(join(binDir, "uvx"), '#!/bin/sh\necho "uv 0.13.9"\n');
		chmodSync(join(binDir, "uvx"), 0o755);
		writeFileSync(join(binDir, ".pi-managed-tools.json"), JSON.stringify(seedState()));

		const { result } = runScenario(
			`
			let networkCalls = 0;
			globalThis.fetch = () => { networkCalls++; throw new Error("network used"); };
			await handlers.session_start[0]({ reason: "startup" }, ctx);
			await tick();
			out({ networkCalls, notes: notes.length });
		`,
			{ agentDir },
		);

		assert.deepEqual(result, { networkCalls: 0, notes: 0 });
	});

	test("a failed update is reported to the model as an error, not a success", onlyOnDarwinArm, () => {
		const agentDir = join(temp, "agent-error");
		const binDir = join(agentDir, "bin");
		mkdirSync(binDir, { recursive: true });
		for (const [name, banner, version] of SEEDED) {
			writeFileSync(join(binDir, name), `#!/bin/sh\necho "${banner} ${version}"\n`);
			chmodSync(join(binDir, name), 0o755);
		}
		writeFileSync(join(binDir, "sg"), '#!/bin/sh\necho "ast-grep 0.51.3"\n');
		chmodSync(join(binDir, "sg"), 0o755);
		writeFileSync(join(binDir, "uvx"), '#!/bin/sh\necho "uv 0.13.9"\n');
		chmodSync(join(binDir, "uvx"), 0o755);
		// fd is old, and its download will 404.
		const fixture = buildFixture(temp, "fd", "10.5.2");

		const { result } = runScenario(
			`
			globalThis.fetch = async (url) => {
				const href = String(url);
				if (href.endsWith("/releases/latest")) {
					return new Response(null, { status: 302, headers: { location: href.replace("/latest", "/tag/" + (href.includes("fd") ? "v10.5.2" : "v0")) } });
				}
				return new Response("not found", { status: 404 });
			};
			const result = await tools.managed_tools.execute("call-1", { action: "update" }, undefined, undefined, ctx);
			out({ isError: result.isError, text: result.content[0].text });
		`,
			{ agentDir, env: { FIXTURE: fixture } },
		);

		const { isError } = result as { isError: boolean };
		assert.equal(isError, true);
	});

	test("is disabled by PI_MANAGED_TOOLS=off and by PI_OFFLINE", () => {
		for (const env of [{ PI_MANAGED_TOOLS: "off" }, { PI_OFFLINE: "1" }]) {
			const { result } = runScenario(
				`
				let networkCalls = 0;
				globalThis.fetch = () => { networkCalls++; throw new Error("network used"); };
				await handlers.session_start[0]({ reason: "startup" }, ctx);
				await tick();
				out({ networkCalls });
			`,
				{ env, agentDir: join(temp, `agent-${Object.keys(env)[0]}`) },
			);
			assert.deepEqual(result, { networkCalls: 0 }, JSON.stringify(env));
		}
	});

	test("checks at startup and announces the update in the TUI", onlyOnDarwinArm, () => {
		const agentDir = join(temp, "agent");
		const binDir = join(agentDir, "bin");
		mkdirSync(binDir, { recursive: true });
		for (const [name, banner, version] of SEEDED) {
			writeFileSync(join(binDir, name), `#!/bin/sh\necho "${banner} ${version}"\n`);
			chmodSync(join(binDir, name), 0o755);
		}
		// ast-grep's archive also installs the `sg` shim; a missing shim is damage.
		writeFileSync(join(binDir, "sg"), '#!/bin/sh\necho "ast-grep 0.51.3"\n');
		chmodSync(join(binDir, "sg"), 0o755);
		// uv's archive also installs uvx.
		writeFileSync(join(binDir, "uvx"), '#!/bin/sh\necho "uv 0.13.9"\n');
		chmodSync(join(binDir, "uvx"), 0o755);
		writeFileSync(
			join(binDir, ".pi-managed-tools.json"),
			// Outside the interval, so the startup check actually runs.
			JSON.stringify({ ...seedState({ fd: "10.5.1" }), checkedAt: Date.now() - 13 * 60 * 60 * 1000 }),
		);
		const fixture = buildFixture(temp, "fd", "10.5.2");

		const { result } = runScenario(
			`
			import { readFileSync } from "node:fs";
			globalThis.fetch = async (url) => {
				const href = String(url);
				if (href === "https://github.com/sharkdp/fd/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/sharkdp/fd/releases/tag/v10.5.2" } });
				}
				if (href === "https://github.com/BurntSushi/ripgrep/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0" } });
				}
				if (href === "https://github.com/sharkdp/bat/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/sharkdp/bat/releases/tag/v0.26.1" } });
				}
				if (href === "https://github.com/j178/prek/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/j178/prek/releases/tag/v0.5.11" } });
				}
				if (href === "https://github.com/rtk-ai/rtk/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/rtk-ai/rtk/releases/tag/v1.2.1" } });
				}
				if (href === "https://github.com/casey/just/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/casey/just/releases/tag/1.59.0" } });
				}
				if (href === "https://github.com/tomnomnom/gron/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/tomnomnom/gron/releases/tag/v0.7.1" } });
				}
				if (href === "https://github.com/koalaman/shellcheck/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/koalaman/shellcheck/releases/tag/v0.11.0" } });
				}
				if (href === "https://github.com/ast-grep/ast-grep/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/ast-grep/ast-grep/releases/tag/0.51.3" } });
				}
				if (href === "https://github.com/ninja-build/ninja/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/ninja-build/ninja/releases/tag/v1.13.2" } });
				}
				if (href === "https://github.com/jqlang/jq/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/jqlang/jq/releases/tag/jq-1.8.2" } });
				}
				if (href === "https://github.com/mikefarah/yq/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/mikefarah/yq/releases/tag/v4.54.3" } });
				}
				if (href === "https://github.com/junegunn/fzf/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/junegunn/fzf/releases/tag/v0.75.0" } });
				}
				if (href === "https://github.com/astral-sh/uv/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/astral-sh/uv/releases/tag/0.13.9" } });
				}
				if (href === "https://github.com/cli/cli/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/cli/cli/releases/tag/v2.105.0" } });
				}
				if (href === "https://github.com/gastownhall/beads/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/gastownhall/beads/releases/tag/v1.3.4" } });
				}
				if (href === "https://github.com/vercel-labs/agent-browser/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/vercel-labs/agent-browser/releases/tag/v0.43.0" } });
				}
				if (href === "https://github.com/astral-sh/ruff/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/astral-sh/ruff/releases/tag/0.17.6" } });
				}
				if (href === "https://github.com/jdx/mise/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/jdx/mise/releases/tag/v2026.11.11" } });
				}
				if (href === "https://github.com/boyter/scc/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/boyter/scc/releases/tag/v4.1.0" } });
				}
				if (href === "https://github.com/duckdb/duckdb/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/duckdb/duckdb/releases/tag/v2.0.1" } });
				}
				if (href === "https://github.com/johnkerl/miller/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/johnkerl/miller/releases/tag/v6.22.0" } });
				}
				if (href === "https://github.com/chmln/sd/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/chmln/sd/releases/tag/v1.1.0" } });
				}
				if (href === "https://github.com/Wilfred/difftastic/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/Wilfred/difftastic/releases/tag/0.72.0" } });
				}
				if (href === "https://github.com/rob-c/busybox-static/releases/latest") {
					return new Response(null, { status: 302, headers: { location: "https://github.com/rob-c/busybox-static/releases/tag/v1.39.0-aac079e" } });
				}
				if (href.startsWith("https://api.github.com/repos/sharkdp/fd/releases/tags/")) {
					const { createHash } = await import("node:crypto");
					const digest = createHash("sha256").update(readFileSync(process.env.FIXTURE)).digest("hex");
					return new Response(
						JSON.stringify({ assets: [{ name: "fd-v10.5.2-aarch64-apple-darwin.tar.gz", digest: "sha256:" + digest }] }),
						{ status: 200 },
					);
				}
				if (href.includes("fd-v10.5.2-")) return new Response(readFileSync(process.env.FIXTURE), { status: 200 });
				return new Response("not found", { status: 404 });
			};
			await handlers.session_start[0]({ reason: "startup" }, ctx);
			await tick(1500);
			out({ notes });
		`,
			{ agentDir, env: { FIXTURE: fixture } },
		);

		const { notes } = result as { notes: [string, string][] };
		assert.deepEqual(notes, [["managed tools updated: fd 10.5.1 -> 10.5.2", "info"]]);
		assert.equal(spawnSync(join(binDir, "fd"), ["--version"], { encoding: "utf-8" }).stdout.trim(), "fd 10.5.2");
	});
});

/** A release archive laid out the way upstream publishes it, for the stub fetch to serve. */
function buildFixture(dir: string, tool: "fd" | "rg", version: string): string {
	const asset =
		tool === "fd" ? `fd-v${version}-aarch64-apple-darwin` : `ripgrep-${version}-aarch64-apple-darwin`;
	const stage = join(dir, `fixture-${asset}`);
	const inner = join(stage, asset);
	mkdirSync(inner, { recursive: true });
	const binary = join(inner, tool);
	writeFileSync(binary, tool === "fd" ? `#!/bin/sh\necho "fd ${version}"\n` : `#!/bin/sh\necho "ripgrep ${version} (rev abc)"\n`);
	chmodSync(binary, 0o755);
	const archive = join(stage, `${asset}.tar.gz`);
	const packaged = spawnSync("tar", ["czf", archive, "-C", stage, asset], { encoding: "utf-8" });
	assert.equal(packaged.status, 0, packaged.stderr);
	const fixture = join(dir, "fixture.tar.gz");
	writeFileSync(fixture, readFileSync(archive));
	return fixture;
}
