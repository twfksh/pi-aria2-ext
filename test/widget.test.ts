import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Job, Snapshot } from "../src/types.ts";
import { ProgressWidget, renderWidgetLines } from "../src/widget.ts";

function job(overrides: Partial<Job> = {}): Job {
	return {
		handle: "dl-brisk-otter-42",
		urls: ["https://example.com/ubuntu.iso"],
		options: { dir: "/downloads", connections: 8 },
		createdAt: 1,
		state: "active",
		completedLength: 50,
		totalLength: 100,
		speed: 2048,
		connections: 4,
		name: "ubuntu.iso",
		filePath: "/downloads/ubuntu.iso",
		...overrides,
	};
}

function snapshot(jobs: Job[], speed = 2048): Snapshot {
	return {
		jobs,
		global: { downloadSpeed: speed, uploadSpeed: 0, numActive: 1, numWaiting: 0, numStopped: 0 },
		daemon: "running",
		version: "1.37.0",
	};
}

// A theme that really emits ANSI, so width handling is exercised.
const ansiTheme = { fg: (_token: string, text: string) => `\u001b[36m${text}\u001b[0m` } as unknown as Theme;

describe("widget", () => {
	test("hides itself when nothing is live", () => {
		const lines = renderWidgetLines({ snapshot: snapshot([]), recentDone: new Map(), now: Date.now() }, ansiTheme, 80);
		expect(lines).toEqual([]);
	});

	test("renders active and paused jobs with a bar", () => {
		const lines = renderWidgetLines(
			{
				snapshot: snapshot([job(), job({ handle: "dl-quiet-heron-17", state: "paused", name: "model.bin" })]),
				recentDone: new Map(),
				now: Date.now(),
			},
			ansiTheme,
			90,
		);
		const text = lines.join("\n");
		expect(text).toContain("Downloads");
		expect(text).toContain("ubuntu.iso");
		expect(text).toContain("model.bin");
		expect(text).toContain("50%");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(90);
	});

	test("shows a completion briefly and then fades", () => {
		const done = job({ state: "complete", completedLength: 100, totalLength: 100, name: "notes.pdf" });
		const now = Date.now();
		const fresh = renderWidgetLines(
			{ snapshot: snapshot([done]), recentDone: new Map([[done.handle, now]]), now },
			ansiTheme,
			80,
		);
		expect(fresh.join("\n")).toContain("notes.pdf");

		const stale = renderWidgetLines(
			{ snapshot: snapshot([done]), recentDone: new Map([[done.handle, now - 6000]]), now },
			ansiTheme,
			80,
		);
		expect(stale).toEqual([]);
	});

	test("renders within narrow widths", () => {
		const lines = renderWidgetLines(
			{
				snapshot: snapshot([job({ name: "a-very-long-name-that-needs-truncation.bin" })]),
				recentDone: new Map(),
				now: Date.now(),
			},
			ansiTheme,
			30,
		);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
	});

	test("ProgressWidget re-renders after update", () => {
		const data = {
			snapshot: snapshot([job()]),
			recentDone: new Map<string, number>(),
			now: Date.now(),
		};
		const widget = new ProgressWidget(data, ansiTheme);
		expect(widget.render(80).join("\n")).toContain("ubuntu.iso");
		widget.update({ ...data, snapshot: snapshot([job({ name: "updated.bin" })]) });
		expect(widget.render(80).join("\n")).toContain("updated.bin");
		widget.invalidate();
	});
});
