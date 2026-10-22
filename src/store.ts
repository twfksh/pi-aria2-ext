/**
 * Job-intent persistence.
 *
 * We store what is needed to re-add a download to a fresh daemon, not aria2's
 * gid (which is daemon-scoped). Completing a download and restarting Pi keeps
 * its history; an interrupted download is restored *paused* so a restart never
 * starts network traffic the user did not ask for.
 *
 * The file contains original URLs (which may embed tokens), so it is written
 * 0600 inside a 0700 directory.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseMaxSpeed, sanitizeOutName, validateUrl } from "./validate.ts";
import type { Job, JobState, PersistedJob, PersistedState } from "./types.ts";

const MAX_JOBS = 200;
const SAVE_DELAY_MS = 400;
const VALID_STATES = new Set<JobState>([
	"queued",
	"waiting",
	"active",
	"paused",
	"complete",
	"error",
	"removed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePersistedJob(value: unknown): PersistedJob | undefined {
	if (!isRecord(value)) return undefined;
	const handle = typeof value.handle === "string" ? value.handle.trim() : "";
	const urls: string[] = [];
	if (Array.isArray(value.urls)) {
		for (const raw of value.urls) {
			if (typeof raw !== "string") continue;
			try {
				urls.push(validateUrl(raw));
			} catch {
				// Drop a tampered or unsupported URL rather than re-adding it.
			}
		}
	}
	const dir = typeof value.dir === "string" && isAbsolute(value.dir) ? value.dir : "";
	const state = typeof value.state === "string" && VALID_STATES.has(value.state as JobState) ? (value.state as JobState) : "paused";
	if (!handle || urls.length === 0 || !dir) return undefined;
	const connections =
		typeof value.connections === "number" && Number.isFinite(value.connections)
			? Math.min(16, Math.max(1, Math.floor(value.connections)))
			: 8;
	const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : Date.now();
	const totalLength = typeof value.totalLength === "number" && Number.isFinite(value.totalLength) ? value.totalLength : 0;
	const completedLength =
		typeof value.completedLength === "number" && Number.isFinite(value.completedLength) ? value.completedLength : 0;
	let out: string | undefined;
	try {
		out = sanitizeOutName(typeof value.out === "string" ? value.out : undefined);
	} catch {
		out = undefined;
	}
	let maxSpeed: string | undefined;
	try {
		maxSpeed = parseMaxSpeed(typeof value.maxSpeed === "string" ? value.maxSpeed : undefined);
	} catch {
		maxSpeed = undefined;
	}
	const filePath = typeof value.filePath === "string" && value.filePath ? value.filePath : undefined;
	const name = typeof value.name === "string" && value.name ? value.name : undefined;
	const activeMs =
		typeof value.activeMs === "number" && Number.isFinite(value.activeMs) && value.activeMs >= 0
			? value.activeMs
			: undefined;
	const errorCode = typeof value.errorCode === "number" && Number.isFinite(value.errorCode) ? value.errorCode : undefined;
	const errorMessage = typeof value.errorMessage === "string" && value.errorMessage ? value.errorMessage : undefined;
	return {
		handle,
		urls,
		dir,
		out,
		connections,
		maxSpeed,
		createdAt,
		state,
		totalLength,
		completedLength,
		filePath,
		name,
		activeMs,
		errorCode,
		errorMessage,
	};
}

export function toPersisted(job: Job): PersistedJob {
	return {
		handle: job.handle,
		urls: job.urls,
		dir: job.options.dir,
		out: job.options.out,
		connections: job.options.connections,
		maxSpeed: job.options.maxSpeed,
		createdAt: job.createdAt,
		state: job.state,
		totalLength: job.totalLength,
		completedLength: job.completedLength,
		filePath: job.filePath,
		name: job.name,
		activeMs: job.activeMs,
		errorCode: job.errorCode,
		errorMessage: job.errorMessage,
	};
}

/** Keep every live job, plus the most recent finished history. */
export function pruneForStore(jobs: Job[]): Job[] {
	const live = jobs.filter((job) => job.state !== "complete" && job.state !== "error" && job.state !== "removed");
	const history = jobs
		.filter((job) => job.state === "complete" || job.state === "error" || job.state === "removed")
		.sort((a, b) => b.createdAt - a.createdAt);
	return [...live, ...history].slice(0, MAX_JOBS);
}

export class JobStore {
	readonly stateDir: string;
	readonly file: string;
	private readonly cwd: string;
	private readonly persist: boolean;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private chain: Promise<void> = Promise.resolve();
	private pending: PersistedJob[] | undefined;

	constructor(stateDir: string, cwd: string, persist = true) {
		this.stateDir = stateDir;
		this.cwd = cwd;
		this.persist = persist;
		const key = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
		this.file = join(stateDir, `jobs-${key}.json`);
	}

	async load(): Promise<PersistedJob[]> {
		if (!this.persist) return [];
		let raw: string;
		try {
			raw = await readFile(this.file, "utf8");
		} catch {
			return [];
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			await this.quarantine();
			return [];
		}
		if (!isRecord(parsed) || !Array.isArray(parsed.jobs)) {
			await this.quarantine();
			return [];
		}
		const jobs: PersistedJob[] = [];
		for (const entry of parsed.jobs) {
			const job = parsePersistedJob(entry);
			if (job) jobs.push(job);
		}
		// Newest first, then trim.
		jobs.sort((a, b) => b.createdAt - a.createdAt);
		return jobs.slice(0, MAX_JOBS);
	}

	private async quarantine(): Promise<void> {
		try {
			await rename(this.file, `${this.file}.corrupt-${Date.now()}`);
		} catch {
			// If quarantine fails, the next save overwrites the file anyway.
		}
	}

	/** Debounced save. The latest snapshot wins. */
	schedule(jobs: Job[]): void {
		if (!this.persist) return;
		this.pending = pruneForStore(jobs).map(toPersisted);
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.write(this.pending);
		}, SAVE_DELAY_MS);
	}

	/** Write immediately and wait for any earlier write to settle. */
	async flush(jobs: Job[]): Promise<void> {
		if (!this.persist) return;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.pending = pruneForStore(jobs).map(toPersisted);
		await this.write(this.pending);
	}

	private write(jobs: PersistedJob[] | undefined): Promise<void> {
		if (!this.persist || !jobs) return this.chain;
		const state: PersistedState = {
			version: 1,
			cwd: this.cwd,
			updatedAt: Date.now(),
			jobs,
		};
		const body = `${JSON.stringify(state, null, 2)}\n`;
		this.chain = this.chain
			.then(async () => {
				await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
				await chmod(this.stateDir, 0o700).catch(() => {});
				const temp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
				const handle = await open(temp, "wx", 0o600);
				try {
					await handle.writeFile(body, "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
				await rename(temp, this.file);
				await chmod(this.file, 0o600).catch(() => {});
			})
			.catch(() => {
				// Persistence is a convenience; a read-only home must not break downloads.
			});
		return this.chain;
	}

	async dispose(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		await this.chain.catch(() => {});
	}
}

/** Remove a state file for tests. */
export async function removeStateFile(file: string): Promise<void> {
	await unlink(file).catch(() => {});
}
