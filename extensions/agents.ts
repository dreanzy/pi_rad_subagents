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

// ── TTL cache ────────────────────────────────────────────────────────
const discoverCache = new Map<
	string,
	{ data: AgentDiscoveryResult; expiry: number }
>();
const DISCOVER_CACHE_TTL = 5000; // 5 seconds

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Fallback models in priority order (excluding primary). */
	modelPriority?: string[];
	/** Agent requires a vision-capable model (enforced at delegation time). */
	requiresVision?: boolean;
	/** Alias of a real agent (set only on entries expanded from agentAliases). */
	aliasOf?: string;
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
			requiresVision: frontmatter.requiresVision === "true",
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
	const cacheKey = `${cwd}:${scope}`;
	const now = Date.now();
	const cached = discoverCache.get(cacheKey);
	if (cached && now < cached.expiry) return cached.data;

	const pluginConfig = loadConfig(cwd);
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir =
		scope === "user" ? null : findNearestProjectAgentsDir(cwd);

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

	// Expand agentAliases into real agent entries so aliases are visible to the
	// LLM at decision time (available-agent lists, vision checks, @-mentions).
	// Real agents win on name collision; dangling aliases (target missing) are
	// skipped with a warning. Chained aliases (A->B where B is itself an alias)
	// are not supported; expansion follows insertion order.
	for (const [alias, targetName] of Object.entries(
		pluginConfig.agentAliases ?? {},
	)) {
		if (agentMap.has(alias)) continue;
		const target = agentMap.get(targetName);
		if (!target) {
			console.warn(
				`[rad-subagents] agentAliases: alias "${alias}" targets unknown agent "${targetName}", skipped`,
			);
			continue;
		}
		agentMap.set(alias, {
			...target,
			name: alias,
			description: `${target.description} (alias of ${targetName})`,
			aliasOf: targetName,
		});
	}

	const result: AgentDiscoveryResult = {
		agents: Array.from(agentMap.values()),
		projectAgentsDir,
	};
	discoverCache.set(cacheKey, {
		data: result,
		expiry: now + DISCOVER_CACHE_TTL,
	});
	return result;
}
