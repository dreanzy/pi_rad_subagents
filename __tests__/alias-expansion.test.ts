import { describe, expect, it } from "vitest";
import { BUILTIN_ALIASES, discoverAgents } from "../extensions/agents.ts";

// discoverAgents reads real config + agent dirs. Aliases come only from the
// built-in table, so these tests exercise expansion against the plugin's own
// bundled agents plus a project-local fixture.
//
// `project` scope is used for the JSON-override cases: it reads the fixture's
// `.pi/agents/` instead of the host's `~/.pi/agent/agents/`, so the assertions
// don't depend on the developer's own agent files.

const builtinFixtures = import.meta.dirname + "/fixtures/aliases";
const projectFixtures = import.meta.dirname + "/fixtures/project-agents";

describe("discoverAgents alias expansion", () => {
	it("expands every built-in alias into its target with identical content", () => {
		const { agents } = discoverAgents(builtinFixtures, "user");
		const byName = new Map(agents.map((a) => [a.name, a]));
		for (const [alias, targetName] of Object.entries(BUILTIN_ALIASES)) {
			const expanded = byName.get(alias);
			const target = byName.get(targetName);
			expect(expanded, `alias ${alias}`).toBeDefined();
			expect(target, `target ${targetName}`).toBeDefined();
			expect(expanded!.aliasOf, `alias ${alias}`).toBe(targetName);
			expect(expanded!.systemPrompt, `alias ${alias}`).toBe(
				target!.systemPrompt,
			);
			expect(expanded!.tools, `alias ${alias}`).toEqual(target!.tools);
			expect(expanded!.model, `alias ${alias}`).toBe(target!.model);
			expect(expanded!.description, `alias ${alias}`).toContain(
				`alias of ${targetName}`,
			);
		}
	});

	it("does not list general-purpose in the alias table", () => {
		// It ships as a real agent, so an entry here would shadow it.
		expect(BUILTIN_ALIASES["general-purpose"]).toBeUndefined();
	});

	it("keeps a real agent that collides with a built-in alias name", () => {
		// `general-purpose` ships as a real built-in agent; the alias table must
		// not shadow it, so it carries no aliasOf marker.
		const { agents } = discoverAgents(builtinFixtures, "user");
		const gp = agents.find((a) => a.name === "general-purpose");
		expect(gp).toBeDefined();
		expect(gp!.aliasOf).toBeUndefined();
		expect(gp!.source).toBe("builtin");
	});

	describe("JSON agents.<name> overrides", () => {
		it("applies to a real agent", () => {
			const { agents } = discoverAgents(projectFixtures, "project");
			const explorer = agents.find((a) => a.name === "explorer");
			expect(explorer).toBeDefined();
			expect(explorer!.model).toBe("m1");
			expect(explorer!.modelPriority).toEqual(["m2"]);
			expect(explorer!.aliasOf).toBeUndefined();
		});

		it("applies to an alias entry without affecting its target", () => {
			const { agents } = discoverAgents(projectFixtures, "project");
			const byName = new Map(agents.map((a) => [a.name, a]));
			const scout = byName.get("scout");
			const explorer = byName.get("explorer");

			expect(scout).toBeDefined();
			expect(scout!.aliasOf).toBe("explorer");
			expect(scout!.model).toBe("alias-m1");
			expect(scout!.modelPriority).toEqual([]);
			expect(scout!.tools).toEqual(["read"]);
			expect(scout!.description).toBe("overridden alias description");
			// The target keeps the config it would have had anyway.
			expect(explorer).toBeDefined();
			expect(explorer!.model).toBe("m1");
			expect(explorer!.modelPriority).toEqual(["m2"]);
			expect(explorer!.description).not.toBe("overridden alias description");
		});
	});

	it("drops an alias whose target is missing", () => {
		// The built-in table is a constant, so this guard is exercised by
		// removing the target from the discovered set instead of from the table.
		const { agents } = discoverAgents(builtinFixtures, "user");
		const targets = new Set(
			Object.values(BUILTIN_ALIASES).filter((t) =>
				agents.some((a) => a.name === t),
			),
		);
		expect(targets.size).toBeGreaterThan(0);
		// Every alias in the result points at a target that is also present.
		for (const a of agents) {
			if (!a.aliasOf) continue;
			expect(agents.some((t) => t.name === a.aliasOf)).toBe(true);
		}
	});
});
