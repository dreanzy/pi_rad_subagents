import { describe, it, expect } from "vitest";
import { buildAgentSection } from "../extensions/orchestrator.ts";
import type { AgentConfig } from "../extensions/agents.ts";

function agent(name: string, description = `${name} desc`): AgentConfig {
	return {
		name,
		description,
		systemPrompt: "",
		source: "builtin",
		filePath: `/fake/${name}.md`,
	};
}

// Names here deliberately avoid AGENT_DETAILS keys (the 7 built-ins), which
// override the frontmatter description and would mask the input description.
describe("buildAgentSection", () => {
	it("orders agents by name regardless of input order", () => {
		const shuffled = [agent("zulu"), agent("alpha"), agent("mike")];
		const reversed = [agent("mike"), agent("alpha"), agent("zulu")];

		expect(buildAgentSection(shuffled)).toBe(
			"- @alpha: alpha desc\n- @mike: mike desc\n- @zulu: zulu desc",
		);
		// Byte-stability: the same set in any input order yields the same block.
		expect(buildAgentSection(shuffled)).toBe(buildAgentSection(reversed));
	});

	it("excludes aliases and keeps the real agent", () => {
		const alias: AgentConfig = {
			...agent("scout", "alias of zulu"),
			aliasOf: "zulu",
		};
		const section = buildAgentSection([alias, agent("zulu")]);

		expect(section).toBe("- @zulu: zulu desc");
		expect(section).not.toContain("scout");
	});

	it("prefers the rich AGENT_DETAILS text for built-in agents", () => {
		const section = buildAgentSection([agent("explorer", "frontmatter desc")]);

		expect(section).toContain("- @explorer: Fast codebase recon");
		expect(section).not.toContain("frontmatter desc");
	});

	it("does not mutate the caller's array", () => {
		const input = [agent("zulu"), agent("alpha")];
		buildAgentSection(input);

		expect(input.map((a) => a.name)).toEqual(["zulu", "alpha"]);
	});

	it("returns an empty string for no real agents", () => {
		expect(buildAgentSection([])).toBe("");
	});
});
