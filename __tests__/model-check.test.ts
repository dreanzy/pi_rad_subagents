import { describe, expect, it } from "vitest";
import {
	applyProbeResults,
	checkModels,
	collectModelRefs,
	findModelByRef,
	formatCheckResult,
	probeModelRef,
	stripThinkingLevel,
	validateModelRef,
	type RegistryModelLike,
} from "../extensions/model-check.ts";

const REGISTRY: RegistryModelLike[] = [
	{ id: "deepseek-v4-flash", provider: "deepseek" },
	{ id: "gemini-3.7-flash", provider: "antigravity" },
	{ id: "some-model", provider: "opencode" },
	{ id: "weird:exacto", provider: "openrouter" },
];

function makeRegistry(
	auth: Record<string, boolean> = {
		deepseek: true,
		antigravity: true,
		opencode: false,
		openrouter: true,
	},
) {
	return {
		getAll: () => REGISTRY,
		getProviderAuthStatus: (provider: string) => ({
			configured: auth[provider] ?? false,
		}),
	};
}

describe("stripThinkingLevel", () => {
	it("strips a trailing valid level", () => {
		expect(stripThinkingLevel("deepseek/deepseek-v4-flash:high")).toEqual({
			modelRef: "deepseek/deepseek-v4-flash",
			level: "high",
		});
	});

	it("keeps an unknown suffix (colons inside model id)", () => {
		expect(stripThinkingLevel("openrouter/weird:exacto")).toEqual({
			modelRef: "openrouter/weird:exacto",
			level: undefined,
		});
	});

	it("keeps a ref without colons", () => {
		expect(stripThinkingLevel("deepseek-v4-flash")).toEqual({
			modelRef: "deepseek-v4-flash",
			level: undefined,
		});
	});
});

describe("findModelByRef", () => {
	it("matches provider/id", () => {
		expect(findModelByRef(makeRegistry(), "deepseek/deepseek-v4-flash")).toEqual(
			REGISTRY[0],
		);
	});

	it("matches bare id", () => {
		expect(findModelByRef(makeRegistry(), "gemini-3.7-flash")).toEqual(
			REGISTRY[1],
		);
	});

	it("returns undefined for unknown", () => {
		expect(findModelByRef(makeRegistry(), "nope/does-not-exist")).toBeUndefined();
	});
});

describe("validateModelRef", () => {
	it("accepts a known, authenticated model with level", () => {
		expect(
			validateModelRef(makeRegistry(), "deepseek/deepseek-v4-flash:high"),
		).toEqual({
			ok: true,
		});
	});

	it("rejects unknown model", () => {
		const r = validateModelRef(makeRegistry(), "deepseek/nope");
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("not found");
	});

	it("rejects unauthenticated provider", () => {
		const r = validateModelRef(makeRegistry(), "opencode/some-model");
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("not authenticated");
	});

	it("rejects unknown provider even with bare id match elsewhere", () => {
		const r = validateModelRef(makeRegistry(), "nope/gemini-3.7-flash");
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("not found");
	});
});

describe("collectModelRefs", () => {
	it("collects defaultModel, primary, and fallbacks", () => {
		const entries = collectModelRefs(
			{
				defaultModel: "deepseek/deepseek-v4-flash",
				agents: {
					explorer: { model: ["deepseek/a", "deepseek/b", "deepseek/c"] },
					oracle: { model: "deepseek/o" },
					disabled: { model: "deepseek/x", disabled: true },
				},
			},
			"/tmp/x.json",
			"test",
		);
		expect(entries).toHaveLength(6);
		expect(entries[0]).toMatchObject({ kind: "default", agent: "(default)" });
		expect(entries[1]).toMatchObject({ kind: "primary", agent: "explorer" });
		expect(entries[2]).toMatchObject({ kind: "fallback", agent: "explorer" });
		expect(entries[3]).toMatchObject({ kind: "fallback", agent: "explorer" });
		expect(entries[4]).toMatchObject({ kind: "primary", agent: "oracle" });
		expect(entries[5]).toMatchObject({ kind: "primary", agent: "disabled" });
	});

	it("skips empty/non-string refs", () => {
		const entries = collectModelRefs(
			{ defaultModel: "", agents: { a: { model: [] }, b: { model: 42 } } },
			"/tmp/x.json",
			"test",
		);
		expect(entries).toHaveLength(0);
	});
});

describe("checkModels", () => {
	it("flags invalid and counts valid", () => {
		const result = checkModels(makeRegistry(), [
			{
				label: "global",
				path: "/g.json",
				config: {
					defaultModel: "deepseek/deepseek-v4-flash",
					agents: {
						explorer: {
							model: ["opencode/some-model", "deepseek/deepseek-v4-flash"],
						},
					},
				},
			},
		]);
		expect(result.valid).toHaveLength(2);
		expect(result.invalid).toHaveLength(1);
		expect(result.invalid[0]).toMatchObject({
			agent: "explorer",
			kind: "primary",
			ref: "opencode/some-model",
		});
	});

	it("reports per-file grouping", () => {
		const result = checkModels(makeRegistry(), [
			{
				label: "project",
				path: "/p.json",
				config: { agents: { a: { model: "nope/x" } } },
			},
			{
				label: "global",
				path: "/g.json",
				config: { agents: { b: { model: "deepseek/deepseek-v4-flash" } } },
			},
		]);
		expect(result.invalid.map((i) => i.fileLabel)).toEqual(["project"]);
		expect(result.valid.map((v) => v.fileLabel)).toEqual(["global"]);
	});
});

describe("formatCheckResult", () => {
	it("reports all-valid summary", () => {
		const text = formatCheckResult({
			valid: [
				{
					filePath: "/g.json",
					fileLabel: "global",
					agent: "explorer",
					kind: "primary",
					ref: "deepseek/deepseek-v4-flash",
				},
			],
			invalid: [],
		});
		expect(text).toContain("All 1 model references are valid.");
		expect(text).toContain("Summary: 1 references, 1 valid, 0 invalid.");
	});

	it("lists invalid refs with reasons", () => {
		const text = formatCheckResult({
			valid: [],
			invalid: [
				{
					filePath: "/g.json",
					fileLabel: "global",
					agent: "explorer",
					kind: "primary",
					ref: "opencode/some-model",
					reason: 'provider "opencode" not authenticated',
				},
				{
					filePath: "/p.json",
					fileLabel: "project",
					agent: "oracle",
					kind: "fallback",
					ref: "deepseek/nope",
					reason: 'model not found: "deepseek/nope"',
				},
			],
		});
		expect(text).toContain("✗ global → explorer [primary]: opencode/some-model");
		expect(text).toContain('provider "opencode" not authenticated');
		expect(text).toContain("✗ project → oracle [fallback]: deepseek/nope");
		expect(text).toContain("Summary: 2 references, 0 valid, 2 invalid.");
	});
});

describe("probeModelRef", () => {
	it("flags unsupported_model as invalid", async () => {
		const r = await probeModelRef(async () => {
			throw new Error(
				'400: {"message":"Model \"stealth/ox-alpha\" is not supported on this endpoint.","code":"unsupported_model"}',
			);
		}, "command-code/stealth/ox-alpha:max");
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("model unavailable");
	});

	it("flags auth errors as invalid", async () => {
		const r = await probeModelRef(async () => {
			throw new Error("401 unauthorized: invalid api key");
		}, "deepseek/deepseek-v4-flash");
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("probe auth error");
	});

	it("treats transient errors (rate limit) as inconclusive (ok)", async () => {
		const r = await probeModelRef(async () => {
			throw new Error("429 Too Many Requests: rate limit exceeded");
		}, "deepseek/deepseek-v4-flash");
		expect(r.ok).toBe(true);
	});

	it("passes a successful probe", async () => {
		const r = await probeModelRef(async () => "ok", "deepseek/deepseek-v4-flash");
		expect(r.ok).toBe(true);
	});
});

describe("applyProbeResults", () => {
	it("moves failed probes from valid to invalid", () => {
		const entry = {
			filePath: "/g.json",
			fileLabel: "global",
			agent: "explorer",
			kind: "primary" as const,
			ref: "command-code/stealth/ox-alpha:max",
		};
		const result = {
			valid: [entry],
			invalid: [],
		};
		applyProbeResults(result, [
			{ ok: false, reason: "model unavailable: unsupported_model" },
		]);
		expect(result.valid).toHaveLength(0);
		expect(result.invalid).toHaveLength(1);
		expect(result.invalid[0]).toMatchObject({
			ref: "command-code/stealth/ox-alpha:max",
			reason: "model unavailable: unsupported_model",
		});
	});

	it("keeps entries whose probe passed", () => {
		const entry = {
			filePath: "/g.json",
			fileLabel: "global",
			agent: "explorer",
			kind: "primary" as const,
			ref: "deepseek/deepseek-v4-flash",
		};
		const result = { valid: [entry], invalid: [] };
		applyProbeResults(result, [{ ok: true }]);
		expect(result.valid).toHaveLength(1);
		expect(result.invalid).toHaveLength(0);
	});
});
