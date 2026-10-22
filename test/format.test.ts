import { describe, expect, test } from "bun:test";
import {
	baseName,
	bytes,
	duration,
	etaSeconds,
	fileNameFromUrl,
	formatHandles,
	fraction,
	humanError,
	isLive,
	isTerminal,
	jobLine,
	jobName,
	percent,
	progressBar,
	rate,
	sortJobs,
	stateGlyph,
	summaryLine,
	displayUrl,
} from "../src/format.ts";
import type { Job, Snapshot } from "../src/types.ts";

function job(overrides: Partial<Job> = {}): Job {
	return {
		handle: "dl-brisk-otter-42",
		urls: ["https://example.com/archive.iso?token=secret"],
		options: { dir: "/tmp/downloads", connections: 8 },
		createdAt: 1,
		state: "active",
		completedLength: 0,
		totalLength: 0,
		speed: 0,
		connections: 0,
		...overrides,
	};
}

describe("bytes and rates", () => {
	test("renders zero and small values", () => {
		expect(bytes(0)).toBe("0 B");
		expect(bytes(-5)).toBe("0 B");
		expect(bytes(512)).toBe("512 B");
	});

	test("uses binary units with sensible precision", () => {
		expect(bytes(1024)).toBe("1.0 KiB");
		expect(bytes(1536)).toBe("1.5 KiB");
		expect(bytes(1024 * 1024)).toBe("1.0 MiB");
		expect(bytes(5.5 * 1024 * 1024 * 1024)).toBe("5.5 GiB");
		expect(bytes(200 * 1024)).toBe("200 KiB");
	});

	test("rate is empty when idle", () => {
		expect(rate(0)).toBe("");
		expect(rate(1024)).toBe("1.0 KiB/s");
	});
});

describe("duration and eta", () => {
	test("formats seconds, minutes and hours", () => {
		expect(duration(0)).toBe("0s");
		expect(duration(45)).toBe("45s");
		expect(duration(72)).toBe("1m12s");
		expect(duration(3720)).toBe("1h02m");
		expect(duration(undefined)).toBe("");
	});

	test("computes eta from remaining bytes and speed", () => {
		expect(etaSeconds({ completedLength: 0, totalLength: 100, speed: 10 })).toBe(10);
		expect(etaSeconds({ completedLength: 100, totalLength: 100, speed: 10 })).toBe(0);
		expect(etaSeconds({ completedLength: 0, totalLength: 0, speed: 10 })).toBeUndefined();
		expect(etaSeconds({ completedLength: 0, totalLength: 100, speed: 0 })).toBeUndefined();
	});
});

describe("progress", () => {
	test("percent clamps and tolerates unknown totals", () => {
		expect(percent(50, 100)).toBe(50);
		expect(percent(0, 0)).toBe(0);
		expect(percent(200, 100)).toBe(100);
		expect(fraction(50, 100)).toBe(0.5);
	});

	test("bar fills the requested width", () => {
		expect(progressBar(0, 100, 4)).toBe("░░░░");
		expect(progressBar(50, 100, 4)).toBe("██░░");
		expect(progressBar(100, 100, 4)).toBe("████");
	});
});

describe("url display", () => {
	test("redacts userinfo and query strings", () => {
		expect(displayUrl("https://user:pass@example.com/file.iso?token=secret&x=1")).toBe(
			"https://…@example.com/file.iso",
		);
		expect(displayUrl("https://example.com/file.iso?token=secret")).toBe("https://example.com/file.iso");
	});

	test("condenses magnet links", () => {
		expect(displayUrl("magnet:?xt=urn:btih:abcdef0123456789&dn=My%20File")).toBe("magnet:My File");
	});

	test("extracts names from urls", () => {
		expect(fileNameFromUrl("https://example.com/a/b/file.tar.gz?x=1")).toBe("file.tar.gz");
		expect(fileNameFromUrl("https://example.com/")).toBe("example.com");
		expect(fileNameFromUrl("magnet:?dn=Name")).toBe("Name");
	});
});

describe("job presentation", () => {
	test("uses the aria2 path, then torrent name, then url, then handle", () => {
		expect(jobName(job({ filePath: "/tmp/a/movie.mkv" }))).toBe("movie.mkv");
		expect(jobName(job({ name: "Torrent Name" }))).toBe("Torrent Name");
		expect(jobName(job({ urls: ["https://x.test/file.zip"] }))).toBe("file.zip");
		expect(jobName(job({ urls: ["magnet:?xt=urn:btih:aa"] }))).toBe("dl-brisk-otter-42");
	});

	test("state helpers", () => {
		expect(isTerminal("complete")).toBe(true);
		expect(isTerminal("active")).toBe(false);
		expect(isLive("paused")).toBe(true);
		expect(stateGlyph("error")).toBe("✗");
	});

	test("error hints include the aria2 code", () => {
		expect(humanError(13, "File already exists")).toContain("error 13");
		expect(humanError(13, "File already exists")).toContain("never overwrites");
		expect(humanError(undefined, "boom")).toBe("boom");
	});

	test("jobLine includes handle, percent, name and size", () => {
		const line = jobLine(
			job({ completedLength: 512, totalLength: 1024, speed: 128, filePath: "/tmp/file.bin" }),
		);
		expect(line).toContain("dl-brisk-otter-42");
		expect(line).toContain("50%");
		expect(line).toContain("file.bin");
		expect(line).toContain("512 B/1.0 KiB");
	});

	test("sortJobs puts active first and completed last", () => {
		const jobs = [
			job({ handle: "a", state: "complete" }),
			job({ handle: "b", state: "active" }),
			job({ handle: "c", state: "paused" }),
		];
		expect(sortJobs(jobs).map((entry) => entry.handle)).toEqual(["b", "c", "a"]);
	});

	test("summary line aggregates", () => {
		const snapshot: Snapshot = {
			jobs: [
				job({ state: "active", speed: 2048 }),
				job({ handle: "p", state: "paused" }),
				job({ handle: "e", state: "error" }),
			],
			global: { downloadSpeed: 2048, uploadSpeed: 0, numActive: 1, numWaiting: 0, numStopped: 2 },
			daemon: "running",
		};
		const text = summaryLine(snapshot);
		expect(text).toContain("1 active");
		expect(text).toContain("1 paused");
		expect(text).toContain("1 failed");
		expect(text).toContain("2.0 KiB/s");
	});

	test("summary line reports finished history when nothing is live", () => {
		const snapshot: Snapshot = {
			jobs: [job({ state: "complete" })],
			global: { downloadSpeed: 0, uploadSpeed: 0, numActive: 0, numWaiting: 0, numStopped: 1 },
			daemon: "running",
		};
		expect(summaryLine(snapshot)).toBe("1 finished");
	});

	test("baseName and handle lists", () => {
		expect(baseName("/a/b/c.txt")).toBe("c.txt");
		expect(baseName("c.txt")).toBe("c.txt");
		expect(formatHandles([])).toBe("all");
		expect(formatHandles(["a"])).toBe("a");
		expect(formatHandles(["a", "b"])).toBe("a +1");
	});
});
