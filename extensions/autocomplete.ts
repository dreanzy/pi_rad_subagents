/**
 * Agent @-mention autocomplete for the rad-subagents extension.
 *
 * When the user types `@` followed by a partial agent name, shows matching
 * agents from the configured agent list (user + project scope). Falls back
 * to the built-in file path completion when no agent matches.
 *
 * Uses pi's ctx.ui.addAutocompleteProvider() API to stack on top of
 * the built-in slash-command and file path provider.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import { discoverAgents } from "./agents.ts";

const MAX_SUGGESTIONS = 20;

/**
 * Create an autocomplete provider that shows agent names on `@` trigger.
 *
 * Matching priority:
 *   1. Exact prefix match (agent name starts with query)
 *   2. Fuzzy match across all agent names
 *   3. If nothing matches, delegate to the built-in provider (file completion)
 */
function createAgentAutocompleteProvider(
	current: AutocompleteProvider,
	cwd: string,
): AutocompleteProvider {
	const { agents } = discoverAgents(cwd, "both");

	return {
		triggerCharacters: ["@"],

		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const line = lines[cursorLine] ?? "";
			const beforeCursor = line.slice(0, cursorCol);

			// Check for @-mention pattern: word boundary + @ + optional name
			const match = beforeCursor.match(/(?:^|[ \t])@([^\s@]*)$/);
			if (!match) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const query = match[1] ?? "";
			const prefix = `@${query}`;

			if (options.signal.aborted) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			// ── Build agent suggestions ──────────────────────────────────
			let suggestions: AutocompleteItem[];

			if (!query) {
				// No filter — show all agents (capped)
				suggestions = agents
					.slice(0, MAX_SUGGESTIONS)
					.map((a) => ({
						value: `@${a.name}`,
						label: a.name,
						description: a.description,
					}));
			} else {
				// Phase 1: exact prefix match (case-insensitive)
				const prefixMatches = agents.filter((a) =>
					a.name.toLowerCase().startsWith(query.toLowerCase()),
				);
				if (prefixMatches.length > 0) {
					suggestions = prefixMatches
						.slice(0, MAX_SUGGESTIONS)
						.map((a) => ({
							value: `@${a.name}`,
							label: a.name,
							description: a.description,
						}));
				} else {
					// Phase 2: fuzzy match
					const fuzzyMatches = fuzzyFilter(agents, query, (a) => a.name);
					if (fuzzyMatches.length === 0) {
						// No agent matched → fall back to built-in file completion
						return current.getSuggestions(
							lines,
							cursorLine,
							cursorCol,
							options,
						);
					}
					suggestions = fuzzyMatches
						.slice(0, MAX_SUGGESTIONS)
						.map((a) => ({
							value: `@${a.name}`,
							label: a.name,
							description: a.description,
						}));
				}
			}

			if (suggestions.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			return { items: suggestions, prefix };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			// Delegate insertion to the built-in provider
			return current.applyCompletion(
				lines,
				cursorLine,
				cursorCol,
				item,
				prefix,
			);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			const line = lines[cursorLine] ?? "";
			const beforeCursor = line.slice(0, cursorCol);
			// Suppress file completion when @-mention is in progress
			if (/(?:^|[ \t])@/.test(beforeCursor)) {
				return false;
			}
			return (
				current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
				true
			);
		},
	};
}

/**
 * Register the agent @-mention autocomplete provider.
 * Call this once from the extension factory function.
 */
export function registerAgentAutocomplete(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) =>
			createAgentAutocompleteProvider(current, ctx.cwd),
		);
	});
}
