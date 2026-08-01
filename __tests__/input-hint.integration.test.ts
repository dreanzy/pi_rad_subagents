import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extensions/index.ts";

type Handler = (event: any, ctx: any) => Promise<any> | any;

/** Load the plugin's registered "input" handler through the extension entry point. */
function loadInputHandler(): Handler {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		registerTool: () => {},
		registerMessageRenderer: () => {},
		registerCommand: () => {},
		on: (ev: string, h: Handler) => {
			handlers.set(ev, [...(handlers.get(ev) ?? []), h]);
		},
	};
	(extension as unknown as (pi: unknown) => void)(pi);
	const list = handlers.get("input");
	expect(list?.length).toBe(1);
	return list![0]!;
}

const dir = mkdtempSync(join(tmpdir(), "rad-hint-test-"));
const img = join(dir, "shot.png");
writeFileSync(img, "x");

const noVisionCtx = { model: { id: "deepseek-chat", input: ["text"] } };
const visionCtx = { model: { id: "gpt-4o", input: ["text", "image"] } };

describe("input handler observer hint (integration)", () => {
	const handler = loadInputHandler();

	it("injects hint for image path when model lacks vision", async () => {
		const r = await handler(
			{ type: "input", text: `analyze ${img} contents`, source: "interactive" },
			{ cwd: dir, ...noVisionCtx },
		);
		expect(r.action).toBe("transform");
		expect(r.text).toContain("observer");
		expect(r.text).toContain(img);
	});

	it("injects hint for attached images (event.images) when model lacks vision", async () => {
		const r = await handler(
			{
				type: "input",
				text: "describe this",
				images: [{ type: "image", mimeType: "image/png", data: "x" }],
				source: "interactive",
			},
			{ cwd: dir, ...noVisionCtx },
		);
		expect(r.action).toBe("transform");
		expect(r.text).toContain("attached image(s)");
	});

	it("does not inject when model supports vision", async () => {
		const r = await handler(
			{ type: "input", text: `analyze ${img} contents`, source: "interactive" },
			{ cwd: dir, ...visionCtx },
		);
		expect(r).toBeUndefined();
	});

	it("does not inject when observer is mentioned mid-text", async () => {
		const r = await handler(
			{
				type: "input",
				text: `please @observer check ${img}`,
				source: "interactive",
			},
			{ cwd: dir, ...noVisionCtx },
		);
		expect(r).toBeUndefined();
	});

	it("does not inject for non-interactive sources", async () => {
		const r = await handler(
			{ type: "input", text: `analyze ${img} contents`, source: "rpc" },
			{ cwd: dir, ...noVisionCtx },
		);
		expect(r).toBeUndefined();
	});
});
