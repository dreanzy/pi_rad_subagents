/**
 * Orchestrator mode — optional add-on for rad-subagents.
 *
 * When enabled via `/orchestrate`, the model runs as a workflow manager:
 * it plans, delegates to specialist agents, and integrates results.
 *
 * Toggle: `/orchestrate` to enable, `/orchestrate off` to disable.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig, findProjectRadSubagentsConfig } from "./config.ts";

const ORCHESTRATOR_SYSTEM_PROMPT = `
## Role: ORCHESTRATOR

You are a workflow manager — plan, delegate, monitor, reconcile specialist work. NOT the default implementer.

Delegate via \`rad-subagents()\`. Prefer delegation — specialists are 2-5x faster at their domain work.\n\nSyntax: \`rad-subagents(agent, task)\`, parallel via \`tasks[]\`, chain via \`chain[]\`.

## Available Agents

- @explorer: Fast codebase recon, read-only
- @librarian: External knowledge & library research
- @oracle: Architecture, risk, debugging, review, read-only
- @designer: UI/UX design & implementation, read+write
- @fixer: Bounded implementation, read+write
- @observer: Visual/media analysis (images, PDFs), read-only
- @deepwork: Structured deep work — plan, oracle gates, phased implementation

Use: @explorer for discovery, @librarian for research, @oracle for review, @fixer for implementation, @designer for UI.

## Workflow

1. **Understand** — Parse explicit + implicit needs
2. **Choose approach** — Balance quality, speed, cost
3. **Delegate** — Reference paths, not file contents. Keep delegation goals brief (one line). Direct execution OK when overhead dominates.
4. **Plan & parallelize** — Build work graph: independent lanes first, then dependencies, then verify. Avoid conflicting writes across fixers.
5. **Track & reconcile** — Record task state + ownership. Run checks after each phase. Reconcile all results before final response.
6. **Don't implement while subagents are running** — wait for delegation results before editing files yourself.

### Design Handoff
- Designer output (layout, spacing, motion, color) is intentional — don't flatten later.
- Copy-edit after design work, preserving visual intent.
- Mechanical follow-up → @fixer. Visual judgment changes → @designer.

## Communication

Direct, no preamble, no flattery. Push back on problematic approaches concisely. Brief delegation notices: "Checking docs via @librarian..."
`.trim();

function loadOrchestratorEnabled(cwd: string): boolean {
	const config = loadConfig(cwd);
	return config.orchestrator?.enabled !== false; // default true
}

function saveOrchestratorEnabled(enabled: boolean, cwd: string): void {
	const configPath =
		findProjectRadSubagentsConfig(cwd) ??
		path.join(getAgentDir(), "rad-subagents.json");
	try {
		let data: Record<string, unknown> = {};
		try {
			data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
		} catch {
			/* start fresh */
		}
		data.orchestrator = {
			...(data.orchestrator as Record<string, unknown> | undefined),
			enabled,
		};
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
	} catch {
		/* ignore */
	}
}

export function registerOrchestrator(pi: ExtensionAPI): void {
	// Per-session override set by /orchestrate command; null = use config file.
	let sessionOverride: boolean | null = null;

	pi.registerCommand("orchestrate", {
		description: "Toggle orchestrator mode. Usage: /orchestrate [on|off]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const enabled =
				arg === "off" || arg === "0" || arg === "false" || arg === "disable"
					? false
					: true;
			sessionOverride = enabled;
			saveOrchestratorEnabled(enabled, ctx.cwd);
			ctx.ui.notify(`Orchestrator mode: ${enabled ? "on" : "off"}`, "info");
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		// Override takes precedence; fall back to per-project config (TTL-cached).
		const enabled = sessionOverride ?? loadOrchestratorEnabled(ctx.cwd);
		if (!enabled) return undefined;
		return {
			systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT + "\n\n" + event.systemPrompt,
		};
	});
}
