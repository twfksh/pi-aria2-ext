import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { DownloadsDashboard } from "../src/dashboard.ts";
import type { DownloadManager } from "../src/manager.ts";
import type { Job, Snapshot } from "../src/types.ts";

function job(overrides: Partial<Job> = {}): Job {
	return {
		handle: "dl-active-11",
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

function snapshot(jobs: Job[]): Snapshot {
	return {
		jobs,
		global: { downloadSpeed: 2048, uploadSpeed: 0, numActive: 1, numWaiting: 0, numStopped: 0 },
		daemon: "running",
		version: "1.37.0",
	};
}

function harness(options: { jobs?: Job[]; remove?: (handle: string | string[] | undefined) => Promise<unknown> } = {}) {
	const removed: Array<string | string[] | undefined> = [];
	const manager = {
		snapshot: () => snapshot(options.jobs ?? []),
		subscribe: () => () => {},
		refresh: async () => snapshot(options.jobs ?? []),
		pause: async () => ({ action: "pause", ok: true, jobs: [] }),
		resume: async () => ({ action: "resume", ok: true, jobs: [] }),
		retry: async () => ({ action: "retry", ok: true, jobs: [] }),
		remove: async (handle: string | string[] | undefined) => {
			removed.push(handle);
			return options.remove ? options.remove(handle) : { action: "rm", ok: true, jobs: [] };
		},
		purge: async () => ({ action: "purge", ok: true, jobs: [] }),
	} as unknown as DownloadManager;

	const tui = {
		terminal: { rows: 40 },
		requestRender: () => {},
	} as unknown as TUI;
	const keybindings = {
		matches: (data: string, id: string) => {
			if (id === "tui.select.up") return data === "up";
			if (id === "tui.select.down") return data === "down";
			return false;
		},
	} as unknown as KeybindingsManager;
	const theme = { fg: (_token: string, text: string) => text } as unknown as Theme;
	let closed = false;
	const dashboard = new DownloadsDashboard(manager, tui, theme, keybindings, () => {
		closed = true;
	});
	return { dashboard, removed, isClosed: () => closed };
}

describe("DownloadsDashboard", () => {
	test("renders an empty state inside a frame", () => {
		const { dashboard } = harness();
		const text = dashboard.render(90).join("\n");
		expect(text).toContain("Downloads");
		expect(text).toContain("No downloads");
		expect(text).toContain("esc close");
		expect(text).toContain("┌");
		dashboard.dispose();
	});

	test("renders jobs with handle, name and progress", () => {
		const { dashboard } = harness({
			jobs: [
				job(),
				job({ handle: "dl-paused-22", state: "paused", name: "model.bin", filePath: "/downloads/model.bin" }),
			],
		});
		const text = dashboard.render(110).join("\n");
		expect(text).toContain("dl-active-11");
		expect(text).toContain("ubuntu.iso");
		expect(text).toContain("50%");
		expect(text).toContain("dl-paused-22");
		expect(text).toContain("model.bin");
		expect(text).toContain("1 active"); // summary aggregates the jobs
		dashboard.dispose();
	});

	test("cycles filters and closes on q", () => {
		const { dashboard, isClosed } = harness({ jobs: [job()] });
		expect(dashboard.render(100).join("\n")).not.toContain("filter: active");
		dashboard.handleInput("f");
		expect(dashboard.render(100).join("\n")).toContain("filter: active");
		dashboard.handleInput("q");
		expect(isClosed()).toBe(true);
		dashboard.dispose();
	});

	test("requires two presses to remove", async () => {
		const { dashboard, removed } = harness({ jobs: [job()] });
		dashboard.handleInput("d");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(removed).toHaveLength(0);
		expect(dashboard.render(100).join("\n")).toContain("press d again");
		dashboard.handleInput("d");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(removed).toEqual(["dl-active-11"]);
		dashboard.dispose();
	});

	test("does not overflow narrow widths", () => {
		const { dashboard } = harness({ jobs: [job({ name: "a-very-long-file-name-that-should-be-truncated.bin" })] });
		for (const width of [20, 40, 60, 120]) {
			const lines = dashboard.render(width);
			for (const line of lines) {
				const visible = line.replace(/\u001b\[[0-9;]*m/g, "").length;
				expect(visible).toBeLessThanOrEqual(width);
			}
		}
		dashboard.dispose();
	});
});
