/**
 * Agent discovery and configuration
 *
 * Supports two configuration sources merged together:
 *   1. JSON config file (`.pi/rad-subagents.json`) — optional overrides
 *   2. Markdown agent files with YAML frontmatter — default values
 *
 * Priority: JSON config > .md frontmatter > built-in defaults
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
	type RadSubagentsPluginConfig,
	loadConfig,
	resolveAgentConfig,
	isAgentDisabled,
} from "./config.ts";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Fallback models in priority order (excluding primary). */
	modelPriority?: string[];
	systemPrompt: string;
	source: "user" | "project" | "builtin";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * Load agents from a directory, applying JSON config overrides.
 */
function loadAgentsFromDir(
	dir: string,
	source: "user" | "project" | "builtin",
	pluginConfig: RadSubagentsPluginConfig,
): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } =
			parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		// Check if JSON config disables this agent
		if (isAgentDisabled(frontmatter.name, pluginConfig)) {
			continue;
		}

		// Resolve effective config: merge JSON overrides on top of frontmatter
		const resolved = resolveAgentConfig(
			frontmatter.name,
			frontmatter,
			pluginConfig,
		);

		agents.push({
			name: frontmatter.name,
			description: resolved.description,
			tools: resolved.tools,
			model: resolved.model,
			modelPriority: resolved.modelPriority,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(
	cwd: string,
	scope: AgentScope,
): AgentDiscoveryResult {
	const pluginConfig = loadConfig(cwd);
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents =
		scope === "project" ? [] : loadAgentsFromDir(userDir, "user", pluginConfig);
	const projectAgents =
		scope === "user" || !projectAgentsDir
			? []
			: loadAgentsFromDir(projectAgentsDir, "project", pluginConfig);

	const builtinDir = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"agents",
	);
	const builtinAgents = loadAgentsFromDir(builtinDir, "builtin", pluginConfig);

	const agentMap = new Map<string, AgentConfig>();

	for (const agent of builtinAgents) agentMap.set(agent.name, agent);

	if (scope !== "project") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	}
	if (scope !== "user") {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
