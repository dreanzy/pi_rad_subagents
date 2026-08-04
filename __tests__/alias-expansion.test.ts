import { describe, it, expect } from "vitest";
import { BUILTIN_ALIASES, discoverAgents } from "../extensions/agents.ts";

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

	describe("built-in aliases", () => {
		it("expands every built-in alias into its target with identical content", () => {
			const cwd = import.meta.dirname + "/fixtures/aliases";
			const { agents } = discoverAgents(cwd, "user");
			const targets = new Map(agents.map((a) => [a.name, a]));
			for (const [alias, targetName] of Object.entries(BUILTIN_ALIASES)) {
				const gp = agents.find((a) => a.name === alias);
				const target = targets.get(targetName);
				expect(gp, `alias ${alias}`).toBeDefined();
				expect(gp!.aliasOf, `alias ${alias}`).toBe(targetName);
				expect(gp!.systemPrompt, `alias ${alias}`).toBe(target!.systemPrompt);
				expect(gp!.tools, `alias ${alias}`).toEqual(target!.tools);
				expect(gp!.model, `alias ${alias}`).toBe(target!.model);
			}
		});

		it("lets user agentAliases override built-in aliases", () => {
			const cwd = import.meta.dirname + "/fixtures/aliases-override-builtin";
			const { agents } = discoverAgents(cwd, "user");
			const gp = agents.find((a) => a.name === "general-purpose");
			expect(gp).toBeDefined();
			expect(gp!.aliasOf).toBe("explorer");
		});

		it("applies JSON agents.<alias> overrides on top of inherited config", () => {
			const cwd = import.meta.dirname + "/fixtures/aliases-overrides-json";
			const { agents } = discoverAgents(cwd, "user");
			const nav = agents.find((a) => a.name === "navigator");
			const explorer = agents.find((a) => a.name === "explorer");
			expect(nav).toBeDefined();
			expect(nav!.aliasOf).toBe("explorer");
			expect(nav!.model).toBe("m1");
			expect(nav!.modelPriority).toEqual(["m2"]);
			expect(nav!.tools).toEqual(["read", "bash"]);
			// Unconfigured fields still inherit from the target.
			expect(nav!.systemPrompt).toBe(explorer!.systemPrompt);
			expect(nav!.description).toContain("alias of explorer");
		});
	});
});
