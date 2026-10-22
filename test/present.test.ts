import { describe, expect, test } from "bun:test";
import type { Job, Snapshot } from "../src/types.ts";
import {
	filterJobs,
	oneLine,
	renderAction,
	renderAdd,
	renderInfo,
	renderList,
	renderStats,
	renderWait,
	renderWaitProgress,
	summaryFor,
	toView,
} from "../src/present.ts";
import type { Aria2Config } from "../src/types.ts";

function job(overrides: Partial<Job> = {}): Job {
	return {
		handle: "dl-brisk-otter-42",
		urls: ["https://example.com/file.zip"],
		options: { dir: "/tmp/downloads", connections: 8 },
		createdAt: 1_700_000_000_000,
		state: "active",
		completedLength: 0,
		totalLength: 0,
		speed: 0,
		connections: 0,
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

const config: Aria2Config = {
	defaultDir: "/tmp/downloads",
	split: 8,
	maxConcurrent: 5,
	notifyOnComplete: true,
	persist: true,
	stopWithPi: true,
	pollIntervalMs: 800,
	enableDht: false,
};

describe("renderList", () => {
	test("shows a friendly empty state", () => {
		expect(renderList(snapshot([]))).toContain("No downloads yet");
	});

	test("groups jobs by state and includes handles", () => {
		const text = renderList(
			snapshot([
				job({ handle: "dl-active-11", state: "active", completedLength: 50, totalLength: 100, filePath: "/x/a.bin" }),
				job({ handle: "dl-paused-22", state: "paused", completedLength: 25, totalLength: 100, filePath: "/x/b.bin" }),
				job({ handle: "dl-done-33", state: "complete", completedLength: 100, totalLength: 100, filePath: "/x/c.bin" }),
				job({ handle: "dl-fail-44", state: "error", errorCode: 13, errorMessage: "exists", filePath: "/x/d.bin" }),
			]),
		);
		expect(text).toContain("Active");
		expect(text).toContain("Paused");
		expect(text).toContain("Done");
		expect(text).toContain("Failed");
		expect(text).toContain("dl-active-11");
		expect(text).toContain("error 13");
	});

	test("filters", () => {
		const jobs = [
			job({ handle: "a", state: "active" }),
			job({ handle: "b", state: "complete" }),
		];
		expect(renderList(snapshot(jobs), "active")).toContain("a");
		expect(renderList(snapshot(jobs), "active")).not.toContain("b");
		expect(filterJobs(jobs, "done")).toHaveLength(1);
		expect(renderList(snapshot(jobs), "done")).toContain("1 finished");
	});
});

describe("renderAdd", () => {
	test("lists handles and suggests wait", () => {
		const text = renderAdd(
			[
				job({ handle: "dl-one-10", state: "queued", filePath: undefined, name: "one.bin" }),
				job({ handle: "dl-two-20", state: "queued", name: "two.bin" }),
			],
			"/downloads",
		);
		expect(text).toContain("Queued 2 downloads");
		expect(text).toContain("dl-one-10");
		expect(text).toContain('action: "wait"');
	});

	test("reports partial failure", () => {
		const text = renderAdd(
			[
				job({ handle: "dl-one-10", state: "queued" }),
				job({ handle: "dl-two-20", state: "error", errorCode: 13, errorMessage: "exists" }),
			],
			"/downloads",
		);
		expect(text).toContain("Queued 1 of 2");
		expect(text).toContain("error 13");
	});
});

describe("renderInfo and stats", () => {
	test("info includes urls, sizes and errors", () => {
		const active = renderInfo(
			job({ completedLength: 512, totalLength: 1024, speed: 128, filePath: "/tmp/file.bin" }),
			snapshot([]),
		);
		expect(active).toContain("name      file.bin");
		expect(active).toContain("50%");
		expect(active).toContain("512 B of 1.0 KiB");

		const failed = renderInfo(job({ state: "error", errorCode: 9, errorMessage: "disk full" }), snapshot([]));
		expect(failed).toContain("error 9");
	});

	test("stats shows daemon and config", () => {
		const text = renderStats(snapshot([job({ state: "active", speed: 2048 })]), config);
		expect(text).toContain("aria2 1.37.0");
		expect(text).toContain("8 connections per file");
		expect(text).toContain("2.0 KiB/s");
	});
});

describe("renderAction", () => {
	test("renders one line per job", () => {
		const text = renderAction("pause", [job({ handle: "dl-x-1", state: "paused" })], "done");
		expect(text).toContain("done");
		expect(text).toContain("dl-x-1");
		expect(text).toContain("paused");
	});
});

describe("renderWait", () => {
	test("finished downloads", () => {
		const text = renderWait(
			{ jobs: [job({ state: "complete", totalLength: 1024, filePath: "/tmp/file.bin" })], timedOut: false, aborted: false, elapsedMs: 5000 },
			300,
		);
		expect(text).toContain("1 download finished");
		expect(text).toContain("/tmp/file.bin");
	});

	test("timeout keeps running", () => {
		const text = renderWait(
			{ jobs: [job({ state: "active" })], timedOut: true, aborted: false, elapsedMs: 300_000 },
			300,
		);
		expect(text).toContain("timed out");
		expect(text).toContain("continue");
	});

	test("paused-only is explicit", () => {
		const text = renderWait(
			{ jobs: [job({ state: "paused" })], timedOut: false, aborted: false, elapsedMs: 0, pausedOnly: true },
			300,
		);
		expect(text).toContain("Nothing to wait for");
		expect(text).toContain("paused");
		expect(text).not.toContain("finished in 0s");
	});

	test("progress text updates", () => {
		const text = renderWaitProgress([job({ state: "active", completedLength: 50, totalLength: 100 })], 1000);
		expect(text).toContain("Waiting for 1 download");
		expect(text).toContain("1s");
		expect(text).toContain("50%");
	});
});

describe("details helpers", () => {
	test("toView mirrors the job", () => {
		const view = toView(job({ completedLength: 50, totalLength: 100, state: "active" }));
		expect(view.percent).toBe(50);
		expect(view.live).toBe(true);
		expect(view.url).toBe("https://example.com/file.zip");

		// Details are stored in the transcript, so tokens must not leak.
		const secret = toView(job({ urls: ["https://example.com/file.zip?token=secret"] }));
		expect(secret.url).toBe("https://example.com/file.zip");
		expect(secret.url).not.toContain("secret");
	});

	test("summaryFor covers actions", () => {
		const snap = snapshot([]);
		expect(summaryFor("pause", snap, [job({ state: "paused" })])).toContain("paused 1");
		expect(summaryFor("rm", snap, [job()])).toContain("files kept");
	});

	test("oneLine flattens and truncates", () => {
		expect(oneLine("a\n b   c")).toBe("a b c");
		expect(oneLine("x".repeat(200), 20)).toHaveLength(20);
	});
});
