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
	// Colour tokens become markers so tests can see which parts are accented.
	const theme = { fg: (token: string, text: string) => `<${token}>${text}</${token}>` } as unknown as Theme;
	const keybindings = { matches: () => false } as unknown as KeybindingsManager;
	let closed = false;

	const dashboard = new DownloadsDashboard(manager, tui, editorTheme, keybindings, theme, () => {
		closed = true;
	});

	return { dashboard, renders: () => renders, isClosed: () => closed };
}

const strip = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "").replace(/<\/?[a-z]+>/g, "");
const accentRail = "<accent>┃";

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
		expect(collapsed.join("\n")).toContain("Elapsed");

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
