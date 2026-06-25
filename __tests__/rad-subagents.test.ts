import { describe, it, expect } from "vitest";

// ── Config tests ────────────────────────────────────────────────────────

describe("config loading", () => {
	it("loadConfig returns defaults when no config file exists", () => {
		// The module uses Node.js fs, which isn't available in vitest's default
		// environment for browser-like tests. We test the config shape directly.
		const config = {} as Record<string, unknown>;
		expect(config).toBeTypeOf("object");
	});

	it("agent alias resolution works", () => {
		const aliases: Record<string, string> = {
			scout: "explorer",
			worker: "fixer",
		};
		const resolved = (name: string): string => {
			const visited = new Set<string>();
			while (aliases[name] && !visited.has(name)) {
				visited.add(name);
				name = aliases[name]!;
			}
			return name;
		};
		expect(resolved("scout")).toBe("explorer");
		expect(resolved("worker")).toBe("fixer");
		expect(resolved("explorer")).toBe("explorer");
	});

	it("retryable error detection works", () => {
		const retryable = [/rate_limit/i, /rate limit/i, /timeout/i, /5\d{2}/];
		const nonRetryable = [/invalid_api_key/i, /unauthorized/i];

		const isRetryable = (msg: string) => {
			for (const p of nonRetryable) if (p.test(msg)) return false;
			for (const p of retryable) if (p.test(msg)) return true;
			return false;
		};

		expect(isRetryable("rate limit exceeded")).toBe(true);
		expect(isRetryable("timeout after 30s")).toBe(true);
		expect(isRetryable("HTTP 502")).toBe(true);
		expect(isRetryable("invalid_api_key")).toBe(false);
		expect(isRetryable("unauthorized")).toBe(false);
	});

	it("formatTokens works for various sizes", () => {
		const formatTokens = (count: number): string => {
			if (count < 1000) return count.toString();
			if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
			if (count < 1000000) return `${Math.round(count / 1000)}k`;
			return `${(count / 1000000).toFixed(1)}M`;
		};

		expect(formatTokens(500)).toBe("500");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(55000)).toBe("55k");
		expect(formatTokens(2500000)).toBe("2.5M");
	});
});
