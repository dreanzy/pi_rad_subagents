/**
 * /rad-models-check — validate subagent model references in rad-subagents.json
 * (project and global) against the pi model registry.
 *
 * Checks defaultModel and every agents.*.model (primary + fallback entries).
 * A reference is invalid when:
 *   - the model is unknown in the registry
 *   - its provider has no configured auth
 *   - a live probe (bounded, concurrent) fails with a model-level error
 *     (e.g. 400 unsupported_model for delisted models)
 *
 * pi 0.84's ModelRegistry exposes no completion API to extensions, so the
 * probe sends a minimal HTTP request straight to the model's baseUrl using
 * getApiKeyAndHeaders() for auth. Covered: OpenAI-compatible chat/completions,
 * OpenAI responses, Anthropic messages, Google generative-ai. Signed or
 * provider-specific transports (Azure, Bedrock, Vertex, Codex) are skipped.
 */

import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CancellableLoader,
	matchesKey,
	type Component,
} from "@earendil-works/pi-tui";
import { findProjectRadSubagentsConfig, readJSONSafe } from "./config.ts";
import { mapWithConcurrencyLimit } from "./concurrency.ts";
import {
	applyProbeResults,
	checkModels,
	formatCheckResult,
	probeModelRef,
	stripThinkingLevel,
	type ModelRefEntry,
	type ProbeResult,
	type RegistryModelLike,
} from "./model-check.ts";

/** Per-probe request timeout. */
const PROBE_TIMEOUT_MS = 15_000;
/** Concurrent probe limit. */
const PROBE_CONCURRENCY = 4;

/**
 * Read the project + global rad-subagents.json files. Returns entries for
 * files that exist. readJSONSafe tolerates missing/parse errors.
 */
function readConfigFiles(cwd: string): Array<{
	label: string;
	path: string;
	config: Record<string, unknown>;
}> {
	const result: Array<{
		label: string;
		path: string;
		config: Record<string, unknown>;
	}> = [];

	const projectPath = findProjectRadSubagentsConfig(cwd);
	if (projectPath) {
		result.push({
			label: "project",
			path: projectPath,
			config: readJSONSafe(projectPath) as Record<string, unknown>,
		});
	}

	const globalPath = path.join(getAgentDir(), "rad-subagents.json");
	if (globalPath !== projectPath) {
		result.push({
			label: "global",
			path: globalPath,
			config: readJSONSafe(globalPath) as Record<string, unknown>,
		});
	}
	return result;
}

/**
 * Refresh the registry: pi 0.84's ModelRegistry.refresh() is synchronous and
 * takes no options — it just reloads models.json from disk. Provider/network
 * freshness is out of scope; a reload failure still leaves the previous
 * snapshot usable, so errors are swallowed.
 */
function refreshRegistry(ctx: ExtensionCommandContext): void {
	try {
		ctx.modelRegistry.refresh();
	} catch {
		/* snapshot may simply be stale, not wrong */
	}
}

// ── Live model probe ────────────────────────────────────────────────

/** One bounded POST; "ok" on 2xx, "endpoint <code>" on 404/405 (try a fallback
 * endpoint), otherwise the response body or error message. */
/** Probe outcome for one HTTP attempt. */
type AttemptResult = {
	status: "ok" | "endpoint-missing" | "error";
	message?: string;
};

/** Narrow an attempt result to the probe protocol (endpoint-missing → error). */
function toProbeResult(r: AttemptResult): ProbeResult {
	return r.status === "ok"
		? { status: "ok" }
		: { status: "error", message: r.message };
} /** OpenAI-compatible APIs probed via Bearer + chat/completions. */
const OPENAI_FAMILY = new Set([
	"openai-completions",
	"openai-responses",
	"mistral-conversations",
]);

function hasHeader(headers: Record<string, string>, name: string): boolean {
	return Object.keys(headers).some(
		(k) => k.toLowerCase() === name.toLowerCase(),
	);
}

async function requestProbe(
	url: string,
	body: unknown,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<AttemptResult> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		});
		if (res.ok) return { status: "ok" };
		if (res.status === 404 || res.status === 405)
			return { status: "endpoint-missing", message: `endpoint ${res.status}` };
		const text = await res.text();
		return {
			status: "error",
			message: text.slice(0, 500) || `http ${res.status}`,
		};
	} catch (err) {
		return {
			status: "error",
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Probe a model ref via the registry: resolve it to a Model, then send a
 * minimal completion ("hi", maxTokens 1) to its endpoint. Returns a
 * ProbeResult that probeModelRef classifies.
 */
function makeProbe(ctx: ExtensionCommandContext) {
	return async (ref: string): Promise<ProbeResult> => {
		const { modelRef } = stripThinkingLevel(ref);
		const all = ctx.modelRegistry.getAll();
		const slash = modelRef.indexOf("/");
		const provider = slash === -1 ? undefined : modelRef.slice(0, slash);
		const id = slash === -1 ? modelRef : modelRef.slice(slash + 1);
		const model = provider
			? ctx.modelRegistry.find(provider, id)
			: all.find((m) => m.id === id);
		if (!model) return { status: "error", message: "model not found" };
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return { status: "error", message: auth.error };
		// Auth resolution may override the endpoint on newer pi (OAuth/env);
		// 0.84's ResolvedRequestAuth has no baseUrl, so use model.baseUrl.
		const base = (model.baseUrl ?? "").replace(/\/+$/, "");
		if (!base) return { status: "error", message: "model baseUrl missing" };
		const api = model.api as string;
		const key = auth.apiKey;
		const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
		// Spread auth headers first so the JSON content-type wins.
		const headers: Record<string, string> = {
			...(auth.headers ?? {}),
			"content-type": "application/json",
		};
		// getApiKeyAndHeaders only injects Authorization when the provider sets
		// authHeader: true, but the OpenAI-compatible client (and most gateways)
		// always sends Bearer. Add it unconditionally for the OpenAI family;
		// other transports set their own key placement below.
		if (key && !hasHeader(headers, "authorization")) {
			if (OPENAI_FAMILY.has(api)) headers.Authorization = `Bearer ${key}`;
		}

		if (api === "anthropic-messages") {
			if (key && !hasHeader(headers, "x-api-key")) headers["x-api-key"] = key;
			headers["anthropic-version"] = "2023-06-01";
			const url = `${base.endsWith("/v1") ? base : `${base}/v1`}/messages`;
			return toProbeResult(
				await requestProbe(
					url,
					{
						model: model.id,
						messages: [{ role: "user", content: "hi" }],
						max_tokens: 1,
					},
					headers,
					signal,
				),
			);
		}
		if (api === "google-generative-ai") {
			if (!key) return { status: "error", message: "no api key" };
			const url = `${base}:generateContent?key=${encodeURIComponent(key)}`;
			return toProbeResult(
				await requestProbe(
					url,
					{ contents: [{ parts: [{ text: "hi" }] }] },
					{ "content-type": "application/json" },
					signal,
				),
			);
		}
		// Signed or provider-specific transports cannot be probed with a plain
		// HTTP request — treat as ok rather than flagging them invalid.
		if (!OPENAI_FAMILY.has(api)) return { status: "ok" };
		const chatBody = {
			model: model.id,
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 1,
		};
		const r1 = await requestProbe(
			`${base}/chat/completions`,
			chatBody,
			headers,
			signal,
		);
		if (r1.status !== "endpoint-missing") return toProbeResult(r1);
		// Responses-only endpoints (e.g. OpenAI gpt-5 family): retry on /responses.
		// Array input is accepted by both OpenAI responses and most gateways.
		return toProbeResult(
			await requestProbe(
				`${base}/responses`,
				{
					model: model.id,
					input: [{ role: "user", content: "hi" }],
					max_output_tokens: 1,
				},
				headers,
				signal,
			),
		);
	};
}

/**
 * Probe all statically-valid refs with progress updates. Returns the probe
 * results aligned with `valid` entries. Honors `signal` (abort → remaining
 * probes are skipped and their results marked ok so nothing is flagged).
 */
async function probeAll(
	ctx: ExtensionCommandContext,
	valid: ModelRefEntry[],
	update: (msg: string) => void,
	signal: AbortSignal,
): Promise<Array<{ ok: boolean; reason?: string }>> {
	if (valid.length === 0) return [];
	update(`Probing ${valid.length} models... (0/${valid.length})`);
	let done = 0;
	return mapWithConcurrencyLimit<
		ModelRefEntry,
		{ ok: boolean; reason?: string }
	>(valid, PROBE_CONCURRENCY, (v) => {
		if (signal.aborted) return Promise.resolve({ ok: true });
		return probeModelRef(makeProbe(ctx), v.ref).then((r) => {
			done++;
			update(`Probing models... (${done}/${valid.length})`);
			return r;
		});
	});
}

// ── Report component (bordered, scrollable, layout-safe) ────────────

/** Truncate a long line to the viewport width, keeping ANSI colors. */
function truncateLine(line: string, width: number): string {
	if (width <= 0) return line;
	const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
	if (clean.length <= width) return line;
	return clean.slice(0, Math.max(1, width - 1)) + "…";
}

/**
 * Bordered, scrollable report rendered as a plain object (like
 * pi-usage-extension): a top border line, the content, then a bottom border.
 * Returns at most maxVisible lines so the TUI layout does not allocate a
 * huge editor area and push the chat/footer off screen.
 */
function createReportComponent(
	text: string,
	maxVisible: number,
	border: (s: string) => string,
	onClose: () => void,
): Component & { dispose?(): void } {
	let scrollTop = 0;
	const bodyLines = text.split("\n");
	const topBorder = new DynamicBorder(border);
	const bottomBorder = new DynamicBorder(border);

	return {
		render(width: number): string[] {
			const top = topBorder.render(width);
			const bottom = bottomBorder.render(width);
			const innerMax = Math.max(1, maxVisible - 2);
			const end = Math.min(bodyLines.length, scrollTop + innerMax);
			return [
				...top,
				...bodyLines.slice(scrollTop, end).map((l) => truncateLine(l, width)),
				...bottom,
			];
		},
		handleInput(data: string): void {
			if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
				onClose();
				return;
			}
			if (matchesKey(data, "pageUp")) scrollTop = Math.max(0, scrollTop - 20);
			else if (matchesKey(data, "pageDown")) scrollTop = scrollTop + 20;
			else if (matchesKey(data, "up")) scrollTop = Math.max(0, scrollTop - 1);
			else if (matchesKey(data, "down")) scrollTop = scrollTop + 1;
		},
		invalidate(): void {},
		dispose(): void {},
	};
}

export function registerModelsCheckCommand(pi: ExtensionAPI): void {
	pi.registerCommand("rad-models-check", {
		description:
			"Check subagent models in rad-subagents.json (project + global) against the model registry. Usage: /rad-models-check",
		handler: async (_args, ctx) => {
			const configs = readConfigFiles(ctx.cwd);
			if (configs.length === 0) {
				ctx.ui.notify(
					"No rad-subagents.json found (project or global).",
					"warning",
				);
				return;
			}

			const registry = {
				getAll: () => ctx.modelRegistry.getAll() as RegistryModelLike[],
				getProviderAuthStatus: (provider: string) =>
					ctx.modelRegistry.getProviderAuthStatus(provider),
			};

			// ── Phase 1: refresh + static check (no UI) ──
			refreshRegistry(ctx);
			const result = checkModels(registry, configs);

			if (ctx.mode === "tui" && ctx.hasUI) {
				// ── Phase 2: probe with a cancellable loader ──
				const probed = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
					let finished = false;
					const finish = () => {
						if (finished) return;
						finished = true;
						loader.dispose();
						done(true);
					};
					const loader = new CancellableLoader(
						tui,
						(s: string) => theme.fg("accent", s),
						(s: string) => theme.fg("muted", s),
						"Checking subagent models...",
					);
					loader.onAbort = () => finish();
					probeAll(ctx, result.valid, loader.setMessage.bind(loader), loader.signal)
						.then((probeResults) => {
							applyProbeResults(result, probeResults);
							finish();
						})
						.catch(() => finish());
					return loader;
				});
				if (probed === undefined) return;

				// ── Phase 3: bordered report ──
				await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
					const title = "rad-subagents model check";
					const body = formatCheckResult(result);
					const text = `${theme.fg("toolTitle", theme.bold(title))}\n\n${body}\n\n${theme.fg("muted", "(PgUp/PgDn scroll, Enter/Escape to close)")}`;
					// Editor area ≈ terminal height minus chat/footer/input.
					const maxVisible = Math.max(5, tui.terminal.rows - 10);
					return createReportComponent(
						text,
						maxVisible,
						(s: string) => theme.fg("border", s),
						() => done(true),
					);
				});
			} else {
				// Non-TUI: probe silently, then notify the summary.
				const probeResults = await probeAll(
					ctx,
					result.valid,
					() => {},
					new AbortController().signal,
				);
				const probedCount = result.valid.length;
				applyProbeResults(result, probeResults);
				const summary =
					result.invalid.length === 0
						? "all valid"
						: `${result.invalid.length} invalid`;
				ctx.ui.notify(
					`[rad-subagents] ${summary} (probed ${probedCount}, total ${result.valid.length + result.invalid.length})`,
					result.invalid.length > 0 ? "warning" : "info",
				);
			}
		},
	});
}
