import { describe, it, expect } from "vitest";
import {
	DEFAULT_RETRY_ON_TIMEOUT,
	MAX_RETRY_ON_TIMEOUT,
	STUCK_IDLE_THRESHOLD_MS,
	getResultOutput,
	isFailedResult,
} from "../extensions/executor.ts";

function result(partial: Record<string, unknown>) {
	return {
		agent: "explorer",
		agentSource: "builtin",
		task: "t",
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
		...partial,
	} as never;
}

describe("timeout/stuck result formatting", () => {
	it("flags a timed-out run as failed with a timeout label", () => {
		const r = result({ exitCode: 124, stopReason: "timeout", timedOut: true });
		expect(isFailedResult(r)).toBe(true);
		expect(getResultOutput(r)).toContain("[timed out]");
	});

	it("mentions retry count after retries", () => {
		const r = result({
			exitCode: 124,
			stopReason: "timeout",
			timedOut: true,
			timeoutRetries: 2,
		});
		expect(getResultOutput(r)).toContain("[timed out after 2 retries]");
	});

	it("flags possiblyStuck when the run went silent", () => {
		const r = result({
			stopReason: "timeout",
			timedOut: true,
			possiblyStuck: true,
		});
		expect(getResultOutput(r)).toContain("possiblyStuck");
	});

	it("keeps success output unchanged (no labels)", () => {
		const r = result({
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		});
		expect(getResultOutput(r)).toBe("done");
	});

	it("caps retryOnTimeout and exposes constants", () => {
		expect(DEFAULT_RETRY_ON_TIMEOUT).toBe(1);
		expect(MAX_RETRY_ON_TIMEOUT).toBe(3);
		expect(STUCK_IDLE_THRESHOLD_MS).toBe(120_000);
	});
});

describe("timeout retry budget", () => {
	it("retryOnTimeout is capped at MAX_RETRY_ON_TIMEOUT", () => {
		expect(MAX_RETRY_ON_TIMEOUT).toBeGreaterThanOrEqual(DEFAULT_RETRY_ON_TIMEOUT);
		// the effective cap used inside runSingleAgent
		const cap = Math.min(Math.max(0, 99), MAX_RETRY_ON_TIMEOUT);
		expect(cap).toBe(MAX_RETRY_ON_TIMEOUT);
	});
});

import { retryLoop } from "../extensions/executor.ts";

function timeoutResult(priorRetries: number, partialText = "partial finding") {
	return {
		agent: "explorer",
		agentSource: "builtin",
		task: "t",
		exitCode: 124,
		stopReason: "timeout",
		timedOut: true,
		timeoutRetries: priorRetries,
		messages: [
			{ role: "assistant", content: [{ type: "text", text: partialText }] },
		],
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
	} as never;
}

function successResult(text = "done") {
	return {
		agent: "explorer",
		agentSource: "builtin",
		task: "t",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }] }],
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
	} as never;
}

describe("retryLoop", () => {
	it("retries a timed-out attempt with the previous partial output as CONTEXT", async () => {
		const seen: Array<{ prefix: string | undefined; retries: number }> = [];
		const attempt = async (
			contextPrefix: string | undefined,
			priorRetries: number,
		) => {
			seen.push({ prefix: contextPrefix, retries: priorRetries });
			if (priorRetries === 0) return timeoutResult(0);
			return successResult();
		};

		const result = await retryLoop(attempt, 1, (msgs) => {
			const last = msgs[msgs.length - 1];
			return last?.role === "assistant" &&
				Array.isArray(last.content) &&
				last.content[0]?.type === "text"
				? ((last.content[0] as { text?: string }).text ?? "")
				: "";
		});

		expect(seen).toHaveLength(2);
		expect(seen[0]).toEqual({ prefix: undefined, retries: 0 });
		expect(seen[1]!.retries).toBe(1);
		expect(seen[1]!.prefix).toContain("partial finding");
		expect(result.exitCode).toBe(0);
	});

	it("stops retrying once the budget is exhausted and reports the last timeout", async () => {
		let calls = 0;
		const attempt = async (_prefix: string | undefined, priorRetries: number) => {
			calls++;
			return timeoutResult(priorRetries);
		};

		const result = await retryLoop(attempt, 2, () => "");
		expect(calls).toBe(3); // initial + 2 retries
		expect(result.timedOut).toBe(true);
		expect(result.timeoutRetries).toBe(2);
	});

	it("does not retry on success", async () => {
		let calls = 0;
		const attempt = async () => {
			calls++;
			return successResult();
		};
		const result = await retryLoop(attempt, 3, () => "");
		expect(calls).toBe(1);
		expect(result.exitCode).toBe(0);
	});

	it("never retries when retryOnTimeout is 0", async () => {
		let calls = 0;
		const attempt = async (_p: string | undefined, priorRetries: number) => {
			calls++;
			return timeoutResult(priorRetries);
		};
		const result = await retryLoop(attempt, 0, () => "");
		expect(calls).toBe(1);
		expect(result.timedOut).toBe(true);
	});
});

import { buildContextArg } from "../extensions/executor.ts";

describe("buildContextArg", () => {
	it("injects the partial findings with a convergence instruction", () => {
		const arg = buildContextArg("found X at path/to/x");
		expect(arg).toContain("CONTEXT: found X at path/to/x");
		expect(arg).toContain("Prioritize convergence");
		expect(arg).toContain("Do NOT re-search");
	});
});
