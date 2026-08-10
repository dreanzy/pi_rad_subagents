/**
 * Subagent execution engine — subprocess management, result parsing, rejection contract.
 *
 * Extracted from index.ts for focused responsibility.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentScope } from "./agents.ts";
import { loadConfig } from "./config.ts";

// ── Constants ───────────────────────────────────────────────────────

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
/** Per-task output byte cap for parallel-summary truncation. */
const PER_TASK_OUTPUT_CAP = 50 * 1024;

/**
 * Shared task rejection contract — appended to every agent system prompt.
 * Agents use structured format to reject tasks they can't handle,
 * allowing the orchestrator to reroute instead of retry blindly.
 */
const REJECTION_CONTRACT_INSTRUCTION = `
## Task Rejection

If you CANNOT complete this task for any reason (ambiguous requirements, missing permissions, scope too broad, etc.), you MUST respond with a structured rejection instead of guessing or doing nothing:

REJECT: <specific reason why you cannot do this>
SUGGESTION: <alternative agent or approach that could handle this, optional>
`.trim();

// ── Types ───────────────────────────────────────────────────────────

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
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
	/** Structured task rejection (agent declined the task). */
	rejected?: { reason: string; suggestion?: string };
	/** Whether this error is safe to retry (transient vs permanent). */
	retryable?: boolean;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

export type MakeDetailsFn = (results: SingleResult[]) => SubagentDetails;

export type OnUpdateCallback = (
	partial: AgentToolResult<SubagentDetails>,
) => void;

// ── Formatting helpers ──────────────────────────────────────────────

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
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

export function formatToolCall(
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
				// biome-ignore lint/style/useBlockStatements: scoped inside if inside braced case
				const startLine = offset ?? 1;
				// biome-ignore lint/style/useBlockStatements: scoped inside if inside braced case
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

// ── Result parsing ──────────────────────────────────────────────────

interface ContentPart {
	type: string;
	text?: string;
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue;
		if (msg.role === "assistant") {
			if (!Array.isArray(msg.content)) continue;
			for (const part of msg.content) {
				const contentPart = part as ContentPart;
				if (
					contentPart.type === "text" &&
					typeof contentPart.text === "string"
				) {
					return contentPart.text;
				}
			}
		}
	}
	return "";
}

/**
 * Parse structured task rejection from agent output.
 * Format (appended to agent prompt via REJECTION_CONTRACT_INSTRUCTION):
 *   REJECT: <reason>
 *   SUGGESTION: <alternative agent or approach, optional>
 */
function parseRejection(output: string): {
	rejected: boolean;
	reason?: string;
	suggestion?: string;
} {
	const rejectMatch = output.match(/REJECT:\s*(.+)/im);
	if (!rejectMatch) return { rejected: false };
	const suggestionMatch = output.match(/SUGGESTION:\s*(.+)/im);
	return {
		rejected: true,
		reason: rejectMatch[1]?.trim(),
		suggestion: suggestionMatch?.[1]?.trim(),
	};
}

/**
 * Determine whether a failed result is safe to retry.
 */
function determineRetryable(result: SingleResult): boolean | undefined {
	if (result.rejected) return false; // agent explicitly declined
	if (result.stopReason === "aborted") return false;
	if (result.stopReason === "timeout") return false; // task-level timeout, not a model failure
	if (result.exitCode === 0 && !result.stopReason) return undefined; // success
	if (result.stopReason === "error" || result.exitCode !== 0) {
		const errMsg = (
			(result.errorMessage || "") +
			" " +
			(result.stderr || "")
		).toLowerCase();
		if (
			/rate.limit|timeout|internal.?server.?error|5\d{2}|unavailable|overloaded|too many|model not available|unsupported model|unknown model/i.test(
				errMsg,
			)
		)
			return true; // transient → retryable
		return false; // permanent error
	}
	return undefined;
}

export function isFailedResult(result: SingleResult): boolean {
	return (
		result.rejected !== undefined ||
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.stopReason === "timeout"
	);
}

export function getResultOutput(result: SingleResult): string {
	if (result.rejected) {
		let msg = `[Task rejected by ${result.agent}]`;
		if (result.rejected.reason) msg += `\nReason: ${result.rejected.reason}`;
		if (result.rejected.suggestion)
			msg += `\nSuggestion: ${result.rejected.suggestion}`;
		return msg;
	}
	const retryLabel =
		result.retryable !== undefined
			? `\n[Retryable: ${result.retryable ? "yes" : "no"}]`
			: "";
	if (isFailedResult(result)) {
		const parts: string[] = [];
		if (result.errorMessage) parts.push(result.errorMessage);
		if (result.stderr) parts.push(result.stderr);
		const output = getFinalOutput(result.messages);
		if (output) parts.push(output);
		return parts.join("\n") || "(no output)" + retryLabel;
	}
	const output = getFinalOutput(result.messages) || "(no output)";
	return output + retryLabel;
}

export function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
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

// ── Concurrency ─────────────────────────────────────────────────────

export async function mapWithConcurrencyLimit<TIn, TOut>(
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
			if (current >= items.length) return undefined;
			const item = items[current];
			if (item === undefined) return undefined;
			results[current] = await fn(item, current);
		}
	});
	await Promise.all(workers);
	return results;
}

// ── Subprocess management ───────────────────────────────────────────

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

/**
 * Inject rejection contract + append-system-prompt, spawn subagent process,
 * stream JSON events, retry through model priority chain on failure.
 */
export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: MakeDetailsFn,
	timeoutMs: number | undefined,
): Promise<SingleResult> {
	const pluginConfig = loadConfig(defaultCwd);
	const resolvedAgentName = pluginConfig.agentAliases?.[agentName] ?? agentName;

	const agent = agents.find((a) => a.name === resolvedAgentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		const aliases = Object.entries(pluginConfig.agentAliases ?? {})
			.filter(([, target]) => agents.some((a) => a.name === target))
			.map(([alias, target]) => `${alias}->${target}`)
			.join(", ");
		const aliasHint = aliases ? ` Available aliases: ${aliases}.` : "";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.${aliasHint}`,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			retryable: false,

			step,
		};
	}

	const models: string[] = [];
	if (agent.model) models.push(agent.model);
	if (agent.modelPriority) models.push(...agent.modelPriority);

	let lastError: SingleResult | null = null;

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
			exitCode: -1,
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

		const emitUpdate = () => {
			if (onUpdate) {
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
			// Assemble system prompt: agent base prompt + rejection contract (always)
			const basePrompt = agent.systemPrompt.trim();
			const systemPrompt = basePrompt
				? basePrompt + "\n\n" + REJECTION_CONTRACT_INSTRUCTION
				: REJECTION_CONTRACT_INSTRUCTION;
			const tmp = await writePromptToTempFile(agent.name, systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);

			args.push(`Task: ${task}`);
			let wasAborted = false;
			let timedOut = false;
			let timeoutTimer: NodeJS.Timeout | undefined;

			const exitCode = await new Promise<number>((resolve) => {
				const invocation = getPiInvocation(args);
				const proc = spawn(invocation.command, invocation.args, {
					cwd: cwd ?? defaultCwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env: {
						...process.env,
						PI_SUBAGENT_CHILD: "1",
					},
				});
				let buffer = "";

				const processLine = (line: string) => {
					if (!line.trim()) return;
					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}

					if (event.type === "message_end" && event.message) {
						const msg = event.message as Message;
						if (msg.role === "assistant") {
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
						}
						currentResult.messages.push(msg);
						emitUpdate();
					}

					if (event.type === "tool_result_end" && event.message) {
						const msg = event.message as Message;
						const last =
							currentResult.messages[currentResult.messages.length - 1];
						if (last?.role !== msg.role) {
							currentResult.messages.push(msg);
						}
						emitUpdate();
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

				const killProc = () => {
					proc.kill("SIGTERM");
					// Windows: proc.kill only terminates the direct child, not its descendants
					if (process.platform === "win32" && proc.pid !== undefined) {
						spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
							stdio: "ignore",
						});
					}
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal) {
					const onAbort = () => {
						wasAborted = true;
						killProc();
					};
					if (signal.aborted) onAbort();
					else
						signal.addEventListener("abort", onAbort, {
							once: true,
						});
				}
				if (timeoutMs !== undefined && timeoutMs > 0) {
					timeoutTimer = setTimeout(() => {
						timedOut = true;
						killProc();
					}, timeoutMs);
				}
			});

			currentResult.exitCode = exitCode;
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (wasAborted) throw new Error("Subagent was aborted");

			// Task timeout: kill already happened; return whatever output arrived
			// (partial results included) instead of retrying the next model.
			if (timedOut) {
				currentResult.stopReason = "timeout";
				currentResult.exitCode = 124;
				currentResult.errorMessage = `Task exceeded ${timeoutMs}ms timeout`;
				currentResult.retryable = false;
				return currentResult;
			}

			// Parse rejection contract from output
			if (!currentResult.rejected) {
				const output = getFinalOutput(currentResult.messages);
				const rejection = parseRejection(output);
				if (rejection.rejected) {
					currentResult.rejected = {
						reason: rejection.reason || "Task rejected by agent",
						suggestion: rejection.suggestion,
					};
				}
			}

			// Determine retryable
			currentResult.retryable = determineRetryable(currentResult);

			if (
				exitCode === 0 &&
				currentResult.stopReason !== "error" &&
				currentResult.stopReason !== "aborted" &&
				!currentResult.rejected
			) {
				return currentResult;
			}

			// Fall through to next model
			lastError = currentResult;
			emitUpdate();
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
		lastError ?? {
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
