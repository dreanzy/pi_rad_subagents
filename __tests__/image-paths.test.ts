import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findImagePaths } from "../extensions/index.ts";

describe("findImagePaths", () => {
	const dir = mkdtempSync(join(tmpdir(), "rad-img-test-"));
	const img = join(dir, "shot.png");
	const txt = join(dir, "note.txt");
	writeFileSync(img, "x");
	writeFileSync(txt, "x");

	it("extracts existing image path from plain text", () => {
		expect(findImagePaths(`look at this image ${img} please`, dir)).toEqual([
			img,
		]);
	});

	it("extracts @-prefixed (TUI attachment) and quoted paths", () => {
		expect(findImagePaths(`check @${img}`, dir)).toEqual([img]);
		expect(findImagePaths(`what is "${img}"`, dir)).toEqual([img]);
	});

	it("resolves relative paths against cwd", () => {
		expect(findImagePaths("look at shot.png", dir)).toEqual([img]);
	});

	it("ignores non-image extensions and nonexistent files", () => {
		expect(findImagePaths(`read ${txt} and missing.png`, dir)).toEqual([]);
	});

	it("extracts multiple images", () => {
		const img2 = join(dir, "shot2.jpg");
		writeFileSync(img2, "x");
		expect(findImagePaths(`fig1：${img} fig2：${img2}`, dir)).toEqual([
			img,
			img2,
		]);
		expect(
			findImagePaths("sprite.png is a resource name, not a path", dir),
		).toEqual([]);
	});
});
