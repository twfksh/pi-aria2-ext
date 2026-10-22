import { describe, expect, test } from "bun:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { DownloadsDashboard } from "../src/dashboard.ts";
import type { DownloadManager } from "../src/manager.ts";
import type { Job, Snapshot } from "../src/types.ts";

function job(overrides: Partial<Job> = {}): Job {
	return {
		handle: "dl-one-1",
		urls: ["https://example.com/one.iso"],
		options: { dir: "/downloads", connections: 8 },
		createdAt: 1,
		state: "active",
		completedLength: 50,
		totalLength: 100,
		speed: 2048,
		connections: 4,
		name: "one.iso",
		filePath: "/downloads/one.iso",
		...overrides,
	};
}

function snapshot(jobs: Job[]): Snapshot {
	return {
		jobs,
		global: { downloadSpeed: 2048, uploadSpeed: 0, numActive: 1, numWaiting: 0, numStopped: 0 },
		daemon: "running",
	};
}

function harness(jobs: Job[] = [job()]) {
	const manager = {
		snapshot: () => snapshot(jobs),
		subscribe: () => () => {},
		pause: async () => ({ action: "pause", ok: true, jobs }),
		resume: async () => ({ action: "resume", ok: true, jobs }),
		retry: async () => ({ action: "retry", ok: true, jobs }),
		remove: async () => ({ action: "rm", ok: true, jobs }),
	} as unknown as DownloadManager;

	let renders = 0;
	const tui = {
		terminal: { rows: 40, columns: 100 },
		requestRender: () => {
			renders += 1;
		},
	} as unknown as TUI;
	// EditorTheme is all CustomEditor needs; the dashboard colours through Theme.
	const editorTheme = { borderColor: (text: string) => text, selectList: {} } as unknown as EditorTheme;
	// Real SGR escapes, so terminal width maths stays honest while tests can
	// still tell which token painted a span.
	const theme = {
		fg: (token: string, text: string) => `\u001b[${TOKEN_SGR[token] ?? 37}m${text}\u001b[0m`,
		bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
		style: (text: string) => text,
	} as unknown as Theme;
	const keybindings = { matches: () => false } as unknown as KeybindingsManager;
	let closed = false;

	const dashboard = new DownloadsDashboard(manager, tui, editorTheme, keybindings, theme, () => {
		closed = true;
	});

	return { dashboard, renders: () => renders, isClosed: () => closed };
}

const TOKEN_SGR: Record<string, number> = {
	accent: 35,
	border: 90,
	muted: 90,
	dim: 2,
	text: 37,
	success: 32,
	error: 31,
	warning: 33,
};
const strip = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");
const accentRail = "\u001b[35m┃";
const boldOpen = "\u001b[1m";

/** The selected row is the first line drawn with the accent rail. */
function selectedRow(dashboard: DownloadsDashboard): string {
	const line = dashboard.render(100).find((row) => row.startsWith(accentRail)) ?? "";
	return strip(line);
}

describe("prompt dashboard", () => {
	test("one arrow press moves the selection exactly one row", () => {
		const lines = [job({ handle: "dl-a", name: "a.bin" }), job({ handle: "dl-b", name: "b.bin", createdAt: 2 }), job({ handle: "dl-c", name: "c.bin", createdAt: 3 })];
		const { dashboard } = harness(lines);
		expect(selectedRow(dashboard)).toContain("a.bin");
		dashboard.handleInput("\x1b[B");
		expect(selectedRow(dashboard)).toContain("b.bin");
		dashboard.handleInput("\x1b[B");
		expect(selectedRow(dashboard)).toContain("c.bin");
		dashboard.handleInput("\x1b[B");
		expect(selectedRow(dashboard)).toContain("a.bin");
		dashboard.handleInput("\x1b[A");
		expect(selectedRow(dashboard)).toContain("c.bin");
		dashboard.dispose();
	});

	test("key-release events never move the selection twice", () => {
		const jobs = [job({ handle: "dl-a", name: "a.bin" }), job({ handle: "dl-b", name: "b.bin", createdAt: 2 })];
		const { dashboard } = harness(jobs);
		expect(selectedRow(dashboard)).toContain("a.bin");
		// Kitty protocol: press then release of the same key.
		dashboard.handleInput("\x1b[1;1:1B");
		dashboard.handleInput("\x1b[1;1:3B");
		expect(selectedRow(dashboard)).toContain("b.bin");
		dashboard.dispose();
	});

	test("expands details under the selected row and toggles them off", () => {
		const { dashboard } = harness([job(), job({ handle: "dl-two", name: "two.bin", createdAt: 2, state: "complete" })]);
		const rendered = dashboard.render(110);
		const collapsed = rendered.map(strip);
		expect(collapsed.some((line) => line.includes("Path"))).toBe(true);
		// Details sit directly beneath the selected row, not in a second column.
		const rowIndex = rendered.findIndex((line) => line.startsWith(accentRail));
		expect(collapsed[rowIndex + 1]).toContain("Path");
		expect(collapsed.some((line) => line.includes("│"))).toBe(false);
		expect(collapsed.join("\n")).toContain("/downloads/one.iso");
		expect(collapsed.join("\n")).toContain("Speed");

		dashboard.handleInput("\r");
		expect(dashboard.render(110).map(strip).join("\n")).not.toContain("Path");
		dashboard.dispose();
	});

	test("frames every line with a left rail and accents the selected one", () => {
		const { dashboard } = harness([job(), job({ handle: "dl-two", name: "two.bin", createdAt: 2 })]);
		const rendered = dashboard.render(100);
		for (const line of rendered) expect(strip(line).startsWith("┃")).toBe(true);

		const accentRows = rendered.filter((line) => line.startsWith(accentRail));
		// The selected row plus its two detail lines.
		expect(accentRows.length).toBeGreaterThan(1);
		expect(strip(accentRows[0]!)).toContain("one.iso");
		expect(strip(accentRows[0]!)).not.toContain("two.bin");
		dashboard.dispose();
	});

	test("j and k move the selection like the arrow keys", () => {
		const jobs = [job({ handle: "dl-a", name: "a.bin" }), job({ handle: "dl-b", name: "b.bin", createdAt: 2 }), job({ handle: "dl-c", name: "c.bin", createdAt: 3 })];
		const { dashboard } = harness(jobs);
		dashboard.handleInput("j");
		expect(selectedRow(dashboard)).toContain("b.bin");
		dashboard.handleInput("j");
		expect(selectedRow(dashboard)).toContain("c.bin");
		dashboard.handleInput("j");
		expect(selectedRow(dashboard)).toContain("a.bin");
		dashboard.handleInput("k");
		expect(selectedRow(dashboard)).toContain("c.bin");
		dashboard.dispose();
	});

	test("rows share one column template", () => {
		const jobs = [
			job({ handle: "dl-done", name: "opencode-desktop-linux-amd64.deb", state: "complete", completedLength: 100, totalLength: 100 }),
			job({ handle: "dl-bad", name: "opencode-desktop-linux-amd64.deb", state: "error", completedLength: 0, totalLength: 0, createdAt: 2 }),
			job({ handle: "dl-live", name: "ubuntu.iso", state: "active", createdAt: 3, completedLength: 25, totalLength: 100 }),
		];
		const { dashboard } = harness(jobs);
		// Rows only: the details block below the selection repeats the file name.
		const rows = dashboard.render(100).map(strip).filter((line) => /^┃ [✓✗●‖]/.test(line));
		expect(rows).toHaveLength(3);

		// The percent cell is right-aligned and four wide, so its left edge is
		// fixed; a row without progress starts its status at that same edge.
		const cellStart = (line: string) => {
			const pct = line.indexOf("%");
			if (pct !== -1) return pct - 3;
			return line.indexOf("failed");
		};
		expect(new Set(rows.map(cellStart)).size).toBe(1);

		const bars = rows.map((line) => line.search(/[█░]/)).filter((index) => index !== -1);
		expect(new Set(bars).size).toBe(1);
		dashboard.dispose();
	});

	test("the selected row is emphasised", () => {
		const { dashboard } = harness([job(), job({ handle: "dl-two", name: "two.bin", createdAt: 2 })]);
		const selected = dashboard.render(100).find((line) => line.startsWith(accentRail)) ?? "";
		expect(strip(selected)).toContain("one.iso");
		expect(selected).toContain(boldOpen);
		dashboard.dispose();
	});

	test("reports transfer time rather than time since the download was queued", () => {
		const started = Date.now() - 3_600_000; // queued an hour ago
		const { dashboard } = harness([
			job({ state: "complete", createdAt: started, activeMs: 15_000, finishedAt: started + 3_600_000 }),
		]);
		const text = dashboard.render(110).map(strip).join("\n");
		expect(text).toContain("Took");
		expect(text).toContain("15s");
		expect(text).not.toContain("1h");
		dashboard.dispose();
	});

	test("omits the duration when it was never measured", () => {
		const { dashboard } = harness([job({ state: "complete" })]);
		const text = dashboard.render(110).map(strip).join("\n");
		expect(text).not.toContain("Took");
		expect(text).not.toContain("Elapsed");
		dashboard.dispose();
	});

	test("o reports that there is no file to open", () => {
		const { dashboard } = harness([job({ state: "complete", filePath: "/nope/missing.bin" })]);
		dashboard.handleInput("o");
		expect(strip(dashboard.render(110).join("\n"))).toContain("nothing to open yet");
		dashboard.dispose();
	});

	test("footer advertises open and vim movement", () => {
		const { dashboard } = harness([job()]);
		const footer = strip(dashboard.render(100).join("\n"));
		expect(footer).toContain("j k move");
		expect(footer).toContain("o open");
		dashboard.dispose();
	});

	test("Escape and Ctrl+Shift+O both close the dashboard", () => {
		const first = harness([job()]);
		first.dashboard.handleInput("\x1b");
		expect(first.isClosed()).toBe(true);
		first.dashboard.dispose();

		const second = harness([job()]);
		second.dashboard.handleInput("\x1b[111;6u");
		expect(second.isClosed()).toBe(true);
		second.dashboard.dispose();
	});

	test("typing letters does not leak into the prompt", () => {
		const { dashboard } = harness([job()]);
		dashboard.handleInput("z");
		expect(dashboard.getText()).toBe("");
		dashboard.handleInput("\x1b[B");
		expect(dashboard.getText()).toBe("");
		dashboard.dispose();
	});
});
