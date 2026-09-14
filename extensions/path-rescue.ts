/**
 * Absolute-path rescue — ported from oh-my-opencode-slim v2.2.20 (#1186).
 *
 * Agents occasionally guess an absolute path with dropped directory segments
 * (e.g. `/home/u/Work/Project` when the workspace is
 * `/home/u/Work/Parent/Child/Project`). The tool then fails with ENOENT before
 * doing any work, wasting a turn.
 *
 * Rescue contract (deliberately narrow):
 * - Only the `path` argument of read/grep/find/ls, only when absolute, and
 *   only when its absence is a plain ENOENT (permission/IO errors pass through).
 * - Only guesses NOT already inside the workspace: a missing path inside the
 *   workspace is a legitimate absence and must surface, never be redirected.
 * - The anchor is the LONGEST contiguous suffix of the workspace that appears
 *   in the guess. It must appear exactly once (otherwise ambiguous → no rescue),
 *   and only its full relative tail is considered — a missing tail means no
 *   rescue. There is no fallback to a shorter anchor.
 * - The candidate must exist per a successful stat.
 *
 * Unlike upstream, the rewrite is not logged: this plugin has no log sink, and
 * a console warning would either corrupt TUI rendering in the main session or
 * land in a subagent's captured stderr, where determineRetryable scans text
 * for retry heuristics.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Tools whose `path` argument denotes a file/directory target. */
const RESCUED_TOOLS = new Set(["read", "grep", "find", "ls"]);

function isMissing(p: string): boolean {
	try {
		fs.statSync(p);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/**
 * Re-anchor a guessed absolute path onto the workspace, or return null when
 * the guess is not an absolute missing path, is already inside the workspace,
 * is ambiguous, or does not resolve to something that exists.
 */
export function findRescuedPath(
	raw: string,
	workspace: string,
): string | null {
	if (!path.isAbsolute(raw)) return null;
	if (!isMissing(raw)) return null;

	const root = path.resolve(workspace);
	const resolvedGuess = path.resolve(raw);
	if (resolvedGuess === root || resolvedGuess.startsWith(root + path.sep)) {
		return null;
	}

	// Normalize separators so a `C:/Users/...` guess segments the same way as
	// the backslash workspace path on Windows.
	const sep = path.sep;
	const normalized = sep === "/" ? raw : raw.replaceAll("/", sep);
	const guessSegments = normalized.split(sep).filter((s) => s.length > 0);
	if (guessSegments.some((s) => s === ".." || s === ".")) return null;
	const rootSegments = root.split(sep).filter((s) => s.length > 0);

	// Longest workspace suffix appearing in the guess; exactly one occurrence.
	for (let anchorLen = rootSegments.length; anchorLen >= 1; anchorLen -= 1) {
		const anchor = rootSegments.slice(rootSegments.length - anchorLen);
		const occurrences: number[] = [];
		for (let i = 0; i + anchorLen <= guessSegments.length; i += 1) {
			if (anchor.every((seg, j) => guessSegments[i + j] === seg)) {
				occurrences.push(i);
			}
		}
		if (occurrences.length === 0) continue; // a shorter anchor may match
		if (occurrences.length > 1) return null; // ambiguous — no rescue
		const [anchorStart] = occurrences;
		if (anchorStart === undefined) continue;
		const tail = guessSegments.slice(anchorStart + anchorLen);
		const candidate = [root, ...tail].join(sep);
		return fs.existsSync(candidate) ? candidate : null;
	}
	return null;
}

export function registerPathRescue(pi: ExtensionAPI): void {
	pi.on("tool_call", (_event, ctx) => {
		// `event.input` is not typed as mutable in the extension API, so reach
		// the raw object through a local cast instead of widening the param.
		const event = _event as {
			toolName: string;
			input: Record<string, unknown>;
		};
		if (!RESCUED_TOOLS.has(event.toolName)) return undefined;

		const raw = event.input?.path;
		if (typeof raw !== "string" || raw === "") return undefined;

		const rescued = findRescuedPath(raw, ctx.cwd);
		if (rescued === null) return undefined;

		event.input.path = rescued;
		return undefined; // mutate in place; do not block the call
	});
}
