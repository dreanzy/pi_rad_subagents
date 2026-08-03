import { describe, it, expect } from "vitest";
import { discoverAgents } from "../extensions/agents.ts";

// discoverAgents reads real config + agent dirs; alias expansion is tested via
// a temp cwd carrying a project .pi/rad-subagents.json with agentAliases.
// The target agent comes from the plugin's builtin agents (explorer/oracle).

describe("discoverAgents alias expansion", () => {
	it("expands aliases into real agent entries", () => {
		const cwd = import.meta.dirname + "/fixtures/aliases";
		const { agents } = discoverAgents(cwd, "user");
		const scout = agents.find((a) => a.name === "scout");
		expect(scout).toBeDefined();
		expect(scout!.description).toContain("alias of explorer");
		expect(scout!.aliasOf).toBe("explorer");
		expect(scout!.systemPrompt).toBe(
			agents.find((a) => a.name === "explorer")!.systemPrompt,
		);
	});

	it("skips aliases whose target does not exist", () => {
		const cwd = import.meta.dirname + "/fixtures/aliases-dangling";
		const { agents } = discoverAgents(cwd, "user");
		expect(agents.find((a) => a.name === "ghost")).toBeUndefined();
	});

	it("keeps real agents on name collision", () => {
		const cwd = import.meta.dirname + "/fixtures/aliases-collision";
		const { agents } = discoverAgents(cwd, "user");
		const clash = agents.find((a) => a.name === "explorer");
		expect(clash).toBeDefined();
		expect(clash!.description).not.toContain("alias of");
		expect(clash!.aliasOf).toBeUndefined();
	});
});
