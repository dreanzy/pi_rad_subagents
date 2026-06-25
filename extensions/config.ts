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

// ── Types ────────────────────────────────────────────────────────────

export interface AgentOverrideConfig {
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
export function findGlobalRadSubagentsConfig(): string | null {
	const globalPath = path.join(getAgentDir(), "rad-subagents.json");
	return fs.existsSync(globalPath) ? globalPath : null;
}

let cachedConfig: RadSubagentsPluginConfig | null = null;
let cachedConfigPath: string | null = null;

/**
 * Load the rad-subagents plugin configuration.
 * Caches the result; call `clearConfigCache()` to reload.
 */
export function loadConfig(cwd: string): RadSubagentsPluginConfig {
	if (cachedConfig) return cachedConfig;

	const projectConfigPath = findProjectRadSubagentsConfig(cwd);
	const globalConfigPath = findGlobalRadSubagentsConfig();

	// Priority: project-level > global > defaults
	const configPath = projectConfigPath ?? globalConfigPath;

	if (!configPath) {
		cachedConfig = {};
		cachedConfigPath = null;
		return cachedConfig;
	}

	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as RadSubagentsPluginConfig;

		// If both configs exist, merge agentAliases from global config into project config
		// so global aliases also take effect when both are present (project overrides same keys)
		if (projectConfigPath && globalConfigPath) {
			try {
				const globalRaw = fs.readFileSync(globalConfigPath, "utf-8");
				const globalParsed = JSON.parse(globalRaw) as RadSubagentsPluginConfig;
				if (globalParsed.agentAliases) {
					parsed.agentAliases = {
						...globalParsed.agentAliases,
						...parsed.agentAliases, // project overrides same keys
					};
				}
			} catch (globalErr) {
				console.error(
					`[rad-subagents] Failed to read global config at ${globalConfigPath}:`,
					globalErr,
				);
			}
		}

		cachedConfig = parsed;
		cachedConfigPath = configPath;
		return parsed;
	} catch (err) {
		console.error(
			`[rad-subagents] Failed to parse config at ${configPath}:`,
			err,
		);
		cachedConfig = {};
		cachedConfigPath = configPath;
		return cachedConfig;
	}
}

/** Clear the config cache (useful for hot-reload scenarios). */
export function clearConfigCache(): void {
	cachedConfig = null;
	cachedConfigPath = null;
}

/**
 * Get the path of the loaded config file, if any.
 * @deprecated Use `findProjectRadSubagentsConfig(cwd) ?? findGlobalRadSubagentsConfig()`
 * directly instead. This function only returns the path that was cached during
 * the last `loadConfig()` call, which may be stale after `clearConfigCache()`.
 */
export function getConfigPath(): string | null {
	return cachedConfigPath;
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

	// Resolve model: override > frontmatter > defaultModel
	const overrideModel = configOverride?.model;
	const frontmatterModel = frontmatter.model;
	const defaultModelVal = pluginConfig.defaultModel;

	let primaryModel: string | undefined;
	let modelPriority: string[] = [];

	if (Array.isArray(overrideModel)) {
		const [first, ...rest] = overrideModel;
		primaryModel = first;
		modelPriority = rest;
	} else if (typeof overrideModel === "string") {
		primaryModel = overrideModel;
	} else if (frontmatterModel) {
		primaryModel = frontmatterModel;
	} else if (defaultModelVal) {
		primaryModel = defaultModelVal;
	}

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
