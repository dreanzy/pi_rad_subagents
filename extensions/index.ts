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

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
	findProjectRadSubagentsConfig,
	clearConfigCache,
	loadConfig,
} from "./config.ts";
import { registerAgentAutocomplete } from "./autocomplete.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

// ── Retryable error detection ────────────────────────────────────────

const RETRYABLE_ERROR_PATTERNS = [
	/rate_limit/i,
	/rate limit/i,
	/too many requests/i,
	/insufficient_quota/i,
	/overloaded/i,
	/capacity/i,
	/timeout/i,
	/timed.?out/i,
	/server_error/i,
	/internal_server/i,
	/5\\d{2}/,
	/service.unavailable/i,
	/temporarily.unavailable/i,
	/model_ov/i,
	/request.limit/i,
];

const NON_RETRYABLE_ERROR_PATTERNS = [
	/invalid_api_key/i,
	/unauthorized/i,
	/forbidden/i,
	/not_found/i,
	/model_not_found/i,
	/invalid_request/i,
	/bad_request/i,
	/context_length_exceeded/i,
	/context_length/i,
	/token_limit/i,
	/prompt_too_long/i,
	/safety/i,
	/content_policy/i,
];

function isRetryableError(result: SingleResult): boolean {
	if (result.exitCode !== 0) return true;

	if (result.stopReason === "error") {
		const errorMsg = (result.errorMessage || result.stderr || "").toLowerCase();

		for (const pattern of NON_RETRYABLE_ERROR_PATTERNS) {
			if (pattern.test(errorMsg)) return false;
		}
		for (const pattern of RETRYABLE_ERROR_PATTERNS) {
			if (pattern.test(errorMsg)) return true;
		}

		return true;
	}

	return false;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns)
		parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview =
				command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg(
					"warning",
					`:${startLine}${endLine ? `-${endLine}` : ""}`,
				);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return (
				themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath))
			);
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview =
				argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "builtin" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue;
		if (msg.role === "assistant") {
			if (!Array.isArray(msg.content)) continue;
			for (const part of msg.content) {
				if (
					typeof part === "object" &&
					part !== null &&
					"type" in part &&
					(part as any).type === "text"
				) {
					const text = (part as any).text;
					if (typeof text === "string") return text;
				}
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return (
			result.errorMessage ||
			result.stderr ||
			getFinalOutput(result.messages) ||
			"(no output)"
		);
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({
						type: "toolCall",
						name: part.name,
						args: part.arguments,
					});
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			const item = items[current];
			if (item === undefined) return;
			results[current] = await fn(item, current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "rad-subagent-"),
	);
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, {
			encoding: "utf-8",
			mode: 0o600,
		});
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const pluginConfig = loadConfig(defaultCwd);
	const resolvedAgentName = pluginConfig.agentAliases?.[agentName] ?? agentName;

	const agent = agents.find((a) => a.name === resolvedAgentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			step,
		};
	}

	const models: string[] = [];
	if (agent.model) models.push(agent.model);
	if (agent.modelPriority) models.push(...agent.modelPriority);

	let lastResult: SingleResult | null = null;

	for (let modelIdx = 0; modelIdx < models.length; modelIdx++) {
		const currentModel = models[modelIdx];

		const args: string[] = ["--mode", "json", "-p", "--no-session"];
		if (currentModel) args.push("--model", currentModel);
		if (agent.tools && agent.tools.length > 0)
			args.push("--tools", agent.tools.join(","));

		let tmpPromptDir: string | null = null;
		let tmpPromptPath: string | null = null;

		const currentResult: SingleResult = {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			model: currentModel || agent.model,
			step,
		};

		let lastEmitTime = 0;
		const EMIT_THROTTLE_MS = 50;
		const emitUpdate = (force = false) => {
			if (onUpdate) {
				const now = Date.now();
				if (!force && now - lastEmitTime < EMIT_THROTTLE_MS) return;
				lastEmitTime = now;
				onUpdate({
					content: [
						{
							type: "text",
							text: getFinalOutput(currentResult.messages) || "(running...)",
						},
					],
					details: makeDetails([currentResult]),
				});
			}
		};

		try {
			if (agent.systemPrompt.trim()) {
				// ponytail: project APPEND_SYSTEM.md overrides global
				let combinedPrompt = agent.systemPrompt;
				const projectPath = path.join(
					defaultCwd,
					CONFIG_DIR_NAME,
					"APPEND_SYSTEM.md",
				);
				const appendPath = fs.existsSync(projectPath)
					? projectPath
					: path.join(getAgentDir(), "APPEND_SYSTEM.md");
				if (fs.existsSync(appendPath))
					combinedPrompt += "\n\n" + fs.readFileSync(appendPath, "utf-8");

				const tmp = await writePromptToTempFile(agent.name, combinedPrompt);
				tmpPromptDir = tmp.dir;
				tmpPromptPath = tmp.filePath;
				args.push("--append-system-prompt", tmpPromptPath);
			}

			// Append retry hint to task so the sub-agent sees which attempt this is
			const taskWithRetry =
				modelIdx > 0
					? `[Retry ${modelIdx + 1}/${models.length} with model ${currentModel}]\n${task}`
					: task;
			args.push(`Task: ${taskWithRetry}`);
			let wasAborted = false;

			const exitCode = await new Promise<number>((resolve) => {
				const invocation = getPiInvocation(args);
				const proc = spawn(invocation.command, invocation.args, {
					cwd: cwd ?? defaultCwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, PI_SUBAGENT_CHILD: "1" },
				});
				let buffer = "";

				// Track the index of the last assistant message for in-place streaming updates
				let lastAssistantIdx = -1;

				const processLine = (line: string) => {
					if (!line.trim()) return;
					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}

					// message_start — begin tracking a new assistant message
					if (event.type === "message_start" && event.message) {
						const msg = event.message as Message;
						if (msg.role === "assistant") {
							if (lastAssistantIdx >= 0) {
								// message_update arrived before message_start — update in-place
								currentResult.messages[lastAssistantIdx] = msg;
							} else {
								currentResult.messages.push(msg);
								lastAssistantIdx = currentResult.messages.length - 1;
							}
						}
					}

					// message_update — STREAMING: update assistant text token-by-token in real-time
					if (event.type === "message_update" && event.message) {
						const msg = event.message as Message;
						if (msg.role === "assistant") {
							if (lastAssistantIdx >= 0) {
								// Update in-place so getFinalOutput/getDisplayItems see latest content
								currentResult.messages[lastAssistantIdx] = msg;
							} else {
								// No message_start seen yet — push anyway
								currentResult.messages.push(msg);
								lastAssistantIdx = currentResult.messages.length - 1;
							}
							emitUpdate();
						}
					}

					// message_end — finalize message
					if (event.type === "message_end" && event.message) {
						const msg = event.message as Message;
						if (msg.role === "assistant") {
							// Replace in-place (avoid duplicate push from message_start)
							if (lastAssistantIdx >= 0) {
								currentResult.messages[lastAssistantIdx] = msg;
							} else {
								currentResult.messages.push(msg);
							}
							lastAssistantIdx = -1;

							currentResult.usage.turns++;
							const usage = msg.usage;
							if (usage) {
								currentResult.usage.input += usage.input || 0;
								currentResult.usage.output += usage.output || 0;
								currentResult.usage.cacheRead += usage.cacheRead || 0;
								currentResult.usage.cacheWrite += usage.cacheWrite || 0;
								currentResult.usage.cost += usage.cost?.total || 0;
								currentResult.usage.contextTokens = usage.totalTokens || 0;
							}
							if (!currentResult.model && msg.model)
								currentResult.model = msg.model;
							if (msg.stopReason) currentResult.stopReason = msg.stopReason;
							if (msg.errorMessage)
								currentResult.errorMessage = msg.errorMessage;
						} else {
							// Non-assistant messages (e.g., tool results). Push so nothing is lost.
							currentResult.messages.push(msg);
						}
						emitUpdate(true); // always fire — final state matters
					}

					// tool_result_end — tool result messages
					if (event.type === "tool_result_end" && event.message) {
						const msg = event.message as Message;
						// Avoid duplicate push when message_end already handled this
						const last =
							currentResult.messages[currentResult.messages.length - 1];
						if (last?.role !== msg.role) {
							currentResult.messages.push(msg);
						}
						emitUpdate(true); // always fire — final state matters
					}
				};

				proc.stdout.on("data", (data: Buffer) => {
					buffer += data.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) processLine(line);
				});

				proc.stderr.on("data", (data: Buffer) => {
					currentResult.stderr += data.toString();
				});

				proc.on("close", (code: number | null) => {
					if (buffer.trim()) processLine(buffer);
					resolve(code ?? 0);
				});

				proc.on("error", () => {
					resolve(1);
				});

				if (signal) {
					const killProc = () => {
						wasAborted = true;
						proc.kill("SIGTERM");
						setTimeout(() => {
							if (!proc.killed) proc.kill("SIGKILL");
						}, 5000);
					};
					if (signal.aborted) killProc();
					else signal.addEventListener("abort", killProc, { once: true });
				}
			});

			currentResult.exitCode = exitCode;
			if (wasAborted) throw new Error("Subagent was aborted");

			if (!isRetryableError(currentResult)) {
				return currentResult;
			}

			// Retryable error — fall through to save as last result and retry

			// Failure — save as last result and retry with next model
			lastResult = currentResult;
		} finally {
			if (tmpPromptPath)
				try {
					fs.unlinkSync(tmpPromptPath);
				} catch {
					/* ignore */
				}
			if (tmpPromptDir)
				try {
					fs.rmdirSync(tmpPromptDir);
				} catch {
					/* ignore */
				}
		}
	}

	// All models exhausted — return the last failure
	return (
		lastResult ?? {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: "All models exhausted",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			model: agent.model,
			step,
		}
	);
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		description: "Task with optional {previous} placeholder for prior output",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

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
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "rad-subagents",
		label: "RadSubagents",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Load agent aliases from config
			const pluginConfig = loadConfig(ctx.cwd);
			const agentAliases = pluginConfig.agentAliases ?? {};
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available =
					agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// --- Project agent confirmation ---
			// --- Project agent confirmation ---
			// This runs after orchestrate routing so params.agent is set if applicable.
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
					.filter((a): a is AgentConfig => a?.source === "project");

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
							details: makeDetails(
								hasChain ? "chain" : hasTasks ? "parallel" : "single",
							)([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i]!;
					const taskWithContext = step.task.replace(
						/\{previous\}/g,
						previousOutput,
					);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
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
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
								},
							],
							details: makeDetails("chain")(results),
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
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i]!.agent,
						agentSource: "unknown",
						task: params.tasks[i]!.task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
							contextTokens: 0,
							turns: 0,
						},
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
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const taskItems: Array<{ agent: string; task: string; cwd?: string }> =
					params.tasks ?? [];
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
							// Per-task update callback
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
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
					details: makeDetails("parallel")(results),
				};
			}

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
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [
							{
								type: "text",
								text: `Agent ${result.stopReason || "failed"}: ${errorMsg}`,
							},
						],
						details: makeDetails("single")([result]),
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
					details: makeDetails("single")([result]),
				};
			}

			const available =
				agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [
					{
						type: "text",
						text: `Invalid parameters. Available agents: ${available}`,
					},
				],
				details: makeDetails("single")([]),
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
					// Clean up {previous} placeholder for display
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
					const preview =
						t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
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
				return new Text(
					text?.type === "text" ? text.text : "(no output)",
					0,
					0,
				);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped =
					limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0)
					text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded
							? item.text
							: item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0]!;
				const isError = isFailedResult(r);
				const icon = isError
					? theme.fg("error", "✗")
					: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason)
						header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(
							new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
						);
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("muted", "─── Output ───"), 0, 0),
					);
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(
							new Text(theme.fg("muted", "(no output)"), 0, 0),
						);
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(
												item.name,
												item.args,
												theme.fg.bind(theme),
											),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(
								new Markdown(finalOutput.trim(), 0, 0, mdTheme),
							);
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason)
					text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage)
					text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0)
					text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT)
						text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
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
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter(
					(r) => r.exitCode === 0,
				).length;
				const icon =
					successCount === details.results.length
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg(
									"accent",
									`${successCount}/${details.results.length} steps`,
								),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon =
							r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(
							new Text(
								theme.fg("muted", "Task: ") + theme.fg("dim", r.task),
								0,
								0,
							),
						);

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(
												item.name,
												item.args,
												theme.fg.bind(theme),
											),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(
								new Markdown(finalOutput.trim(), 0, 0, mdTheme),
							);
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage)
							container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0),
						);
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon =
						r.exitCode === 0
							? theme.fg("success", "✓")
							: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter(
					(r) => r.exitCode !== -1 && !isFailedResult(r),
				).length;
				const failCount = details.results.filter(
					(r) => r.exitCode !== -1 && isFailedResult(r),
				).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(
							new Text(
								theme.fg("muted", "Task: ") + theme.fg("dim", r.task),
								0,
								0,
							),
						);

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(
												item.name,
												item.args,
												theme.fg.bind(theme),
											),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(
								new Markdown(finalOutput.trim(), 0, 0, mdTheme),
							);
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage)
							container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0),
						);
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// ── Orchestrator Mode ────────────────────────────────────────────────

	/// Persist orchestrator state to .pi/rad-subagents.json
	/// Reads/writes the `orchestrator.enabled` field in the config file.

	function getOrchestratorConfigPath(cwd?: string): string {
		// Priority: project-level config exists → write there; else → write global
		const dir = cwd ?? process.cwd();
		const projectConfig = findProjectRadSubagentsConfig(dir);
		if (projectConfig) return projectConfig;
		return path.join(getAgentDir(), "rad-subagents.json");
	}

	let orchestratorConfigPath = getOrchestratorConfigPath();

	function loadOrchestratorEnabled(): boolean {
		try {
			const raw = fs.readFileSync(orchestratorConfigPath, "utf-8");
			const data = JSON.parse(raw) as Record<string, unknown>;
			const orch = data.orchestrator as { enabled?: boolean } | undefined;
			return orch?.enabled === true;
		} catch {
			return false;
		}
	}

	function saveOrchestratorEnabled(enabled: boolean): void {
		try {
			let data: Record<string, unknown> = {};
			try {
				const raw = fs.readFileSync(orchestratorConfigPath, "utf-8");
				data = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				// File doesn't exist or is invalid — start fresh
			}

			data.orchestrator = {
				...(data.orchestrator as Record<string, unknown> | undefined),
				enabled,
			};

			fs.mkdirSync(path.dirname(orchestratorConfigPath), { recursive: true });
			fs.writeFileSync(
				orchestratorConfigPath,
				JSON.stringify(data, null, 2) + "\n",
			);
		} catch (err) {
			console.error("[rad-subagents] Failed to save orchestrator state:", err);
		}
	}

	let orchestratorEnabled = loadOrchestratorEnabled();

	// Refresh config path when session starts
	pi.on("session_start", (_event, ctx) => {
		clearConfigCache();
		orchestratorConfigPath = getOrchestratorConfigPath(ctx.cwd);
		orchestratorEnabled = loadOrchestratorEnabled();
		return undefined;
	});

	const ORCHESTRATOR_SYSTEM_PROMPT = `
IMPORTANT: You are now in ORCHESTRATOR MODE.

<Role>
You are a workflow manager for coding work. Your job is to plan, schedule, delegate, monitor, reconcile, and verify specialist-agent work. You are not the default implementation worker.

Optimize for quality, speed, cost, and reliability by dispatching the right specialist lanes, tracking task state, and integrating results into one coherent outcome.

You delegate using the \`rad-subagents\` tool:

- **Single delegation**: \`rad-subagents(agent: "explorer", task: "find all auth-related code")\`
- **Parallel delegation**: \`rad-subagents(tasks: [{ agent: "explorer", task: "..." }, { agent: "librarian", task: "..." }])\`
- **Chained delegation**: \`rad-subagents(chain: [{ agent: "explorer", task: "..." }, { agent: "fixer", task: "use {previous} to implement..." }])\`

Always prefer delegation over doing the work yourself — the specialists are faster and more focused in their domains.
</Role>

<Agents>

@explorer
- **Lane**: Fast codebase recon that returns compressed context
- **Capabilities**: Glob, grep, AST queries to locate files, symbols, patterns
- **Permissions**: read_files only
- **Stats**: 2x faster codebase search than you, half the cost
- **Delegate when**: Need to discover what exists before planning • Parallel searches speed discovery • Need summarized map vs full contents • Broad/uncertain scope
- **Don''t delegate when**: Know the path and need actual content • Need full file anyway • Single specific lookup • About to edit the file

@librarian
- **Lane**: External knowledge and library research, fast web research
- **Role**: Authoritative source for current library docs, API references, examples, bug investigations, and web retrieval
- **Stats**: 2x faster web research than you, half the cost
- **Delegate when**: Libraries with frequent API changes (React, Next.js, AI SDKs) • Complex APIs needing official examples • Version-specific behavior matters • Unfamiliar library • Working on fixing a tricky bug and need latest web research information
- **Don''t delegate when**: Standard usage you''re confident about • Simple stable APIs • General programming knowledge • Info already in conversation • Built-in language features
- **Rule of thumb**: "How does this library work?" → @librarian. "How does programming work?" → answer directly.

@oracle
- **Lane**: Architecture, risk, debugging strategy, and review
- **Role**: Strategic advisor for high-stakes decisions and persistent problems, code reviewer
- **Permissions**: read_files only
- **Capabilities**: Deep architectural reasoning, system-level trade-offs, complex debugging, code review, simplification, maintainability review
- **Stats**: 5x better decision maker and problem solver than you, same cost
- **Delegate when**: Major architectural decisions with long-term impact • Problems persisting after 2+ fix attempts • High-risk multi-system refactors • Complex debugging with unclear root cause • Security/scalability/data-integrity decisions • Code review passes • Code needs simplification or YAGNI scrutiny
- **Don''t delegate when**: Routine decisions you''re confident about • First bug fix attempt • Straightforward trade-offs • Time-sensitive good-enough decisions
- **Rule of thumb**: Need senior architect review? → @oracle. Routine coordination? → handle directly.

@designer
- **Lane**: UI/UX design, related edits, design polish and review
- **Permissions**: read_files, write_files
- **Capabilities**: Good design taste, visual relevant edits, interactions, responsive layouts, design systems with aesthetic intent
- **Owns**: Visual and interaction quality — layout, hierarchy, spacing, motion, affordances, responsive behavior, and overall feel
- **Weakness**: Copywriting. Ask designer to use grounded, normal wording, then review/fix copy after design work without changing visual intent.
- **Delegate when**: User-facing interfaces needing polish • Responsive layouts • UX-critical components (forms, nav, dashboards) • Visual consistency systems • Animations/micro-interactions • Refining functional→delightful
- **Don''t delegate when**: Backend/logic with no visual • Quick prototypes where design doesn''t matter yet.
- **Rule of thumb**: Users see it and polish matters? → @designer. Headless implementation? → @fixer.

@fixer
- **Lane**: Bounded implementation and execution
- **Role**: Fast execution specialist for well-defined tasks
- **Permissions**: read_files, write_files
- **Stats**: 2x faster code edits, half your cost
- **Weakness**: design, taste
- **Delegate when**: Implementation work after you''ve thought and triaged first • Multi-file changes that can be scoped per folder and parallelized via multiple @fixers • Well-defined mechanical tasks
- **Don''t delegate when**: Needs discovery/research/decisions • Single small change (<20 lines, one file) • Unclear requirements needing iteration • Requires design taste or visual judgment
- **Rule of thumb**: Headless/mechanical implementation → @fixer. User-visible design or polish → @designer. If @designer already set direction, @fixer may only do bounded mechanical follow-up that preserves that design exactly.

@observer
- **Lane**: Visual/media analysis isolated from main context
- **Role**: Visual analysis specialist for images, PDFs, and diagrams
- **Permissions**: read_files only
- **Capabilities**: Interprets images, screenshots, PDFs, and diagrams; extracts UI elements, layouts, text, relationships
- **Delegate when**: Need to analyze a multimedia file • Extract information from a screenshot, diagram, or PDF
- **Don''t delegate when**: Plain text files that \`read\` can handle directly • Files that need editing afterward
- **Rule of thumb**: Even if you support vision, delegate visual analysis — it isolates large image/PDF bytes from your context, returning only concise structured text.

</Agents>

<Workflow>

## 1. Understand
Parse request: explicit requirements + implicit needs.

## 2. Path Selection
Evaluate approach by: quality, speed, and cost. Choose the path that optimizes all three.

## 3. Delegation Check
Review available agents and lane rules.

**Dispatch efficiency:**
- Reference paths/lines, don''t paste files (\`src/app.ts:42\` not full contents)
- Briefly note the delegation goal before each call (one line)
- For trivial conversational answers or tiny mechanical edits, direct execution is allowed when delegation overhead would clearly dominate
- Record task state and ownership across delegations
- Reconcile results, resolve conflicts, and gate dependent work

**File Operations Rules:**
- Prefer dedicated file tools for normal code work: \`grep\`/\`find\` for discovery, \`read\` for contents, and \`edit\`/\`write\` for targeted changes.
- Use \`bash\` for execution and automation: git, package managers, tests, builds, scripts, diagnostics.
- Shell is acceptable for bulk or mechanical filesystem changes when it is clearer or safer than many individual edits.
- Do not use \`cat\`/\`head\`/\`tail\`/\`sed\`/\`awk\` to read code — use \`read\`/\`grep\`.

## 4. Plan and Parallelize
Build a short work graph before dispatching:
- Independent lanes that can run now
- Dependency-ordered lanes that must wait
- Advisory ownership for write-capable lanes
- Verification/review lanes that run after implementation

Can tasks be split into parallel specialist work?
- Multiple @explorer searches across different domains?
- @explorer + @librarian research in parallel?
- Multiple @fixer instances for faster, scoped implementation?
- @observer + @explorer in parallel (visual analysis + code search)?

Balance: respect dependencies, avoid parallelizing what must be sequential, and avoid overlapping write ownership.

**Background Task Discipline:**
- Use \`rad-subagents()\` (single) or \`rad-subagents(tasks: ..., agent: ...)\` for delegated work.
- Track each task''s specialist, objective, and file/topic ownership.
- Continue orchestrating only on non-overlapping work; otherwise briefly report what was launched and stop.
- Before making edits yourself or launching another writer task, compare against running task scopes.
- Parallel delegation is allowed only when their write scopes do not conflict.
- Before final response, reconcile all task results.

**Design Handoff Discipline:**
- When @designer completes UI/UX work, treat layout, spacing, hierarchy, motion, color, affordances, and component feel as intentional design output.
- Do not later simplify, normalize, or refactor in ways that flatten the design.
- Review and improve user-facing copy after designer work, because designer copy may be weak. Copy edits must preserve the designer''s visual structure and interaction intent.
- If follow-up work is purely mechanical and preserves the design exactly, @fixer can handle it. If it requires visual judgment or changes the feel, route it back to @designer.

## 5. Verify
- Run relevant checks/diagnostics for the change
- Route code review to @oracle for non-trivial changes
- Route UI/UX validation to @designer
- Confirm specialists completed successfully
- Verify solution meets requirements

</Workflow>

<Communication>

## Clarity Over Assumptions
- If request is vague or has multiple valid interpretations, ask a targeted question before proceeding
- Don''t guess at critical details (file paths, API choices, architectural decisions)
- Do make reasonable assumptions for minor details and state them briefly

## Concise Execution
- Answer directly, no preamble
- Don''t summarize what you did unless asked
- Don''t explain code unless asked
- Brief delegation notices: "Checking docs via @librarian..." not "I''m going to delegate to @librarian because..."

## No Flattery
Never: "Great question!" "Excellent idea!" "Smart choice!" or any praise of user input.

## Honest Pushback
When the user''s approach seems problematic:
- State concern + alternative concisely
- Ask if they want to proceed anyway
- Don''t lecture, don''t blindly implement

## Example
**Bad:** "Great question! Let me think about the best approach here. I''m going to delegate to @librarian to check the latest React documentation, and then I''ll implement the solution for you."

**Good:** "Checking React docs via @librarian..."
[continues scheduling or integration]

</Communication>
`;
	pi.registerCommand("orchestrate", {
		description:
			"Toggle orchestrator mode on/off. In orchestrator mode the assistant delegates work to specialist agents via rad-subagents.",
		handler: async (_args, cmdCtx) => {
			orchestratorEnabled = !orchestratorEnabled;
			saveOrchestratorEnabled(orchestratorEnabled);

			const message = orchestratorEnabled
				? "Orchestrator mode ON — I will delegate work to specialist agents. Use /orchestrate again to disable."
				: "Orchestrator mode OFF — I will work directly. Use /orchestrate to re-enable.";

			cmdCtx.ui.notify(message, "info");
		},
	});

	// Inject orchestrator system prompt before each turn when enabled
	pi.on("before_agent_start", (event) => {
		if (!orchestratorEnabled) return undefined;

		return {
			systemPrompt: event.systemPrompt
				? ORCHESTRATOR_SYSTEM_PROMPT + "\n\n" + event.systemPrompt
				: ORCHESTRATOR_SYSTEM_PROMPT,
		};
	});

	// Register agent @-mention autocomplete
	registerAgentAutocomplete(pi);

	// ── Always-on agent descriptions for system prompt ──────────────────────
	// Lets the LLM know about available agents even without orchestrator mode.
	pi.on("before_agent_start", (event, ctx) => {
		const { agents } = discoverAgents(ctx.cwd, "both");
		if (agents.length === 0) return;

		const agentLines = agents.map(
			(a) => `- @${a.name}: ${a.description || a.name}`,
		);

		const agentSection = `
## Available Agents

Delegate work using the \`rad-subagents()\` tool. Available agents:

${agentLines.join("\n")}

When the user mentions @agentName or asks to delegate, use \`rad-subagents(agent: "name", task: "...")\` to delegate.`;

		return {
			systemPrompt: event.systemPrompt + agentSection,
		};
	});

	// ── @-mention → rad-subagents() instruction transform ───────────────────
	// Rewrites "@agentName task" to an explicit tool instruction so the LLM
	// calls rad-subagents() naturally, without custom execution logic.
	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive") return;

		const match = event.text.match(/^@(\S+)\s+([\s\S]*)$/);
		if (!match) return;

		const agentName = match[1]!;
		const task = match[2]!;
		if (!task.trim()) return;
		if (/[/\\]/.test(agentName)) return;

		// Check if agent exists directly or via alias (so @scout still works)
		const { agents } = discoverAgents(ctx.cwd, "both");
		const inputConfig = loadConfig(ctx.cwd);
		const resolvedInputAgent =
			inputConfig.agentAliases?.[agentName] ?? agentName;
		if (!agents.find((a) => a.name === resolvedInputAgent)) return;

		return {
			action: "transform" as const,
			text: `Delegate to @${agentName} via rad-subagents(): ${task}`,
		};
	});

	// ── Custom message renderer for @-mention results ─────────────────────
	pi.registerMessageRenderer(
		"rad-subagent-result",
		(message, options, theme) => {
			let text = theme.fg("toolTitle", theme.bold("[@] ")) + message.content;
			if (options.expanded && message.details) {
				text +=
					"\n" + theme.fg("dim", JSON.stringify(message.details, null, 2));
			}
			return new Text(text, 0, 0);
		},
	);
}
