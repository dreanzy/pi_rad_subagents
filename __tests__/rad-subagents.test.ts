import { describe, it, expect } from "vitest";
import { isAgentDisabled, resolveAgentConfig } from "../extensions/config.ts";

describe("isAgentDisabled", () => {
	it("returns false when agent not in config", () => {
		expect(isAgentDisabled("explorer", {})).toBe(false);
	});

	it("returns false when agent is not disabled", () => {
		const config = { agents: { explorer: { disabled: false } } };
		expect(isAgentDisabled("explorer", config)).toBe(false);
	});

	it("returns true when agent disabled", () => {
		const config = { agents: { explorer: { disabled: true } } };
		expect(isAgentDisabled("explorer", config)).toBe(true);
	});
});

describe("resolveAgentConfig", () => {
	it("uses frontmatter description when no JSON override", () => {
		const result = resolveAgentConfig(
			"test",
			{ description: "A test agent" },
			{},
		);
		expect(result.description).toBe("A test agent");
	});

	it("JSON override description takes priority", () => {
		const config = { agents: { test: { description: "Override desc" } } };
		const result = resolveAgentConfig(
			"test",
			{ description: "Frontmatter desc" },
			config,
		);
		expect(result.description).toBe("Override desc");
	});

	it("falls back to agent name when no description available", () => {
		const result = resolveAgentConfig("fallback-name", {}, {});
		expect(result.description).toBe("fallback-name");
	});
});
