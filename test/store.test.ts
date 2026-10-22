import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, pruneForStore, toPersisted } from "../src/store.ts";
import type { Job } from "../src/types.ts";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-aria2-store-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function job(overrides: Partial<Job> = {}): Job {
	return {
		handle: "dl-brisk-otter-42",
		urls: ["https://example.com/file.zip?token=secret"],
		options: { dir: "/downloads", connections: 8, maxSpeed: "5M" },
		createdAt: 1_700_000_000_000,
		state: "active",
		completedLength: 10,
		totalLength: 100,
		speed: 0,
		connections: 0,
		filePath: "/downloads/file.zip",
		name: "file.zip",
		...overrides,
	};
}

describe("persisted shape", () => {
	test("toPersisted keeps options and error context", () => {
		const persisted = toPersisted(job({ state: "error", errorCode: 13, errorMessage: "exists" }));
		expect(persisted.urls[0]).toContain("token=secret");
		expect(persisted.dir).toBe("/downloads");
		expect(persisted.maxSpeed).toBe("5M");
		expect(persisted.errorCode).toBe(13);
		expect(persisted.errorMessage).toBe("exists");
	});

	test("pruneForStore keeps live jobs and recent history", () => {
		const live = job({ handle: "live", state: "active" });
		const oldDone = job({ handle: "old", state: "complete", createdAt: 1 });
		const newDone = job({ handle: "new", state: "complete", createdAt: 2 });
		const pruned = pruneForStore([live, oldDone, newDone]);
		expect(pruned.map((entry) => entry.handle)).toContain("live");
		expect(pruned).toHaveLength(3);
	});
});

describe("JobStore", () => {
	test("round-trips jobs and keeps the file private", async () => {
		const root = await tempDir();
		const store = new JobStore(join(root, "state"), root, true);
		await store.flush([job()]);
		const loaded = await store.load();
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.handle).toBe("dl-brisk-otter-42");
		expect(loaded[0]?.connections).toBe(8);
		if (process.platform !== "win32") {
			const mode = (await stat(store.file)).mode & 0o777;
			expect(mode).toBe(0o600);
		}
		const body = JSON.parse(await readFile(store.file, "utf8"));
		expect(body.version).toBe(1);
		expect(body.cwd).toBe(root);
	});

	test("returns an empty list when no file exists", async () => {
		const root = await tempDir();
		const store = new JobStore(join(root, "state"), root, true);
		expect(await store.load()).toEqual([]);
	});

	test("quarantines a corrupt file instead of crashing", async () => {
		const root = await tempDir();
		const store = new JobStore(join(root, "state"), root, true);
		await import("node:fs/promises").then((fs) => fs.mkdir(join(root, "state"), { recursive: true }));
		await writeFile(store.file, "{ not json");
		expect(await store.load()).toEqual([]);
		const files = await readdir(join(root, "state"));
		expect(files.some((name) => name.includes(".corrupt-"))).toBe(true);
	});

	test("persist=false never writes", async () => {
		const root = await tempDir();
		const store = new JobStore(join(root, "state"), root, false);
		await store.flush([job()]);
		expect(await store.load()).toEqual([]);
		await expect(stat(store.file)).rejects.toThrow();
	});

	test("different working directories use different files", async () => {
		const root = await tempDir();
		const a = new JobStore(join(root, "state"), "/project/a", true);
		const b = new JobStore(join(root, "state"), "/project/b", true);
		expect(a.file).not.toBe(b.file);
	});
});
