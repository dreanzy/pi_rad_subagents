import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findRescuedPath, registerPathRescue } from "../extensions/path-rescue.ts";

/** Capture the `tool_call` handler the extension registers, with a fixed cwd. */
function makeHandler(cwd: string) {
	let handler: ((event: unknown, ctx: { cwd: string }) => unknown) | undefined;
	const pi = {
		on: (name: string, fn: typeof handler) => {
			if (name === "tool_call") handler = fn;
		},
	} as unknown as ExtensionAPI;
	registerPathRescue(pi);
	if (!handler) throw new Error("registerPathRescue did not register tool_call");
	const call = handler;
	return (toolName: string, input: Record<string, unknown>) =>
		call({ toolName, input }, { cwd });
}

describe("findRescuedPath", () => {
	// workspace = <tmp>/Work/Parent/Child/Project
	let base: string;
	let workspace: string;
	let file: string;

	beforeAll(() => {
		base = mkdtempSync(join(tmpdir(), "rad-rescue-test-"));
		workspace = join(base, "Work", "Parent", "Child", "Project");
		mkdirSync(join(workspace, "src"), { recursive: true });
		file = join(workspace, "src", "app.ts");
		writeFileSync(file, "x");
	});

	afterAll(() => rmSync(base, { recursive: true, force: true }));

	it("rescues a guess with dropped parent segments", () => {
		const guess = join(base, "Work", "Project", "src", "app.ts");
		expect(findRescuedPath(guess, workspace)).toBe(
			join(workspace, "src", "app.ts"),
		);
	});

	it("rescues a guess that ends at the anchor (dropped parents only)", () => {
		const guess = join(base, "Work", "Project");
		expect(findRescuedPath(guess, workspace)).toBe(workspace);
	});

	it("leaves a path already inside the workspace alone", () => {
		expect(findRescuedPath(join(workspace, "missing.ts"), workspace)).toBeNull();
		expect(findRescuedPath(file, workspace)).toBeNull();
	});

	it("returns null when the tail does not exist", () => {
		const guess = join(base, "Work", "Project", "src", "nope.ts");
		expect(findRescuedPath(guess, workspace)).toBeNull();
	});

	it("refuses relative paths", () => {
		expect(findRescuedPath("src/app.ts", workspace)).toBeNull();
	});

	it("refuses guesses containing .. or . segments", () => {
		// Build the raw string literally: path.join would collapse the `..`
		// before the guess ever reaches the rescue.
		const guess = `${base}${path.sep}Work${path.sep}..${path.sep}Project`;
		expect(findRescuedPath(guess, workspace)).toBeNull();
	});

	it("refuses an ambiguous anchor (appears twice)", () => {
		// Anchor "Project" occurs twice unless the longest anchor wins first.
		const guess = join(base, "Project", "Project", "src", "app.ts");
		const rescued = findRescuedPath(guess, workspace);
		// Ambiguous ⇒ no rescue (null), never a guess at which one was meant.
		expect(rescued).toBeNull();
	});

	it("accepts Windows-style forward slashes in the guess", () => {
		if (process.platform !== "win32") return;
		const guess = `${base.replaceAll("\\", "/")}/Work/Project/src/app.ts`;
		expect(findRescuedPath(guess, workspace)).toBe(
			join(workspace, "src", "app.ts"),
		);
	});
});

describe("registerPathRescue", () => {
	let base: string;
	let workspace: string;
	let run: ReturnType<typeof makeHandler>;

	beforeAll(() => {
		base = mkdtempSync(join(tmpdir(), "rad-rescue-hook-"));
		workspace = join(base, "Work", "Parent", "Child", "Project");
		mkdirSync(join(workspace, "src"), { recursive: true });
		writeFileSync(join(workspace, "src", "app.ts"), "x");
		run = makeHandler(workspace);
	});

	afterAll(() => rmSync(base, { recursive: true, force: true }));

	it("rewrites a rescued path argument in place", () => {
		const input = { path: join(base, "Work", "Project", "src", "app.ts") };
		run("read", input);
		expect(input.path).toBe(join(workspace, "src", "app.ts"));
	});

	it("leaves the argument untouched when no rescue applies", () => {
		const given = join(workspace, "missing.ts");
		const input = { path: given };
		run("read", input);
		expect(input.path).toBe(given);
	});

	it("ignores tools and arguments outside the rescue contract", () => {
		const unrescued = { path: join(base, "Work", "Project", "src", "app.ts") };
		run("write", unrescued); // tool not in RESCUED_TOOLS
		expect(unrescued.path).toBe(join(base, "Work", "Project", "src", "app.ts"));

		const noPath = { filePath: join(base, "Work", "Project", "src", "app.ts") };
		run("read", noPath); // pi tools carry `path`, not `filePath`
		expect(noPath.filePath).toBe(
			join(base, "Work", "Project", "src", "app.ts"),
		);
	});
});
