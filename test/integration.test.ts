/**
 * End-to-end test against a real aria2c process and a local range-capable HTTP
 * server. Skipped when aria2c is not installed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAria2Binary } from "../src/binary.ts";
import { DownloadManager } from "../src/manager.ts";
import { JobStore } from "../src/store.ts";
import type { Aria2Config } from "../src/types.ts";

const aria2 = await resolveAria2Binary().catch(() => undefined);
const maybe = aria2 ? test : test.skip;

const payload = randomBytes(2 * 1024 * 1024 + 123);
let server: Server;
let baseUrl = "";

beforeAll(async () => {
	server = createServer((req, res) => {
		res.setHeader("accept-ranges", "bytes");
		res.setHeader("content-type", "application/octet-stream");
		res.setHeader("content-length", String(payload.length));
		const range = req.headers.range;
		if (!range) {
			res.end(payload);
			return;
		}
		const match = /^bytes=(\d*)-(\d*)$/.exec(range);
		if (!match) {
			res.statusCode = 416;
			res.end();
			return;
		}
		const start = match[1] ? Number(match[1]) : 0;
		const requestedEnd = match[2] ? Number(match[2]) : payload.length - 1;
		const end = Math.min(requestedEnd, payload.length - 1);
		if (start > end) {
			res.statusCode = 416;
			res.end();
			return;
		}
		res.statusCode = 206;
		res.setHeader("content-range", `bytes ${start}-${end}/${payload.length}`);
		res.setHeader("content-length", String(end - start + 1));
		res.end(payload.subarray(start, end + 1));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function config(dir: string): Aria2Config {
	return {
		defaultDir: dir,
		split: 4,
		maxConcurrent: 2,
		notifyOnComplete: false,
		persist: true,
		stopWithPi: true,
		pollIntervalMs: 100,
		enableDht: false,
	};
}

async function managerFor(root: string): Promise<{ manager: DownloadManager; stateDir: string; dir: string }> {
	const dir = await mkdtemp(join(root, "downloads-"));
	const stateDir = join(root, "state");
	const store = new JobStore(stateDir, dir, true);
	const manager = new DownloadManager(config(dir), store, dir);
	await manager.load();
	return { manager, stateDir, dir };
}

describe("integration", () => {
	maybe("adds paused, resumes, completes, and keeps the file on remove", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-aria2-int-"));
		const { manager, dir } = await managerFor(root);
		try {
			const [job] = await manager.add({ urls: `${baseUrl}/file.bin`, paused: true });
			expect(job).toBeDefined();
			expect(job!.state).toBe("paused");

			const paused = await manager.wait([job!.handle], 2);
			expect(paused.pausedOnly).toBe(true);

			const resumed = await manager.resume([job!.handle]);
			expect(resumed.ok).toBe(true);

			const outcome = await manager.wait([job!.handle], 30);
			expect(outcome.timedOut).toBe(false);
			expect(outcome.jobs[0]?.state).toBe("complete");

			// Waiting again on a finished download reports it as already finished.
			const again = await manager.wait([job!.handle], 5);
			expect(again.jobs[0]?.state).toBe("complete");

			const file = join(dir, "file.bin");
			expect((await stat(file)).size).toBe(payload.length);
			expect(Buffer.compare(await readFile(file), payload)).toBe(0);

			await manager.remove([job!.handle]);
			expect((await stat(file)).size).toBe(payload.length);
			expect(manager.snapshot().jobs).toHaveLength(0);
		} finally {
			await manager.shutdown();
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);

	maybe("restores interrupted downloads paused after a restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-aria2-int-"));
		const first = await managerFor(root);
		let handle = "";
		try {
			const [job] = await first.manager.add({ urls: `${baseUrl}/file.bin`, paused: true });
			handle = job!.handle;
		} finally {
			await first.manager.shutdown();
		}

		try {
			// Same state directory and cwd as the first manager, so the state file matches.
			const store = new JobStore(join(root, "state"), first.dir, true);
			const manager = new DownloadManager(config(first.dir), store, first.dir);
			await manager.load();
			const restored = manager.snapshot().jobs.find((job) => job.handle === handle);
			expect(restored).toBeDefined();
			expect(restored!.state).toBe("paused");
			expect(manager.snapshot().daemon).toBe("stopped");

			await manager.resume([handle]);
			const outcome = await manager.wait([handle], 30);
			expect(outcome.jobs[0]?.state).toBe("complete");
			expect(Buffer.compare(await readFile(join(first.dir, "file.bin")), payload)).toBe(0);
			await manager.shutdown();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);

	maybe("removing saved history does not start a daemon", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-aria2-int-"));
		const first = await managerFor(root);
		let handle = "";
		try {
			const [job] = await first.manager.add({ urls: `${baseUrl}/never.bin`, paused: true });
			handle = job!.handle;
		} finally {
			await first.manager.shutdown();
		}

		const store = new JobStore(join(root, "state"), first.dir, true);
		const manager = new DownloadManager(config(first.dir), store, first.dir);
		await manager.load();
		await manager.remove([handle]);
		expect(manager.snapshot().daemon).toBe("stopped");
		expect(manager.snapshot().jobs).toHaveLength(0);
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}, 30_000);

	maybe("rejects unsupported URL schemes before starting the daemon", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-aria2-int-"));
		const { manager } = await managerFor(root);
		try {
			await expect(manager.add({ urls: "file:///etc/passwd" })).rejects.toThrow(/scheme/);
			expect(manager.snapshot().daemon).toBe("stopped");
		} finally {
			await manager.shutdown();
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);

	maybe("treats a fully-downloaded file as complete after a crash", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-aria2-int-"));
		const first = await managerFor(root);
		let handle = "";
		let stateFile = "";
		try {
			const [job] = await first.manager.add({ urls: `${baseUrl}/file.bin`, paused: true });
			handle = job!.handle;
			await first.manager.resume([handle]);
			await first.manager.wait([handle], 30);
			stateFile = first.manager.stateFile;
		} finally {
			await first.manager.shutdown();
		}

		// Simulate a crash after the data landed but before the final status save.
		const state = JSON.parse(await readFile(stateFile, "utf8"));
		const entry = (state.jobs as Array<{ handle: string; state: string }>).find((job) => job.handle === handle);
		expect(entry).toBeDefined();
		entry!.state = "paused";
		await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });

		const store = new JobStore(join(root, "state"), first.dir, true);
		const manager = new DownloadManager(config(first.dir), store, first.dir);
		try {
			await manager.load();
			await manager.ensureDaemon();
			const restored = manager.snapshot().jobs.find((job) => job.handle === handle);
			expect(restored?.state).toBe("complete");
		} finally {
			await manager.shutdown();
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);
	if (!aria2) {
		test("integration tests skipped (aria2c not installed)", () => {
			expect(true).toBe(true);
		});
	}
});
