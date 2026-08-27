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
 * Runs a bounded model-registry refresh first so newly installed providers
 * are discovered; falls back to the session snapshot.
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
import {
	applyProbeResults,
	checkModels,
	formatCheckResult,
	probeModelRef,
	stripThinkingLevel,
	type ModelRefEntry,
	type RegistryModelLike,
} from "./model-check.ts";

const REFRESH_TIMEOUT_MS = 10_000;
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
 * Refresh the registry with a bounded timeout; swallow failures.
 * Returns true when the refresh completed without being aborted. Provider
 * errors are tolerated — the snapshot may simply be stale, not wrong.
 */
async function refreshRegistry(ctx: ExtensionCommandContext): Promise<boolean> {
	try {
		const signal = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
		const result = await Promise.race([
			ctx.modelRegistry.refresh({ allowNetwork: true, signal }),
			new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), REFRESH_TIMEOUT_MS + 1000),
			),
		]);
		return result !== null && !result.aborted;
	} catch {
		return false;
	}
}

// ── Live model probe ────────────────────────────────────────────────

/** Map a concurrency-limited map over items, preserving order. */
async function mapWithConcurrencyLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]!);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => worker()),
	);
	return results;
}

/**
 * Probe a model ref via the registry: resolve it to a Model, then send a
 * minimal completion ("hi", maxTokens 1). Returns the response text on
 * success, or the error message on failure — probeModelRef classifies it.
 */
function makeProbe(ctx: ExtensionCommandContext) {
	return async (ref: string): Promise<string> => {
		const { modelRef } = stripThinkingLevel(ref);
		const all = ctx.modelRegistry.getAll();
		const slash = modelRef.indexOf("/");
		const provider = slash === -1 ? undefined : modelRef.slice(0, slash);
		const id = slash === -1 ? modelRef : modelRef.slice(slash + 1);
		const model = provider
			? ctx.modelRegistry.find(provider, id)
			: all.find((m) => m.id === id);
		if (!model) return "model not found";
		const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
		try {
			const resp = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: "",
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: "hi" }],
							timestamp: Date.now(),
						},
					],
				},
				{ signal, maxTokens: 1 },
			);
			// pi surfaces provider errors as stopReason "error" with an
			// errorMessage rather than throwing — check both paths.
			if (resp.stopReason === "error") {
				return (
					resp.errorMessage ?? `provider error (stopReason ${resp.stopReason})`
				);
			}
			if (resp.stopReason === "aborted") return "request aborted";
			return "ok";
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
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
			const refreshed = await refreshRegistry(ctx);
			const result = checkModels(registry, configs);
			const staleNote = refreshed ? "" : " (registry snapshot, refresh failed)";

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
					const title = `rad-subagents model check${staleNote}`;
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
					`[rad-subagents] ${summary}${staleNote} (probed ${probedCount}, total ${result.valid.length + result.invalid.length})`,
					result.invalid.length > 0 ? "warning" : "info",
				);
			}
		},
	});
}
