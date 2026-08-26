/**
 * Configuration system for the rad-subagents extension.
 *
 * Supports three tiers of config sources:
 *   1. Project-level `.pi/rad-subagents.json` (walked up from cwd)
 *   2. Global `~/.pi/agent/rad-subagents.json`
 *   3. Markdown agent files with YAML frontmatter — default values
 *
 * Priority: Project JSON > Global JSON > .md frontmatter > built-in defaults
 */
/// <reference types="node" />

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

// ── TTL cache ────────────────────────────────────────────────────────
/**
 * Minimal TTL cache: entries expire `ttlMs` after being set.
 */
export function createTtlCache<T>(ttlMs: number): {
	get(key: string): T | undefined;
	set(key: string, value: T): void;
} {
	const store = new Map<string, { data: T; expiry: number }>();
	return {
		get(key) {
			const cached = store.get(key);
			if (cached && Date.now() < cached.expiry) return cached.data;
			return undefined;
		},
		set(key, value) {
			store.set(key, { data: value, expiry: Date.now() + ttlMs });
		},
	};
}

const configCache = createTtlCache<RadSubagentsPluginConfig>(5000);

// ── Types ────────────────────────────────────────────────────────────

interface AgentOverrideConfig {
	/**
	 * Primary model, or array of fallback models (first = primary, rest = fallbacks).
	 * Supports "model:level" syntax (e.g. "claude-sonnet-4-5:high") — pi natively
	 * parses the ":level" suffix as the thinking level.
	 */
	model?: string | string[];
	tools?: string[];
	temperature?: number;
	description?: string;
	displayName?: string;
	disabled?: boolean;
}

export interface RadSubagentsPluginConfig {
	/** Per-agent overrides. Key is agent name (e.g. "explorer", "orchestrator"). */
	agents?: Record<string, AgentOverrideConfig>;

	/**
	 * Alias mapping: maps agent names that don’t exist to ones that do.
	 * Useful when skills reference agents from other ecosystems (e.g. @scout, @worker)
	 * that aren’t defined in this project, avoiding wasted “unknown agent” calls.
	 * Key = alias name (the unknown agent), value = real agent name to delegate to.
	 */
	agentAliases?: Record<string, string>;

	/** Default model to use for agents that don’t have one specified. */
	defaultModel?: string;

	/** Orchestrator configuration */
	orchestrator?: {
		/** Whether the orchestrator auto-delegates tasks. Default: true */
		enabled?: boolean;
		/** Default agent to route to when orchestrator is active. Default: "auto" */
		defaultMode?: "auto" | "single" | "chain";
	};
}

// ── Config loading ───────────────────────────────────────────────────

/**
 * Find project-level `.pi/rad-subagents.json` by walking up from cwd.
 */
export function findProjectRadSubagentsConfig(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(
			currentDir,
			CONFIG_DIR_NAME,
			"rad-subagents.json",
		);
		if (fs.existsSync(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Find global `~/.pi/agent/rad-subagents.json`.
 */
function findGlobalRadSubagentsConfig(): string | null {
	const globalPath = path.join(getAgentDir(), "rad-subagents.json");
	return fs.existsSync(globalPath) ? globalPath : null;
}

/**
 * Load the rad-subagents plugin configuration.
 * Merges project-level JSON on top of global JSON:
 *   - agents: per-agent shallow merge (project overrides same keys)
 *   - agentAliases: merged, project overrides
 *   - orchestrator: merged, project overrides
 *   - other top-level: project overrides global
 */
export function loadConfig(cwd: string): RadSubagentsPluginConfig {
	const cached = configCache.get(cwd);
	if (cached) return cached;

	const projectConfigPath = findProjectRadSubagentsConfig(cwd);
	const globalConfigPath = findGlobalRadSubagentsConfig();

	// Read both configs
	const projectConfig: RadSubagentsPluginConfig = projectConfigPath
		? readJSONSafe(projectConfigPath)
		: {};
	const globalConfig: RadSubagentsPluginConfig = globalConfigPath
		? readJSONSafe(globalConfigPath)
		: {};

	// Merge: global as base, project overrides
	// agents: per-agent shallow merge
	const mergedAgents: Record<string, AgentOverrideConfig> = {};
	for (const key of new Set([
		...Object.keys(globalConfig.agents ?? {}),
		...Object.keys(projectConfig.agents ?? {}),
	])) {
		mergedAgents[key] = {
			...globalConfig.agents?.[key],
			...projectConfig.agents?.[key],
		};
	}

	// agentAliases: global → project override
	const mergedAliases = {
		...globalConfig.agentAliases,
		...projectConfig.agentAliases,
	};

	// orchestrator: merged, project overrides
	const mergedOrchestrator = {
		...globalConfig.orchestrator,
		...projectConfig.orchestrator,
	};

	const merged: RadSubagentsPluginConfig = {
		// top-level: global as base, project overrides
		...globalConfig,
		...projectConfig,
		// re-apply merged sub-objects
		agents: Object.keys(mergedAgents).length > 0 ? mergedAgents : undefined,
		agentAliases:
			Object.keys(mergedAliases).length > 0 ? mergedAliases : undefined,
		orchestrator:
			Object.keys(mergedOrchestrator).length > 0 ? mergedOrchestrator : undefined,
	};

	configCache.set(cwd, merged);
	return merged;
}

export function readJSONSafe(filePath: string): RadSubagentsPluginConfig {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		// Strip a UTF-8 BOM (RFC 8259 permits one; e.g. Windows Notepad) so JSON.parse does not choke.
		return JSON.parse(raw.replace(/^\uFEFF/, "")) as RadSubagentsPluginConfig;
	} catch (err) {
		console.error(`[rad-subagents] Failed to read config at ${filePath}:`, err);
		return {};
	}
}

// ── Agent config resolution ──────────────────────────────────────────

/**
 * Resolve the effective configuration for an agent name.
 * Merges: JSON config overrides on top of .md frontmatter defaults.
 */
export function resolveAgentConfig(
	agentName: string,
	frontmatter: Record<string, string>,
	pluginConfig: RadSubagentsPluginConfig,
): {
	/** Primary model. Supports "model:level" syntax e.g. "claude-sonnet-4-5:high". */
	model: string | undefined;
	/** Fallback models in priority order (excluding primary). */
	modelPriority: string[];
	tools: string[] | undefined;
	description: string;
} {
	const configOverride = pluginConfig.agents?.[agentName];

	// Resolve model: JSON > frontmatter > defaultModel > undefined (inherits main session)
	const frontmatterModel = frontmatter.model;
	const overrideModel = configOverride?.model;
	const defaultModelVal = pluginConfig.defaultModel;

	// Normalize JSON model (array or string) to an ordered list; first = primary, rest = fallbacks
	const overrideModels =
		Array.isArray(overrideModel) && overrideModel.length > 0
			? overrideModel
			: typeof overrideModel === "string" && overrideModel.length > 0
				? [overrideModel]
				: undefined;

	const primaryModel =
		overrideModels?.[0] ?? frontmatterModel ?? defaultModelVal;
	const modelPriority = overrideModels ? overrideModels.slice(1) : [];

	// Non-model fields: JSON > frontmatter
	// Empty strings pass through intentionally: `tools: []` joins to "" and
	// means "clear the list", NOT "fall back to the frontmatter value".
	const toolsRaw = configOverride?.tools?.join(",") ?? frontmatter.tools ?? "";
	const tools = toolsRaw
		.split(",")
		.map((t: string) => t.trim())
		.filter(Boolean);

	const description =
		configOverride?.description ?? frontmatter.description ?? agentName;

	return {
		model: primaryModel,
		modelPriority,
		tools: tools.length > 0 ? tools : undefined,
		description,
	};
}
/**
 * Check if an agent is disabled via JSON config.
 */
export function isAgentDisabled(
	agentName: string,
	pluginConfig: RadSubagentsPluginConfig,
): boolean {
	return pluginConfig.agents?.[agentName]?.disabled === true;
}
