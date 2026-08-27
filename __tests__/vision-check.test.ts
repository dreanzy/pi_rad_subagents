import { describe, expect, it } from "vitest";
import { checkVisionRequirement } from "../extensions/index.ts";
import { findModelByRef } from "../extensions/model-check.ts";

const registry = {
	getAll: () => [
		{ id: "gpt-4o", provider: "openai", input: ["text", "image"] },
		{ id: "deepseek-chat", provider: "deepseek", input: ["text"] },
		{ id: "gemini-2.5-flash", provider: "google", input: ["text", "image"] },
	],
};

describe("findModelByRef", () => {
	it("resolves bare ids and provider/model refs", () => {
		expect(findModelByRef(registry, "gpt-4o")?.id).toBe("gpt-4o");
		expect(findModelByRef(registry, "google/gemini-2.5-flash")?.id).toBe(
			"gemini-2.5-flash",
		);
	});

	it("resolves refs with thinking-level suffix", () => {
		expect(findModelByRef(registry, "deepseek/deepseek-chat:high")?.id).toBe(
			"deepseek-chat",
		);
	});

	it("returns undefined for unknown models", () => {
		expect(findModelByRef(registry, "nope-model")).toBeUndefined();
	});
});

describe("checkVisionRequirement", () => {
	const baseAgent = {
		name: "observer",
		requiresVision: true,
		filePath: "agents/observer.md",
	};

	it("passes agents without requiresVision", () => {
		expect(
			checkVisionRequirement(
				{ ...baseAgent, requiresVision: false, model: "deepseek-chat" },
				{ model: undefined, modelRegistry: registry },
			),
		).toBeNull();
	});

	it("fails when configured model lacks vision", () => {
		const err = checkVisionRequirement(
			{ ...baseAgent, model: "deepseek-chat" },
			{ model: undefined, modelRegistry: registry },
		);
		expect(err).toContain("requires a vision-capable model");
		expect(err).toContain("deepseek-chat");
	});

	it("passes when configured model supports images", () => {
		expect(
			checkVisionRequirement(
				{ ...baseAgent, model: "gpt-4o" },
				{ model: undefined, modelRegistry: registry },
			),
		).toBeNull();
	});

	it("falls back to the session model when no model configured", () => {
		expect(
			checkVisionRequirement(
				{ ...baseAgent, model: undefined },
				{
					model: { id: "gpt-4o", provider: "openai", input: ["text", "image"] },
					modelRegistry: registry,
				},
			),
		).toBeNull();
		expect(
			checkVisionRequirement(
				{ ...baseAgent, model: undefined },
				{
					model: {
						id: "deepseek-chat",
						provider: "deepseek",
						input: ["text"],
					},
					modelRegistry: registry,
				},
			),
		).toContain("deepseek-chat");
	});

	it("allows unresolvable models through", () => {
		expect(
			checkVisionRequirement(
				{ ...baseAgent, model: "mystery-model" },
				{ model: undefined, modelRegistry: registry },
			),
		).toBeNull();
	});
});
