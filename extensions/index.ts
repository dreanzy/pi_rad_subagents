/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * The main conversation acts as the orchestrator — use `rad-subagents()`
 * to delegate work to specialist agents dynamically.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentScope } from "./agents.ts";
import { discoverAgents } from "./agents.ts";
import { loadConfig } from "./config.ts";
import {
	type DisplayItem,
	type MakeDetailsFn,
	type OnUpdateCallback,
	type SingleResult,
	type SubagentDetails,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	emptyUsage,
	formatToolCall,
	formatUsageStats,
	getDisplayItems,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	mapWithConcurrencyLimit,
	runSingleAgent,
	truncateParallelOutput,
} from "./executor.ts";
import { registerAgentAutocomplete } from "./autocomplete.ts";
import { registerOrchestrator } from "./orchestrator.ts";

const COLLAPSED_ITEM_COUNT = 10;

// ── Tool parameter schema ───────────────────────────────────────────

const TIMEOUT_DESC_SUFFIX =
	"The subagent process is killed at the deadline and any partial output is returned with stopReason 'timeout'. Overrides the top-level timeoutMs. Omit for no timeout.";

/**
 * Shared schema for one delegated agent invocation (a task in single/parallel
 * mode, or a step in chain mode). Only the task and timeout descriptions differ
 * between the two uses — the shape is identical.
 */
function agentItemSchema(taskDesc: string, timeoutDesc: string) {
	return Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: taskDesc }),
		cwd: Type.Optional(
			Type.String({ description: "Working directory for the agent process" }),
		),
		timeoutMs: Type.Optional(Type.Number({ description: timeoutDesc })),
	});
}

const TaskItem = agentItemSchema(
	"Task to delegate to the agent",
	`Per-task timeout in milliseconds. Set based on task complexity (e.g. 60_000 for a quick lookup, 600_000 for deep research). ${TIMEOUT_DESC_SUFFIX}`,
);

const ChainItem = agentItemSchema(
	"Task with optional {previous} placeholder for prior output",
	`Per-step timeout in milliseconds. ${TIMEOUT_DESC_SUFFIX}`,
);

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({
			description: "Name of the agent to invoke (for single mode)",
		}),
	),
	task: Type.Optional(
		Type.String({ description: "Task to delegate (for single mode)" }),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for parallel execution",
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: "Array of {agent, task} for sequential execution",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the agent process (single mode)",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				"Default timeout in milliseconds applied to all tasks/steps. Estimate from complexity: ~30_000 for trivial lookups, 60_000-120_000 for typical research, up to 600_000 for deep multi-step work. At the deadline the subagent is killed and partial output is returned with stopReason 'timeout' — the orchestrator can then retry with a bigger budget or a narrower task. Per-task timeoutMs overrides this. Omit for no timeout. IMPORTANT: always set a timeout — without one, a stuck subagent (e.g. hung network call) blocks forever.",
		}),
	),
});

// ── Helpers ─────────────────────────────────────────────────────────

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const OBSERVER_MENTION_RE = /@observer\b/i;
const OBSERVER_TOOL_RE = /rad-subagents\s*\([^)]*\bobserver\b/i;

/**
 * Extract existing image file paths (absolute or relative to cwd) from input text.
 * Splits on whitespace/punctuation, keeps only tokens ending with an image extension
 * whose file actually exists, to avoid false positives from code strings.
 */
export function findImagePaths(text: string, cwd: string): string[] {
	const found: string[] = [];
	for (const tok of text.split(/[\s"'“”，。；、()（）：]+/)) {
		// Strip @ prefix (TUI attachment completion inserts @path)
		const clean = tok.replace(/^@+/, "");
		if (!clean || !IMAGE_EXT_RE.test(clean)) continue;
		const abs = path.isAbsolute(clean) ? clean : path.resolve(cwd, clean);
		try {
			if (fs.existsSync(abs)) found.push(abs);
		} catch {
			// Invalid path, skip
		}
	}
	// ponytail: string[] fine for one caller; wrap in {path, kind} if more consumers appear
	return found;
}

interface RegistryModelLike {
	id: string;
	provider: string;
	input: string[];
}

/**
 * Resolve a model reference ("provider:id" or bare id) from the model registry.
 */
export function findModelByRef(
	registry: { getAll(): RegistryModelLike[] },
	ref: string,
): RegistryModelLike | undefined {
	const all = registry.getAll();
	if (ref.includes(":")) {
		const [provider, id] = ref.split(":");
		return all.find((m) => m.provider === provider && m.id === id);
	}
	return (
		all.find((m) => m.id === ref) ?? all.find((m) => m.id.endsWith(`:${ref}`))
	);
}

/**
 * Assert a requiresVision agent runs on a vision-capable model.
 * Returns an error message, or null when ok. Unresolvable models are allowed through.
 */
export function checkVisionRequirement(
	agent: {
		name: string;
		requiresVision?: boolean;
		model?: string;
		filePath: string;
	},
	ctx: {
		model?: RegistryModelLike;
		modelRegistry: { getAll(): RegistryModelLike[] };
	},
): string | null {
	if (!agent.requiresVision) return null;
	const ref = agent.model;
	const model = ref ? findModelByRef(ctx.modelRegistry, ref) : ctx.model;
	if (model && !model.input.includes("image")) {
		return `Agent "${agent.name}" requires a vision-capable model, but "${model.id}" does not support image input. Configure a vision model in ${agent.filePath} (frontmatter "model:").`;
	}
	return null;
}

const makeDetails =
	(
		mode: "single" | "parallel" | "chain",
		agentScope: AgentScope,
		projectAgentsDir: string | null,
	): MakeDetailsFn =>
	(results: SingleResult[]): SubagentDetails => ({
		mode,
		agentScope,
		projectAgentsDir,
		results,
	});

function renderDisplayItems(
	items: DisplayItem[],
	theme: { fg: (color: any, text: string) => string },
	limit?: number,
): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = limit
				? item.text.split("\n").slice(0, 3).join("\n")
				: item.text;
			text += `${theme.fg("toolOutput", preview)}\n`;
		} else {
			text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
		}
	}
	return text.trimEnd();
}

function aggregateUsage(results: SingleResult[]): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
} {
	const total = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
	};
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

// ── Rendered result components ──────────────────────────────────────

/**
 * Status icon for a single agent result: ⏳ running, ✓ success, ✗ failed.
 */
// biome-ignore lint/suspicious/noExplicitAny: pi TUI theme type
function resultIcon(r: SingleResult, theme: any): string {
	if (r.exitCode === -1) return theme.fg("warning", "⏳");
	return isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

// biome-ignore lint/suspicious/noExplicitAny: pi TUI theme type
function renderSingleResult(
	r: SingleResult,
	theme: any,
	expanded: boolean,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
) {
	const isRunning = r.exitCode === -1;
	const isError = !isRunning && isFailedResult(r);
	const terminalError = r.stopReason === "error" || r.stopReason === "aborted";
	const icon = resultIcon(r, theme);
	const displayItems = getDisplayItems(r.messages);
	const finalOutput = getFinalOutput(r.messages);

	if (expanded) {
		const container = new Container();
		let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
		if (isError && terminalError)
			header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		container.addChild(new Text(header, 0, 0));
		if (isError && r.errorMessage)
			container.addChild(
				new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
			);
		// Show rejection info
		if (r.rejected) {
			container.addChild(
				new Text(theme.fg("warning", `[Task Rejected] ${r.rejected.reason}`), 0, 0),
			);
			if (r.rejected.suggestion)
				container.addChild(
					new Text(theme.fg("dim", `Suggestion: ${r.rejected.suggestion}`), 0, 0),
				);
		}
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
		if (displayItems.length === 0 && !finalOutput) {
			container.addChild(
				new Text(
					theme.fg("muted", isRunning ? "(running...)" : "(no output)"),
					0,
					0,
				),
			);
		} else {
			for (const item of displayItems) {
				if (item.type === "toolCall")
					container.addChild(
						new Text(
							theme.fg("muted", "→ ") +
								formatToolCall(item.name, item.args, theme.fg.bind(theme)),
							0,
							0,
						),
					);
			}
			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			}
		}
		// Retryable info
		if (isError && r.retryable !== undefined) {
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					r.retryable
						? theme.fg("warning", "[Retryable: yes]")
						: theme.fg("error", "[Retryable: no]"),
					0,
					0,
				),
			);
		}
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
		}
		return container;
	}

	// Collapsed
	let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
	if (isError && terminalError)
		text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	if (r.rejected) {
		text += `\n${theme.fg("warning", `[Rejected] ${r.rejected.reason}`)}`;
	} else if (isError && r.errorMessage) {
		text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
	} else if (displayItems.length === 0) {
		text += `\n${theme.fg("muted", isRunning ? "(running...)" : "(no output)")}`;
	} else {
		text += `\n${renderDisplayItems(displayItems, theme, COLLAPSED_ITEM_COUNT)}`;
		if (displayItems.length > COLLAPSED_ITEM_COUNT)
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	if (isError && r.retryable !== undefined) {
		text += `\n${r.retryable ? theme.fg("warning", "[Retryable: yes]") : theme.fg("error", "[Retryable: no]")}`;
	}
	const usageStr = formatUsageStats(r.usage, r.model);
	if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
	return new Text(text, 0, 0);
}

/**
 * Shared per-result body (expanded): rejection + toolCalls + output + usage.
 * Used by renderChainResults and renderParallelResults to avoid duplication.
 */
function renderSingleItemBody(
	r: SingleResult,
	theme: any,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
): Container {
	const body = new Container();
	const displayItems = getDisplayItems(r.messages);
	const finalOutput = getFinalOutput(r.messages);

	if (r.rejected) {
		body.addChild(
			new Text(theme.fg("warning", `[Rejected] ${r.rejected.reason}`), 0, 0),
		);
		if (r.rejected.suggestion)
			body.addChild(
				new Text(theme.fg("dim", `Suggestion: ${r.rejected.suggestion}`), 0, 0),
			);
	} else {
		for (const item of displayItems) {
			if (item.type === "toolCall") {
				body.addChild(
					new Text(
						theme.fg("muted", "→ ") +
							formatToolCall(item.name, item.args, theme.fg.bind(theme)),
						0,
						0,
					),
				);
			}
		}
		if (finalOutput) {
			body.addChild(new Spacer(1));
			body.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
		}
	}

	const usageStr = formatUsageStats(r.usage, r.model);
	if (usageStr) body.addChild(new Text(theme.fg("dim", usageStr), 0, 0));

	return body;
}

/**
 * Per-result expanded block (step header + task + output body), shared by
 * chain and parallel renderers — only the header separator differs.
 */
// biome-ignore lint/suspicious/noExplicitAny: pi TUI theme type
function renderExpandedStep(
	r: SingleResult,
	theme: any,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
	separator: string,
): Container {
	const step = new Container();
	step.addChild(
		new Text(
			`${theme.fg("muted", separator) + theme.fg("accent", r.agent)} ${resultIcon(r, theme)}`,
			0,
			0,
		),
	);
	step.addChild(
		new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0),
	);
	step.addChild(renderSingleItemBody(r, theme, mdTheme));
	return step;
}

/**
 * Per-result collapsed line, shared by chain and parallel renderers.
 */
// biome-ignore lint/suspicious/noExplicitAny: pi TUI theme type
function renderStepLine(
	r: SingleResult,
	theme: any,
	separator: string,
): string {
	const displayItems = getDisplayItems(r.messages);
	let text = `\n\n${theme.fg("muted", separator)}${theme.fg("accent", r.agent)} ${resultIcon(r, theme)}`;
	if (r.rejected) {
		text += `\n${theme.fg("warning", `[Rejected] ${r.rejected.reason}`)}`;
	} else if (displayItems.length === 0) {
		text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
	} else {
		text += `\n${renderDisplayItems(displayItems, theme, 5)}`;
	}
	return text;
}

// biome-ignore lint/suspicious/noExplicitAny: pi TUI theme type
function renderChainResults(
	results: SingleResult[],
	theme: any,
	expanded: boolean,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
) {
	const successCount = results.filter((r) => r.exitCode === 0).length;
	const runningCount = results.filter((r) => r.exitCode === -1).length;
	const icon =
		runningCount > 0
			? theme.fg("warning", "⏳")
			: successCount === results.length
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");

	if (expanded) {
		const container = new Container();
		container.addChild(
			new Text(
				icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${results.length} steps`),
				0,
				0,
			),
		);

		for (const r of results) {
			container.addChild(new Spacer(1));
			container.addChild(
				renderExpandedStep(r, theme, mdTheme, `─── Step ${r.step}: `),
			);
		}

		const usageStr = formatUsageStats(aggregateUsage(results));
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
		}
		return container;
	}

	// Collapsed
	let text =
		icon +
		" " +
		theme.fg("toolTitle", theme.bold("chain ")) +
		theme.fg("accent", `${successCount}/${results.length} steps`);
	for (const r of results) {
		text += renderStepLine(r, theme, `─── Step ${r.step}: `);
	}
	const usageStr = formatUsageStats(aggregateUsage(results));
	if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
	if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

// biome-ignore lint/suspicious/noExplicitAny: pi TUI theme type
function renderParallelResults(
	results: SingleResult[],
	theme: any,
	expanded: boolean,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
) {
	const running = results.filter((r) => r.exitCode === -1).length;
	const successCount = results.filter(
		(r) => r.exitCode !== -1 && !isFailedResult(r),
	).length;
	const failCount = results.filter(
		(r) => r.exitCode !== -1 && isFailedResult(r),
	).length;
	const isRunning = running > 0;
	const icon = isRunning
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");
	const status = isRunning
		? `${successCount + failCount}/${results.length} done, ${running} running`
		: `${successCount}/${results.length} tasks`;

	if (expanded && !isRunning) {
		const container = new Container();
		container.addChild(
			new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
				0,
				0,
			),
		);

		for (const r of results) {
			container.addChild(new Spacer(1));
			container.addChild(renderExpandedStep(r, theme, mdTheme, "─── "));
		}

		const usageStr = formatUsageStats(aggregateUsage(results));
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
		}
		return container;
	}

	// Collapsed or still running
	let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
	for (const r of results) {
		text += renderStepLine(r, theme, "─── ");
	}
	if (!isRunning) {
		const usageStr = formatUsageStats(aggregateUsage(results));
		if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
	}
	if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

// ── Plugin entry point ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "rad-subagents",
		label: "RadSubagents",
		description: [
			"IMPORTANT: Subagent names (librarian, explorer, fixer, oracle, etc.) are NOT tool names. Always use this tool (rad-subagents) to delegate — never call a subagent name directly.",
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").`,
			`If an agent name you need (e.g. referenced by a skill) is not in the list above, try it anyway — it may be a built-in hidden alias. On failure, the tool reports available agents and aliases.`,
			"TIMEOUTS: always pass timeoutMs (top-level default or per-task) estimated from task complexity — the subagent is killed at the deadline and partial output returned with stopReason 'timeout'; without it a hung subagent blocks forever.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const pluginConfig = loadConfig(ctx.cwd);
			const agentAliases = pluginConfig.agentAliases ?? {};
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const availableList = () =>
				agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
			const mkDetails = makeDetails(
				hasChain ? "chain" : hasTasks ? "parallel" : "single",
				agentScope,
				discovery.projectAgentsDir,
			);

			if (modeCount !== 1) {
				const available = availableList();
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: mkDetails([]),
				};
			}

			// ── Vision requirement check (requiresVision agents, e.g. observer) ──
			const requestedNames: string[] = [];
			if (params.chain) requestedNames.push(...params.chain.map((s) => s.agent));
			if (params.tasks) requestedNames.push(...params.tasks.map((t) => t.agent));
			if (params.agent) requestedNames.push(params.agent);

			for (const name of requestedNames) {
				const resolved = agentAliases[name] ?? name;
				const agent = agents.find((a) => a.name === resolved);
				if (!agent) continue; // unknown agent is reported later
				const err = checkVisionRequirement(agent, ctx);
				if (err) {
					return {
						content: [{ type: "text", text: err }],
						details: mkDetails([]),
						isError: true,
					};
				}
			}

			// ── Project agent confirmation ──
			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain)
					for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks)
					for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => {
						const resolved = agentAliases[name] ?? name;
						return agents.find((a) => a.name === resolved);
					})
					.filter((a): a is NonNullable<typeof a> => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [
								{
									type: "text",
									text: "Canceled: project-local agents not approved.",
								},
							],
							details: mkDetails([]),
						};
				}
			}

			// ── Chain mode ──
			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i]!;
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									onUpdate({
										content: partial.content,
										details: mkDetails([...results, currentResult]),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						mkDetails,
						step.timeoutMs ?? params.timeoutMs,
					);
					results.push(result);

					if (isFailedResult(result)) {
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}`,
								},
							],
							details: mkDetails(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [
						{
							type: "text",
							text:
								getFinalOutput(results[results.length - 1]?.messages ?? []) ||
								"(no output)",
						},
					],
					details: mkDetails(results),
				};
			}

			// ── Parallel mode ──
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: mkDetails([]),
					};

				const allResults: SingleResult[] = new Array(params.tasks.length);
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i]!.agent,
						agentSource: "unknown",
						task: params.tasks[i]!.task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: emptyUsage(),
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{
									type: "text",
									text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
								},
							],
							details: mkDetails([...allResults]),
						});
					}
				};

				const taskItems: Array<{
					agent: string;
					task: string;
					cwd?: string;
					timeoutMs?: number;
				}> = params.tasks ?? [];
				const results = await mapWithConcurrencyLimit(
					taskItems,
					MAX_CONCURRENCY,
					async (t, index) => {
						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							t.agent,
							t.task,
							t.cwd,
							undefined,
							signal,
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							mkDetails,
							t.timeoutMs ?? params.timeoutMs,
						);
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					},
				);

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: mkDetails(results),
				};
			}

			// ── Single mode ──
			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					mkDetails,
					params.timeoutMs,
				);
				if (isFailedResult(result)) {
					return {
						content: [
							{
								type: "text",
								text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}`,
							},
						],
						details: mkDetails([result]),
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: getFinalOutput(result.messages) || "(no output)",
						},
					],
					details: mkDetails([result]),
				};
			}

			const available = availableList();
			return {
				content: [
					{
						type: "text",
						text: `Invalid parameters. Available agents: ${available}`,
					},
				],
				details: mkDetails([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("rad-subagents ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i]!;
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview =
						cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("rad-subagents ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task
				? args.task.length > 60
					? `${args.task.slice(0, 60)}...`
					: args.task
				: "...";
			let text =
				theme.fg("toolTitle", theme.bold("rad-subagents ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			if (details.mode === "single" && details.results.length === 1) {
				return renderSingleResult(details.results[0]!, theme, expanded, mdTheme);
			}

			if (details.mode === "chain") {
				return renderChainResults(details.results, theme, expanded, mdTheme);
			}

			if (details.mode === "parallel") {
				return renderParallelResults(details.results, theme, expanded, mdTheme);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// ── @-mention → rad-subagents() instruction transform ──
	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive") return;

		// Image path detection: when the main model has no vision support, force a hint
		// to delegate to observer. Placed before @-mention, because @C:\path\img.png
		// would otherwise be swallowed by the @-mention prefix rule.
		const imagePaths = findImagePaths(event.text, ctx.cwd);
		const hasImages = imagePaths.length > 0 || (event.images?.length ?? 0) > 0;
		const modelSupportsVision = ctx.model?.input.includes("image") ?? false;
		const alreadyObserving =
			OBSERVER_MENTION_RE.test(event.text) || OBSERVER_TOOL_RE.test(event.text);
		if (hasImages && !modelSupportsVision && !alreadyObserving) {
			const list =
				imagePaths.length > 0
					? imagePaths.map((p) => `- ${p}`).join("\n")
					: `- ${event.images!.length} attached image(s)`;
			return {
				action: "transform" as const,
				text: `${event.text}\n\n[SYSTEM NOTE] The input contains image file(s), but your model has no vision support. You MUST first delegate to observer via rad-subagents to read and analyze these images, then continue the original task based on the results:\n${list}`,
			};
		}

		const match = event.text.match(/^@(\S+)\s+([\s\S]*)$/);
		if (!match) return;

		const agentName = match[1]!;
		const task = match[2]!;
		if (!task.trim()) return;
		if (/[/\\]/.test(agentName)) return;

		const { agents } = discoverAgents(ctx.cwd, "both");
		const resolvedInputAgent =
			loadConfig(ctx.cwd).agentAliases?.[agentName] ?? agentName;
		if (!agents.find((a) => a.name === resolvedInputAgent)) return;

		return {
			action: "transform" as const,
			text: `Delegate to @${agentName} via rad-subagents(): ${task}`,
		};
	});

	// ── Custom message renderer for @-mention results ──
	pi.registerMessageRenderer(
		"rad-subagent-result",
		(message, options, theme) => {
			let text = theme.fg("toolTitle", theme.bold("[@] ")) + message.content;
			if (options.expanded && message.details) {
				text += "\n" + theme.fg("dim", JSON.stringify(message.details, null, 2));
			}
			return new Text(text, 0, 0);
		},
	);

	// Register agent @-mention autocomplete
	registerAgentAutocomplete(pi);

	// Register orchestrator mode (optional)
	registerOrchestrator(pi);
}
