/**
 * Model reference validation for rad-subagents config.
 *
 * Checks every model reference in the project and global rad-subagents.json
 * (defaultModel + agents.*.model, including fallback array entries) against
 * the pi model registry: the reference must resolve to a known model AND its
 * provider must have configured auth. Thinking-level suffixes (:high, :max)
 * are stripped before matching (they are not validated here — pi tolerates
 * unknown levels at runtime).
 *
 * Also provides live-probe classification: registry snapshots can list models
 * the endpoint no longer serves (delisted), which only a real request reveals.
 */

// Mirrors pi's internal VALID_THINKING_LEVELS (cli/args.ts, not exported from
// the package entry). Kept in sync manually; levels: off/minimal/low/medium/
// high/xhigh/max.
export const VALID_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

/** Minimal shape of a registry model that validation needs. */
export interface RegistryModelLike {
	id: string;
	provider: string;
	/** Input modalities; present when the caller needs vision checks. */
	input?: string[];
}

/** A single model reference found in a config file. */
export interface ModelRefEntry {
	filePath: string;
	fileLabel: string;
	agent: string;
	kind: "primary" | "fallback" | "default";
	ref: string;
}

export interface CheckResult {
	/** References that resolved to a known, authenticated model. */
	valid: ModelRefEntry[];
	/** References that failed (not found / not authenticated). */
	invalid: Array<ModelRefEntry & { reason: string }>;
}

// ── Live probe classification ───────────────────────────────────────

/** Model-level errors that mean "this model is gone/broken", not transient. */
const MODEL_LEVEL_ERROR_RE =
	/unsupported_model|model_not_found|model not found|no such model|unknown model|does not exist|not supported on this endpoint|not supported|retired|permission_error|forbidden/i;

/**
 * Classify a probe error message: "model" (delisted/broken model),
 * "auth" (credential problem), or "transient" (rate limit, network, 5xx).
 * Transient errors are inconclusive and must not flag the model invalid.
 */
export function classifyProbeError(
	message: string,
): "model" | "auth" | "transient" {
	if (MODEL_LEVEL_ERROR_RE.test(message)) return "model";
	if (/unauthorized|invalid api key|authentication|401|403/i.test(message))
		return "auth";
	return "transient";
}

/**
 * Probe one model reference via an injected probe function. The probe may
 * return the response text (legacy) or a structured { status, message } —
 * model-level errors → invalid; auth errors → invalid (flag for attention);
 * transient errors → valid (inconclusive).
 */
export interface ProbeResult {
	status: "ok" | "error";
	message?: string;
}

export async function probeModelRef(
	probe: (ref: string) => Promise<string | ProbeResult>,
	ref: string,
): Promise<{ ok: boolean; reason?: string }> {
	let message: string;
	try {
		const result = await probe(ref);
		message =
			typeof result === "string"
				? result
				: result.status === "ok"
					? "ok"
					: (result.message ?? "probe error");
	} catch (err) {
		message = err instanceof Error ? err.message : String(err);
	}
	if (message === "ok") return { ok: true };
	const kind = classifyProbeError(message);
	if (kind === "model")
		return { ok: false, reason: `model unavailable: ${message}` };
	if (kind === "auth")
		return { ok: false, reason: `probe auth error: ${message}` };
	return { ok: true };
}

interface RegistryLike {
	getAll(): RegistryModelLike[];
	/** Provider auth status: undefined when the provider is unknown. */
	getProviderAuthStatus(
		provider: string,
	): { configured: boolean; source?: string; label?: string } | undefined;
}

/** Registry subset required for reference resolution. */
type ModelListLike = Pick<RegistryLike, "getAll">;

/**
 * Strip a trailing ":level" suffix when it is a known thinking level.
 * Returns the bare model ref. Colons inside the model id itself (e.g.
 * OpenRouter ":exacto") are preserved because only a recognized level is cut.
 */
export function stripThinkingLevel(ref: string): {
	modelRef: string;
	level: string | undefined;
} {
	const idx = ref.lastIndexOf(":");
	if (idx === -1) return { modelRef: ref, level: undefined };
	const suffix = ref.slice(idx + 1);
	if ((VALID_THINKING_LEVELS as readonly string[]).includes(suffix)) {
		return { modelRef: ref.slice(0, idx), level: suffix };
	}
	return { modelRef: ref, level: undefined };
}

/**
 * Resolve a model reference ("provider/model-id" or bare id) against the registry.
 * The provider is the first "/"-segment; the model id may itself contain "/"
 * (e.g. provider "command-code" with id "deepseek/deepseek-v4-flash"). Falls
 * back to matching the whole ref as a bare model id. Returns undefined when no
 * model matches.
 */
export function findModelByRef(
	registry: ModelListLike,
	ref: string,
): RegistryModelLike | undefined {
	const { modelRef } = stripThinkingLevel(ref);
	const all = registry.getAll();
	const slash = modelRef.indexOf("/");
	if (slash !== -1) {
		const provider = modelRef.slice(0, slash);
		const id = modelRef.slice(slash + 1);
		const match = all.find((m) => m.provider === provider && m.id === id);
		if (match) return match;
	}
	return (
		all.find((m) => m.id === modelRef) ??
		all.find((m) => m.id.endsWith(`:${modelRef}`))
	);
}

/**
 * Extract model references from one config file object.
 * Config shape: { defaultModel?: string, agents?: Record<string, {model?: string | string[]}> }
 */
export function collectModelRefs(
	config: Record<string, unknown>,
	filePath: string,
	fileLabel: string,
): ModelRefEntry[] {
	const entries: ModelRefEntry[] = [];
	const push = (ref: unknown, agent: string, kind: ModelRefEntry["kind"]) => {
		if (typeof ref !== "string" || ref.trim() === "") return;
		entries.push({ filePath, fileLabel, agent, kind, ref: ref.trim() });
	};

	const defaultModel = config.defaultModel;
	if (typeof defaultModel === "string")
		push(defaultModel, "(default)", "default");

	const agents = config.agents;
	if (agents && typeof agents === "object") {
		for (const [agentName, agentCfg] of Object.entries(
			agents as Record<string, unknown>,
		)) {
			if (!agentCfg || typeof agentCfg !== "object") continue;
			const model = (agentCfg as Record<string, unknown>).model;
			if (typeof model === "string") {
				push(model, agentName, "primary");
			} else if (Array.isArray(model)) {
				model.forEach((m, i) =>
					push(m, agentName, i === 0 ? "primary" : "fallback"),
				);
			}
		}
	}
	return entries;
}

/**
 * Validate one model reference against the registry.
 * Returns { ok, reason } where ok=true means resolvable + authenticated.
 */
export function validateModelRef(
	registry: RegistryLike,
	ref: string,
): { ok: boolean; reason?: string } {
	const { modelRef } = stripThinkingLevel(ref);
	const model = findModelByRef(registry, modelRef);
	if (!model) return { ok: false, reason: `model not found: "${modelRef}"` };
	const auth = registry.getProviderAuthStatus(model.provider);
	if (!auth || !auth.configured) {
		return {
			ok: false,
			reason: `provider "${model.provider}" not authenticated`,
		};
	}
	return { ok: true };
}

/**
 * Check all model references from config file objects against the registry.
 * `configs` maps file label → config object (order preserved).
 */
export function checkModels(
	registry: RegistryLike,
	configs: Array<{
		label: string;
		path: string;
		config: Record<string, unknown>;
	}>,
): CheckResult {
	const result: CheckResult = { valid: [], invalid: [] };
	for (const { label, path, config } of configs) {
		for (const entry of collectModelRefs(config, path, label)) {
			const { ok, reason } = validateModelRef(registry, entry.ref);
			if (ok) result.valid.push(entry);
			else result.invalid.push({ ...entry, reason: reason! });
		}
	}
	return result;
}

/**
 * Merge live-probe results into a CheckResult: failed probes move entries
 * from valid to invalid. Exported for testing.
 */
export function applyProbeResults(
	result: CheckResult,
	probeResults: Array<{ ok: boolean; reason?: string }>,
): void {
	const valid = [...result.valid];
	for (let i = 0; i < probeResults.length; i++) {
		const p = probeResults[i]!;
		if (p.ok) continue;
		const entry = valid[i];
		if (!entry) continue;
		result.invalid.push({ ...entry, reason: p.reason! });
	}
	result.valid = valid.filter((_, i) => probeResults[i]?.ok !== false);
}

/** Format the check result as plain text for display. */
export function formatCheckResult(result: CheckResult): string {
	const lines: string[] = [];
	const total = result.valid.length + result.invalid.length;

	if (result.invalid.length === 0) {
		lines.push(`All ${total} model references are valid.`);
	} else {
		for (const bad of result.invalid) {
			lines.push(`✗ ${bad.fileLabel} → ${bad.agent} [${bad.kind}]: ${bad.ref}`);
			lines.push(`  ${bad.reason}`);
		}
	}

	lines.push(
		`Summary: ${total} references, ${result.valid.length} valid, ${result.invalid.length} invalid.`,
	);
	return lines.join("\n");
}
