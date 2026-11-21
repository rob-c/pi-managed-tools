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
 * `pi-managed-tools` - keep pi's managed binaries, and a few PATH-only extras,
 * at the latest upstream release.
 *
 * Why this exists: pi's own tools manager downloads fd and ripgrep the first
 * time `find`/`grep` need them and then never looks again, so a machine keeps
 * whatever release it happened to fetch. This extension updates that copy in
 * the directory pi already searches first (`<agent dir>/bin`), so the built-in
 * `find` and `grep` tools - and every `bash` command, because pi prepends that
 * directory to PATH - use the newer binaries without any other change.
 *
 * Tools with an empty `consumedBy` are not used by any pi built-in: they are
 * installed for `bash` only, and are reported that way rather than implied to
 * be part of pi's own tool surface.
 */
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, VERSION, getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	compareVersions,
	errorMessage,
	findToolId,
	inspectTools,
	MANAGED_TOOL_IDS,
	MANAGED_TOOLS,
	readSettings,
	readState,
	type Report,
	type ToolId,
	rewriteToolPaths,
	shouldCheck,
	type ToolReport,
	updateTools,
} from "./tools.ts";

/** Same location pi's `getBinDir()` resolves, including $PI_CODING_AGENT_DIR. */
const BIN_DIR = join(getAgentDir(), "bin");
const STATUS_KEY = "pi-managed-tools";
const USER_AGENT = `pi-managed-tools/0.15.0 (pi ${VERSION})`;
const TOOL_LIST = MANAGED_TOOL_IDS.map((id) => MANAGED_TOOLS[id].name).join(", ");

/**
 * Environment rules stated in every turn rather than only when a skill loads.
 *
 * A skill's body reaches the model only once it decides the skill is relevant,
 * which it does not do for one-liners; these two were measured to fire
 * inconsistently from skill text alone.
 */
const ENV_GUIDELINES = [
	"Invoke the packaged binaries by bare name (rg, fd, bat, jq, scc, busybox); never an absolute path such as /usr/bin/jq or /opt/homebrew/bin/gh.",
	"Wrap multi-step shell logic as busybox sh -c '...' — loops, pipelines, several statements — and use plain bash only for arrays, ${v^^} or mapfile.",
];
const GUIDELINE_MARK = "Wrap multi-step shell logic as busybox sh";

/** Absolute host paths replaced in this process, reported by /managed-tools status. */
let rewrittenPaths = 0;

const ENV_SECTION_KEY = "managed_tools_environment";
/** Models worth naming in the environment line, in the order they are used. */
const ENV_HIGHLIGHTS: ToolId[] = ["rg", "jq", "bat", "scc", "busybox"];

let cachedEnvSection: string | undefined;

/**
 * The CLI facts a model would otherwise discover by exploring.
 *
 * Versions come from the state file rather than from running five binaries, and
 * the whole string is computed once per process so the prompt section is stable
 * across turns — pi diffs sections, and a string that changes per turn costs a
 * prompt patch every turn.
 */
function environmentSection(): string {
	if (cachedEnvSection) return cachedEnvSection;
	const installed = readState(BIN_DIR)?.installed ?? {};
	const versions = ENV_HIGHLIGHTS.filter((id) => installed[id])
		.map((id) => `${MANAGED_TOOLS[id].binaryName} ${String(installed[id]).replace(/-.*$/, "")}`)
		.join(", ");
	cachedEnvSection = [
		`Commands run under pi's own shell, with ${BIN_DIR} first on PATH, so the packaged`,
		`binaries are what run${versions ? ` (${versions})` : ""}. Invoke them by bare name;`,
		"write multi-step shell logic as busybox sh -c '...'. This is already established —",
		"do not spend a turn probing it.",
	].join(" ");
	return cachedEnvSection;
}

function toolLine(tool: ToolReport, report: Report): string {
	const state = tool.version ? `installed ${tool.version}` : "not installed";
	const installed = tool.damaged ? `${state} - DAMAGED (${tool.damaged}); run reinstall` : state;
	if (!tool.supported) {
		return `${tool.name}: ${installed}; no release published for ${report.plat}/${report.architecture}`;
	}
	const latest = tool.latest
		? `latest ${tool.latest}`
		: tool.error
			? `latest unknown (${tool.error})`
			: "latest not checked";
	const verdict = !tool.latest
		? ""
		: !tool.version
			? " - missing, run update"
			: compareVersions(tool.version, tool.latest) < 0
				? " - update available"
				: " - up to date";
	const where = tool.path
		? tool.path
		: tool.systemPath
			? `no managed copy; pi falls back to ${tool.systemPath}`
			: "no managed copy and nothing on PATH";
	const consumer =
		tool.consumedBy.length > 0
			? `pi ${tool.consumedBy.join("/")}`
			: "PATH only - no pi built-in tool uses it";
	return `${tool.name}: ${installed}; ${latest}${verdict}\n  ${where}\n  used by: ${consumer}`;
}

function formatInspection(report: Report): string {
	const lines = [`pi managed tools - ${report.plat}/${report.architecture}`, `bin dir: ${report.binDir}`];
	const unsupported = report.tools.filter((tool) => !tool.supported);
	if (unsupported.length > 0) {
		lines.push(`no prebuilt release for ${unsupported.map((tool) => tool.name).join(", ")} on this platform`);
	}
	for (const tool of report.tools) lines.push(toolLine(tool, report));
	return lines.join("\n");
}

function formatUpdate(report: Report, mode: "update" | "reinstall" = "update"): string {
	const lines = [`pi managed tools - ${report.plat}/${report.architecture}`];
	let changed = 0;
	const digest = (tool: ToolReport) => {
		if (!tool.digest) return "";
		// An install that went through the unverified opt-out must not be reported
		// the same way as a verified one.
		const state = tool.verified === false ? "UNVERIFIED" : "verified";
		return ` [sha256 ${tool.digest.slice(0, 16)} ${state}]`;
	};
	for (const tool of report.tools) {
		if (tool.action === "updated" || tool.action === "reinstalled") {
			changed++;
			const verb = tool.action === "reinstalled" ? "reinstalled" : "updated";
			lines.push(
				`${tool.name}: ${verb} ${tool.previousVersion ?? "?"} -> ${tool.version} (${tool.path})${digest(tool)}`,
			);
		} else if (tool.action === "installed") {
			changed++;
			lines.push(`${tool.name}: installed ${tool.version} (${tool.path})${digest(tool)}`);
		} else if (tool.action === "failed") {
			lines.push(`${tool.name}: update failed - ${tool.error ?? "unknown error"}`);
		} else if (tool.action === "skipped") {
			lines.push(`${tool.name}: skipped - ${tool.error ?? "unsupported platform"}`);
		} else if (tool.damaged) {
			lines.push(`${tool.name}: DAMAGED (${tool.damaged}) - reinstall did not run`);
		} else {
			lines.push(`${tool.name}: unchanged (${tool.version ?? "unknown version"})`);
		}
	}
	if (!report.supported) lines.push("no managed binary has a prebuilt release on this platform");
	if (
		changed === 0 &&
		report.tools.every((tool) => tool.action !== "failed") &&
		report.tools.every((tool) => !tool.damaged)
	) {
		lines.push(mode === "reinstall" ? "no damaged tools to reinstall" : "everything already current");
	}
	return lines.join("\n");
}

/** One-line TUI notice for a silent startup update, or undefined when nothing changed. */
function updateNotice(report: Report): string | undefined {
	const changed = report.tools.filter((tool) => tool.action === "updated" || tool.action === "installed");
	if (changed.length === 0) return undefined;
	const parts = changed.map((tool) => {
		const version =
			tool.action === "updated"
				? `${tool.name} ${tool.previousVersion ?? "?"} -> ${tool.version}`
				: `${tool.name} ${tool.version}`;
		// An install that could not be digest-checked must not look like the rest.
		return tool.verified === false ? `${version} (UNVERIFIED)` : version;
	});
	return `managed tools updated: ${parts.join(", ")}`;
}

export default function (pi: ExtensionAPI) {
	const settings = readSettings();
	let autoUpdate: AbortController | undefined;
	let warned = false;

	/**
	 * Look for newer releases without holding up startup.
	 *
	 * A check happens only when a managed binary is missing or the last check
	 * is older than the configured interval, so a normal start makes no network
	 * call at all.
	 */
	const refreshInBackground = (ctx: ExtensionContext) => {
		if (!settings.enabled) return;
		if (!shouldCheck(readState(BIN_DIR), settings.intervalHours, BIN_DIR)) return;

		autoUpdate?.abort();
		autoUpdate = new AbortController();
		const signal = autoUpdate.signal;

		void (async () => {
			const progress: ((message: string | undefined) => void) | undefined = ctx.hasUI
				? (message) => ctx.ui.setStatus(STATUS_KEY, message)
				: undefined;
			try {
				progress?.(`checking ${TOOL_LIST} releases...`);
				const report = await updateTools({
					binDir: BIN_DIR,
					signal,
					userAgent: USER_AGENT,
					onProgress: progress,
				});
				if (signal.aborted) return;
				// updateTools already persisted the result, including the per-tool
				// failure memory that keeps a broken tool from retrying on every
				// start. Writing again here would undo the all-failed guard.
				const notice = updateNotice(report);
				if (ctx.hasUI) {
					if (notice) ctx.ui.notify(notice, "info");
					const failures = report.tools.filter((tool) => tool.action === "failed");
					if (failures.length > 0 && !warned) {
						warned = true;
						ctx.ui.notify(
							`managed tools: could not update ${failures.map((tool) => tool.name).join(", ")} (${failures[0]?.error})`,
							"warning",
						);
					}
				}
			} catch (error) {
				if (!signal.aborted && ctx.hasUI && !warned) {
					warned = true;
					ctx.ui.notify(`managed tools: ${errorMessage(error)}`, "warning");
				}
			} finally {
				progress?.(undefined);
			}
		})();
	};

	pi.on("session_start", (_event, ctx) => {
		refreshInBackground(ctx);
	});

	/**
	 * Keep the two environment rules in the system prompt for every turn.
	 *
	 * Idempotent: this fires on each run, and a duplicate would be paid for on
	 * every turn of the session.
	 */
	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		if (!options) return;
		const current = options.promptGuidelines ?? [];
		if (!current.some((line) => line.includes(GUIDELINE_MARK))) {
			options.promptGuidelines = [...current, ...ENV_GUIDELINES];
		}
		// State the environment instead of leaving it to be explored.
		const sections = options.sections ?? {};
		if (!sections[ENV_SECTION_KEY]) {
			options.sections = { ...sections, [ENV_SECTION_KEY]: environmentSection() };
		}
	});

	/**
	 * Rewrite `/usr/bin/jq` to `jq` before execution.
	 *
	 * Deterministic where prompt text is not: an absolute path bypasses both of
	 * pi's resolution mechanisms and pins the host's older build, and a model that
	 * has already decided to write one will not be talked out of it every time.
	 * `PI_MANAGED_TOOLS_REWRITE=off` disables it.
	 */
	pi.on("tool_call", (event) => {
		if (!settings.rewritePaths) return;
		if (!isToolCallEventType("bash", event)) return;
		const { command, rewrites } = rewriteToolPaths(event.input.command, undefined, [BIN_DIR]);
		if (rewrites.length === 0) return;
		event.input.command = command;
		rewrittenPaths += rewrites.length;
	});

	pi.on("session_shutdown", () => {
		autoUpdate?.abort();
		autoUpdate = undefined;
	});

	pi.registerTool({
		name: "managed_tools",
		label: "Managed Tools",
		description:
			`Report, update or repair the binaries pi manages for its find and grep tools (${TOOL_LIST}). ` +
			"'status' shows installed and latest versions, which binary pi uses, and any binary that is present but cannot run; " +
			"'update' verifies and installs the latest release in place; " +
			"'reinstall' forces a fresh download of one named tool, or of every damaged binary when no tool is given. " +
			"Downloads are checked against the sha256 GitHub records for each release asset.",
		promptSnippet: `Check, update or repair pi's managed binaries (${TOOL_LIST})`,
		promptGuidelines: [
			`Use managed_tools when the user asks which fd, rg, bat, prek, rtk, just, gron, shellcheck, ast-grep or ninja binary pi uses, whether those tools are current, or to update them.`,
			"Use managed_tools with action 'reinstall' when a managed binary is missing, corrupt, fails to execute, or the user asks to repair one; pass 'tool' to target a single binary.",
			"Only find and grep are backed by pi built-in tools; the others are reachable from bash only.",
			// These two are environment rules an agent gets wrong silently: an absolute
			// path pins the host's older build, and an unwrapped shell drifts to
			// whichever bash the host resolved. Stated here as well as in the skill
			// because a skill only loads when the model decides it is relevant.
			"Invoke the packed-in binaries by bare name (rg, fd, bat, jq, scc); never by absolute path such as /usr/bin/jq or /opt/homebrew/bin/gh.",
			"Wrap multi-step shell logic as busybox sh -c '...' — loops, pipelines, several statements — and use plain bash only for arrays, ${v^^} or mapfile.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("status"), Type.Literal("update"), Type.Literal("reinstall")]),
			tool: Type.Optional(
				Type.String({
					description:
						"For reinstall: a tool name or id. Omit to replace every managed binary that is present but does not execute.",
				}),
			),
			check_latest: Type.Optional(
				Type.Boolean({
					description: "For status: query GitHub for the latest releases (default true). False reports local state only.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const options = {
				binDir: BIN_DIR,
				signal,
				userAgent: USER_AGENT,
			};
			if (params.action === "reinstall") {
				const requested = params.tool ? findToolId(params.tool) : undefined;
				if (params.tool && !requested) {
					return {
						content: [
							{ type: "text", text: `Unknown tool: ${params.tool}. Managed tools: ${TOOL_LIST}.` },
						],
						details: undefined,
						isError: true,
					};
				}
				onUpdate?.({
					content: [
						{
							type: "text",
							text: requested
								? `Reinstalling ${MANAGED_TOOLS[requested].name}...`
								: "Reinstalling damaged tools...",
						},
					],
					details: undefined,
				});
				// updateTools persists state itself; writing again here would defeat
				// its all-failed guard and defer the next attempt for a full interval.
				const report = await updateTools({
					...options,
					reinstall: requested ? [requested] : "damaged",
				});
				return {
					content: [{ type: "text", text: formatUpdate(report, "reinstall") }],
					details: undefined,
					isError: report.tools.some((tool) => tool.action === "failed" || tool.damaged !== undefined),
				};
			}
			if (params.action === "update") {
				onUpdate?.({
					content: [{ type: "text", text: `Checking the latest ${TOOL_LIST} releases...` }],
					details: undefined,
				});
				const report = await updateTools(options);
				return {
					content: [{ type: "text", text: formatUpdate(report) }],
					details: undefined,
					isError: report.tools.some((tool) => tool.action === "failed" || tool.damaged !== undefined),
				};
			}
			const report = await inspectTools({ ...options, checkLatest: params.check_latest !== false });
			return { content: [{ type: "text", text: formatInspection(report) }], details: undefined };
		},
	});

	pi.registerCommand("managed-tools", {
		description: `Show, update, or reinstall pi's managed binaries (${TOOL_LIST})`,
		handler: async (args, ctx) => {
			const [verb = "status", ...rest] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const options = { binDir: BIN_DIR, userAgent: USER_AGENT };
			if (verb === "reinstall") {
				const requested = rest[0] ? findToolId(rest[0]) : undefined;
				if (rest[0] && !requested) {
					ctx.ui.notify(`managed tools: unknown tool ${rest[0]}. Managed: ${TOOL_LIST}`, "error");
					return;
				}
				ctx.ui.setStatus(STATUS_KEY, requested ? `reinstalling ${rest[0]}...` : `reinstalling ${TOOL_LIST}...`);
				try {
					const report = await updateTools({ ...options, reinstall: requested ? [requested] : "damaged" });
					ctx.ui.notify(formatUpdate(report, "reinstall"), "info");
				} catch (error) {
					ctx.ui.notify(`managed tools: ${errorMessage(error)}`, "error");
				} finally {
					ctx.ui.setStatus(STATUS_KEY, undefined);
				}
				return;
			}
			if (verb === "update") {
				ctx.ui.setStatus(STATUS_KEY, `updating ${TOOL_LIST}...`);
				try {
					const report = await updateTools(options);
					ctx.ui.notify(formatUpdate(report), "info");
				} catch (error) {
					ctx.ui.notify(`managed tools: ${errorMessage(error)}`, "error");
				} finally {
					ctx.ui.setStatus(STATUS_KEY, undefined);
				}
				return;
			}
			try {
				const report = await inspectTools({ ...options, checkLatest: verb !== "status-only" });
				const damaged = report.tools.filter((tool) => tool.damaged);
				const rewritten =
					rewrittenPaths > 0 ? `\nabsolute paths rewritten to packaged binaries: ${rewrittenPaths}` : "";
				ctx.ui.notify(formatInspection(report) + rewritten, damaged.length > 0 ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(`managed tools: ${errorMessage(error)}`, "error");
			}
		},
	});
}
