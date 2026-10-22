/**
 * Download manager: one private daemon, a stable handle per download, live
 * status polling, persistence, and UI updates. The manager owns all mutable
 * state; tool handlers and the dashboard are thin front ends.
 */

import { randomInt } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Aria2MissingError, resolveAria2Binary } from "./binary.ts";
import { type DaemonHandle, DaemonStartError, startDaemon } from "./daemon.ts";
import {
	Aria2Error,
	type Aria2Status,
	type RawGlobalStat,
	STATUS_KEYS,
} from "./rpc.ts";
import { baseName, clamp, humanError, isTerminal, jobName, percent, rate, sortJobs } from "./format.ts";
import type { JobStore } from "./store.ts";
import type {
	ActionResult,
	AddInput,
	Aria2Config,
	DaemonState,
	GlobalStat,
	Job,
	JobState,
	Snapshot,
	SnapshotListener,
	WaitOutcome,
} from "./types.ts";
import {
	UserError,
	clampConnections,
	clampTimeout,
	normalizeHandle,
	parseMaxSpeed,
	parseUrls,
	resolveDownloadDir,
	sanitizeOutName,
} from "./validate.ts";
import { ProgressWidget, type WidgetData } from "./widget.ts";

const WIDGET_KEY = "pi-aria2:widget";
const STATUS_KEY = "pi-aria2";

const ADJECTIVES = [
	"brisk",
	"calm",
	"clever",
	"deft",
	"eager",
	"fair",
	"fond",
	"glad",
	"keen",
	"lively",
	"merry",
	"neat",
	"nimble",
	"proud",
	"quick",
	"quiet",
	"rapid",
	"ready",
	"sharp",
	"sleek",
	"smart",
	"snug",
	"swift",
	"tidy",
	"warm",
	"wise",
	"zesty",
];

const NOUNS = [
	"otter",
	"heron",
	"lark",
	"pika",
	"mole",
	"finch",
	"gecko",
	"ibis",
	"koala",
	"lynx",
	"marten",
	"newt",
	"osprey",
	"panda",
	"quail",
	"raven",
	"seal",
	"tern",
	"vole",
	"wren",
	"yak",
	"zebra",
];

const EMPTY_GLOBAL: GlobalStat = {
	downloadSpeed: 0,
	uploadSpeed: 0,
	numActive: 0,
	numWaiting: 0,
	numStopped: 0,
};

export function errorMessage(error: unknown): string {
	if (error instanceof Aria2MissingError) return error.message;
	if (error instanceof DaemonStartError) {
		const tail = error.stderr.trim();
		return tail ? `${error.message}\n${tail.slice(-800)}` : error.message;
	}
	if (error instanceof Aria2Error) {
		if (error.code === 1 && /unauthorized/i.test(error.message)) {
			return "aria2 RPC authentication failed; restart the Pi session to start a fresh daemon.";
		}
		return humanError(error.code, error.message);
	}
	if (error instanceof Error) return error.message;
	return String(error);
}

function num(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function mapState(status: string): JobState {
	switch (status) {
		case "active":
			return "active";
		case "waiting":
			return "waiting";
		case "paused":
			return "paused";
		case "complete":
			return "complete";
		case "error":
			return "error";
		case "removed":
			return "removed";
		default:
			return "waiting";
	}
}

function parseGlobal(stat: RawGlobalStat): GlobalStat {
	return {
		downloadSpeed: num(stat.downloadSpeed),
		uploadSpeed: num(stat.uploadSpeed),
		numActive: num(stat.numActive),
		numWaiting: num(stat.numWaiting),
		numStopped: num(stat.numStopped),
	};
}

function sleepUntilAbort(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

type Scope = "live" | "failed" | "all";

export class DownloadManager {
	private readonly cfg: Aria2Config;
	private readonly store: JobStore;
	private readonly cwd: string;

	private readonly jobs = new Map<string, Job>();
	private readonly gidByHandle = new Map<string, string>();
	private readonly handleByGid = new Map<string, string>();

	private daemon: DaemonHandle | undefined;
	private connecting: Promise<DaemonHandle> | undefined;
	private daemonState: DaemonState = "stopped";
	private lastError: string | undefined;
	private version: string | undefined;
	private global: GlobalStat = { ...EMPTY_GLOBAL };

	private ui: ExtensionUIContext | undefined;
	private hasUI = false;
	private mode: ExtensionContext["mode"] = "tui";
	private widgetEnabled = false;
	private widget: ProgressWidget | undefined;
	private widgetTui: TUI | undefined;

	private readonly listeners = new Set<SnapshotListener>();
	private readonly recentDone = new Map<string, number>();
	private pollTimer: ReturnType<typeof setTimeout> | undefined;
	private refreshing = false;
	private hydrated = false;
	private closed = false;
	private restoring = false;
	private dashboardRefs = 0;
	private waiters = 0;
	private lastSignature = "";
	private lastNotifyAt = 0;

	constructor(config: Aria2Config, store: JobStore, cwd: string) {
		this.cfg = config;
		this.store = store;
		this.cwd = cwd;
	}

	get config(): Aria2Config {
		return this.cfg;
	}

	get stateFile(): string {
		return this.store.file;
	}

	setUI(ui: ExtensionUIContext, hasUI: boolean, mode: ExtensionContext["mode"]): void {
		this.ui = ui;
		this.hasUI = hasUI;
		this.mode = mode;
	}

	/** Load persisted job intent. Never starts a daemon; that stays lazy. */
	async load(): Promise<void> {
		const persisted = await this.store.load();
		for (const entry of persisted) {
			if (this.jobs.has(entry.handle)) continue;
			const state: JobState =
				entry.state === "complete" || entry.state === "error" ? entry.state : "paused";
			this.jobs.set(entry.handle, {
				handle: entry.handle,
				urls: entry.urls,
				options: {
					dir: entry.dir,
					out: entry.out,
					connections: entry.connections,
					maxSpeed: entry.maxSpeed,
				},
				createdAt: entry.createdAt,
				state,
				completedLength: entry.completedLength ?? 0,
				totalLength: entry.totalLength ?? 0,
				speed: 0,
				connections: 0,
				filePath: entry.filePath,
				name: entry.name,
				errorCode: entry.errorCode,
				errorMessage: entry.errorMessage,
			});
		}
		this.hydrated = true;
		this.emit(true);
	}

	subscribe(listener: SnapshotListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	snapshot(): Snapshot {
		const jobs = sortJobs([...this.jobs.values()]);
		const active = jobs.filter((job) => job.state === "active").length;
		const waiting = jobs.filter((job) => job.state === "waiting" || job.state === "queued").length;
		const stopped = jobs.filter((job) => isTerminal(job.state)).length;
		return {
			jobs,
			global: {
				downloadSpeed: this.daemonState === "running" ? this.global.downloadSpeed : 0,
				uploadSpeed: this.daemonState === "running" ? this.global.uploadSpeed : 0,
				numActive: active,
				numWaiting: waiting,
				numStopped: stopped,
			},
			daemon: this.daemonState,
			lastError: this.lastError,
			version: this.version,
		};
	}

	/** Start the daemon if needed and return it. Concurrent callers share one start. */
	async ensureDaemon(): Promise<DaemonHandle> {
		if (this.closed) throw new Error("the download manager has shut down");
		if (this.daemon) return this.daemon;
		if (this.connecting) return this.connecting;
		this.connecting = this.startDaemon().finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	private async startDaemon(): Promise<DaemonHandle> {
		this.daemonState = "starting";
		this.emit(true);
		let binary: string;
		try {
			binary = await resolveAria2Binary();
		} catch (error) {
			this.daemonState = "error";
			this.lastError = errorMessage(error);
			this.emit(true);
			throw error;
		}

		try {
			const daemon = await startDaemon({
				binary,
				defaultDir: this.cfg.defaultDir,
				stateDir: this.store.stateDir,
				stopWithPid: this.cfg.stopWithPi ? process.pid : undefined,
				split: this.cfg.split,
				maxConcurrent: this.cfg.maxConcurrent,
				maxSpeed: this.cfg.maxSpeed,
				enableDht: this.cfg.enableDht,
			});
			this.daemon = daemon;
			daemon.onExit((code, signal) => this.handleDaemonExit(daemon, code, signal));
			if (this.daemon !== daemon) {
				await daemon.shutdown().catch(() => {});
				throw new DaemonStartError("aria2 exited immediately after starting");
			}
			this.daemonState = "running";
			this.version = daemon.version;
			this.lastError = undefined;
			this.widgetEnabled = true;
			await this.restoreJobs(daemon);
			this.emit(true);
			this.schedulePoll(0);
			return daemon;
		} catch (error) {
			this.daemonState = "error";
			this.lastError = errorMessage(error);
			this.emit(true);
			throw error;
		}
	}

	private handleDaemonExit(daemon: DaemonHandle, code: number | null, signal: NodeJS.Signals | null): void {
		if (this.daemon !== daemon || this.closed) return;
		this.daemon = undefined;
		this.daemonState = "stopped";
		this.version = undefined;
		this.global = { ...EMPTY_GLOBAL };
		this.gidByHandle.clear();
		this.handleByGid.clear();
		for (const job of this.jobs.values()) {
			if (isTerminal(job.state)) continue;
			job.gid = undefined;
			job.state = "paused";
			job.speed = 0;
		}
		this.lastError = `aria2 exited (${signal ? `signal ${signal}` : `code ${code ?? "?"}`}); live downloads were paused and will resume from their partial files.`;
		this.store.schedule([...this.jobs.values()]);
		this.emit(true);
	}

	/** Re-add interrupted downloads to a fresh daemon, paused. */
	private async restoreJobs(daemon: DaemonHandle): Promise<void> {
		const restorable = [...this.jobs.values()].filter(
			(job) => job.state !== "complete" && job.state !== "error" && !job.gid,
		);
		if (restorable.length === 0) return;

		// A crash can happen after the data file is complete but before the final
		// status poll. Detect that case so the user sees "done" instead of an
		// error when aria2 refuses to overwrite the existing file.
		const batch: Job[] = [];
		for (const job of restorable) {
			if (await this.isCompleteOnDisk(job)) {
				job.state = "complete";
				job.completedLength = job.totalLength;
				job.speed = 0;
				job.finishedAt ??= Date.now();
			} else {
				batch.push(job);
			}
		}
		if (batch.length === 0) {
			this.store.schedule([...this.jobs.values()]);
			return;
		}
		const selected = batch.slice(0, 50);
		this.restoring = true;
		try {
			const results = await daemon.client.multicall(
				selected.map((job) => ["aria2.addUri", [job.urls, this.ariaOptions(job, true)]]),
				{ timeoutMs: 20000 },
			);
			for (let index = 0; index < selected.length; index++) {
				const job = selected[index]!;
				const result = results[index];
				if (result?.ok && typeof result.value === "string") {
					job.gid = result.value;
					this.bind(job);
					job.state = "paused";
					job.speed = 0;
				} else {
					job.state = "error";
					job.speed = 0;
					if (result && !result.ok) {
						job.errorCode = result.error.code;
						job.errorMessage = result.error.message;
					}
				}
			}
		} catch (error) {
			this.lastError = `could not restore saved downloads: ${errorMessage(error)}`;
		} finally {
			this.restoring = false;
			this.store.schedule([...this.jobs.values()]);
		}
	}

	/** True when the data file exists at the expected size and aria2 left no control file. */
	private async isCompleteOnDisk(job: Job): Promise<boolean> {
		if (job.totalLength <= 0) return false;
		const path = job.filePath ?? (job.options.out ? join(job.options.dir, job.options.out) : undefined);
		if (!path) return false;
		let info;
		try {
			info = await stat(path);
		} catch {
			return false;
		}
		if (!info.isFile() || info.size !== job.totalLength) return false;
		try {
			await stat(`${path}.aria2`);
			// aria2 still has a control file, so it considers this download unfinished.
			return false;
		} catch {
			return true;
		}
	}

	async add(input: AddInput): Promise<Job[]> {
		const urls = parseUrls(input.urls);
		const dir = await resolveDownloadDir(input.dir ?? this.cfg.defaultDir, {
			cwd: this.cwd,
			allowedRoot: this.cfg.allowedRoot,
		});
		const out = sanitizeOutName(input.out);
		if (out && urls.length > 1) {
			throw new UserError("out can only be used when adding a single url; add files separately");
		}
		const connections = clampConnections(input.connections, this.cfg.split);
		const maxSpeed = parseMaxSpeed(input.maxSpeed) ?? this.cfg.maxSpeed;
		const paused = input.paused === true;

		const daemon = await this.ensureDaemon();
		const created: Job[] = [];
		for (const url of urls) {
			const job: Job = {
				handle: this.newHandle(),
				urls: [url],
				options: { dir, out, connections, maxSpeed },
				createdAt: Date.now(),
				state: paused ? "paused" : "queued",
				completedLength: 0,
				totalLength: 0,
				speed: 0,
				connections: 0,
				name: undefined,
			};
			try {
				const gid = await daemon.client.addUri([url], this.ariaOptions(job, paused));
				job.gid = gid;
				this.bind(job);
			} catch (error) {
				this.markError(job, error);
			}
			this.jobs.set(job.handle, job);
			created.push(job);
		}
		await this.store.flush([...this.jobs.values()]);
		await this.refresh(true);
		return created.map((job) => this.jobs.get(job.handle) ?? job);
	}

	private ariaOptions(job: Job, paused: boolean): Record<string, string> {
		const options: Record<string, string> = {
			dir: job.options.dir,
			split: String(job.options.connections),
			"max-connection-per-server": String(job.options.connections),
		};
		if (job.options.out) options.out = job.options.out;
		if (job.options.maxSpeed) options["max-download-limit"] = job.options.maxSpeed;
		if (paused) options.pause = "true";
		return options;
	}

	/** Poll aria2 and update every tracked job. Safe to call concurrently. */
	async refresh(force = false): Promise<Snapshot> {
		if (this.refreshing || !this.daemon) {
			if (force) this.emit(true);
			return this.snapshot();
		}
		this.refreshing = true;
		try {
			const client = this.daemon.client;
			const results = await client.multicall(
				[
					["aria2.tellActive", [STATUS_KEYS]],
					["aria2.tellWaiting", [0, 1000, STATUS_KEYS]],
					["aria2.tellStopped", [0, 1000, STATUS_KEYS]],
					["aria2.getGlobalStat", []],
				],
				{ timeoutMs: 6000 },
			);
			const statuses = new Map<string, Aria2Status>();
			for (let index = 0; index < 3; index++) {
				const result = results[index];
				if (result?.ok && Array.isArray(result.value)) {
					for (const raw of result.value as Aria2Status[]) {
						if (raw?.gid) statuses.set(raw.gid, raw);
					}
				}
			}
			const stat = results[3];
			if (stat?.ok) this.global = parseGlobal(stat.value as RawGlobalStat);

			const missing = [...this.jobs.values()].filter(
				(job) => job.gid && !statuses.has(job.gid) && !isTerminal(job.state),
			);
			if (missing.length > 0) {
				const extra = await client.multicall(
					missing.map((job) => ["aria2.tellStatus", [job.gid!, STATUS_KEYS]]),
					{ timeoutMs: 6000 },
				);
				for (let index = 0; index < missing.length; index++) {
					const result = extra[index];
					if (result?.ok && result.value && typeof result.value === "object") {
						statuses.set(missing[index]!.gid!, result.value as Aria2Status);
					} else {
						const job = missing[index]!;
						job.state = "error";
						job.speed = 0;
						job.errorMessage = "aria2 is no longer tracking this download (it may have been purged elsewhere)";
					}
				}
			}

			for (const job of this.jobs.values()) {
				const status = job.gid ? statuses.get(job.gid) : undefined;
				if (status) this.applyStatus(job, status);
			}
			this.lastError = undefined;
			this.pruneRecentDone();
		} catch (error) {
			this.lastError = errorMessage(error);
		} finally {
			this.refreshing = false;
		}
		this.emit(force);
		this.schedulePoll();
		return this.snapshot();
	}

	private applyStatus(job: Job, status: Aria2Status): void {
		const previous = job.state;
		job.state = mapState(status.status);
		job.completedLength = num(status.completedLength);
		job.totalLength = num(status.totalLength);
		job.speed = num(status.downloadSpeed);
		job.connections = num(status.connections);
		const code = num(status.errorCode);
		job.errorCode = code > 0 ? code : undefined;
		job.errorMessage = status.errorMessage || undefined;
		const path = status.files?.[0]?.path;
		if (path) job.filePath = path;
		const torrentName = status.bittorrent?.info?.name;
		if (torrentName) {
			job.name = torrentName;
		} else if (path) {
			job.name = baseName(path);
		}

		if (job.state === "complete" && previous !== "complete") {
			job.finishedAt = Date.now();
			this.recentDone.set(job.handle, Date.now());
			this.notifyCompletion(job);
			this.store.schedule([...this.jobs.values()]);
		} else if (job.state === "error" && previous !== "error") {
			this.notifyFailure(job);
			this.store.schedule([...this.jobs.values()]);
		}
	}

	private notifyCompletion(job: Job): void {
		if (!this.hydrated || this.restoring || !this.cfg.notifyOnComplete || !this.hasUI || !this.ui) return;
		const now = Date.now();
		if (now - this.lastNotifyAt < 500) return;
		this.lastNotifyAt = now;
		try {
			this.ui.notify(`✓ ${jobName(job)} downloaded`, "info");
		} catch {
			// The UI context can expire after a turn; notifications are best effort.
		}
	}

	private notifyFailure(job: Job): void {
		if (!this.hydrated || this.restoring || !this.cfg.notifyOnComplete || !this.hasUI || !this.ui) return;
		const now = Date.now();
		if (now - this.lastNotifyAt < 500) return;
		this.lastNotifyAt = now;
		try {
			this.ui.notify(`✗ ${jobName(job)}: ${humanError(job.errorCode, job.errorMessage)}`, "error");
		} catch {
			// See notifyCompletion.
		}
	}

	resolveHandle(input: string): Job | undefined {
		const raw = input.trim();
		if (!raw) return undefined;
		const byGid = this.handleByGid.get(raw);
		if (byGid) return this.jobs.get(byGid);
		const normalized = normalizeHandle(raw);
		const exact = [...this.jobs.keys()].find((handle) => handle.toLowerCase() === normalized);
		if (exact) return this.jobs.get(exact);
		const matches = [...this.jobs.keys()].filter((handle) => handle.toLowerCase().startsWith(normalized));
		if (matches.length === 1) return this.jobs.get(matches[0]!);
		if (matches.length > 1) {
			throw new UserError(`ambiguous handle "${raw}" (${matches.length} matches); use more characters`);
		}
		return undefined;
	}

	/** Resolve a handle list ("all", undefined, one, or many) and filter by scope. */
	selectJobs(handles: string | string[] | undefined, scope: Scope): Job[] {
		const all = [...this.jobs.values()];
		const inScope = (job: Job) => {
			if (scope === "live") return !isTerminal(job.state);
			if (scope === "failed") return job.state === "error";
			return true;
		};
		const explicit =
			handles !== undefined &&
			!(Array.isArray(handles) && handles.length === 0) &&
			!(typeof handles === "string" && handles.trim().toLowerCase() === "all");
		if (!explicit) return all.filter(inScope);

		const list = Array.isArray(handles) ? handles : [handles];
		const selected: Job[] = [];
		for (const item of list) {
			if (item.trim().toLowerCase() === "all") {
				selected.push(...all.filter(inScope));
				continue;
			}
			const job = this.resolveHandle(item);
			if (!job) throw new UserError(`unknown download handle "${item}"`);
			if (inScope(job)) selected.push(job);
		}
		return [...new Map(selected.map((job) => [job.handle, job])).values()];
	}

	async pause(handles: string | string[] | undefined): Promise<ActionResult> {
		const daemon = await this.ensureDaemon();
		const jobs = this.selectJobs(handles, "live");
		const changed: Job[] = [];
		const problems: string[] = [];
		for (const job of jobs) {
			if (job.state === "paused") {
				changed.push(job);
				continue;
			}
			if (!job.gid) {
				changed.push(job);
				continue;
			}
			try {
				await daemon.client.pause(job.gid);
				job.state = "paused";
				job.speed = 0;
				changed.push(job);
			} catch (error) {
				problems.push(`${job.handle}: ${errorMessage(error)}`);
			}
		}
		this.store.schedule([...this.jobs.values()]);
		await this.refresh(true);
		return {
			action: "pause",
			ok: problems.length === 0,
			jobs: changed,
			error: problems.length > 0 ? problems.join("; ") : undefined,
		};
	}

	async resume(handles: string | string[] | undefined): Promise<ActionResult> {
		const daemon = await this.ensureDaemon();
		const jobs = this.selectJobs(handles, "live");
		const changed: Job[] = [];
		const problems: string[] = [];
		for (const job of jobs) {
			if (job.state === "active" || job.state === "waiting" || job.state === "queued") {
				changed.push(job);
				continue;
			}
			try {
				if (job.gid) {
					try {
						await daemon.client.unpause(job.gid);
					} catch (error) {
						if (error instanceof Aria2Error && /not found|not tracked/i.test(error.message)) {
							await this.readd(job, false);
						} else {
							throw error;
						}
					}
				} else {
					await this.readd(job, false);
				}
				job.state = job.gid ? "queued" : job.state;
				job.speed = 0;
				changed.push(job);
			} catch (error) {
				problems.push(`${job.handle}: ${errorMessage(error)}`);
			}
		}
		this.store.schedule([...this.jobs.values()]);
		await this.refresh(true);
		return {
			action: "resume",
			ok: problems.length === 0,
			jobs: changed,
			error: problems.length > 0 ? problems.join("; ") : undefined,
		};
	}

	private async readd(job: Job, paused: boolean): Promise<void> {
		const daemon = await this.ensureDaemon();
		const gid = await daemon.client.addUri(job.urls, this.ariaOptions(job, paused));
		job.gid = gid;
		this.bind(job);
		job.state = paused ? "paused" : "queued";
		job.speed = 0;
		job.errorCode = undefined;
		job.errorMessage = undefined;
	}

	/**
	 * Remove downloads from the queue. This never touches files on disk: the
	 * partial or completed file and its .aria2 control file stay where they are.
	 */
	async remove(handles: string | string[] | undefined): Promise<ActionResult> {
		const explicit =
			handles !== undefined &&
			!(Array.isArray(handles) && handles.length === 0) &&
			!(typeof handles === "string" && handles.trim().toLowerCase() === "all");
		const jobs = explicit ? this.selectJobs(handles, "all") : this.selectJobs(undefined, "live");
		const removed: Job[] = [];
		// Only talk to a daemon that is already running; removing saved history
		// must not start one.
		const daemon = this.daemon;
		for (const job of jobs) {
			if (job.gid && daemon) {
				try {
					if (!isTerminal(job.state)) await daemon.client.remove(job.gid);
				} catch {
					// Already stopped; the result cleanup below still applies.
				}
				try {
					await daemon.client.removeDownloadResult(job.gid);
				} catch {
					// Not in the stopped list either.
				}
			}
			this.unbind(job);
			this.jobs.delete(job.handle);
			this.recentDone.delete(job.handle);
			removed.push(job);
		}
		this.store.schedule([...this.jobs.values()]);
		await this.refresh(true);
		return { action: "rm", ok: true, jobs: removed };
	}

	/** Drop finished/failed history. Files stay on disk. */
	async purge(): Promise<ActionResult> {
		const terminal = [...this.jobs.values()].filter((job) => isTerminal(job.state));
		if (this.daemon) {
			try {
				await this.daemon.client.purgeDownloadResult();
			} catch {
				// Best effort; local history is still cleared.
			}
		}
		for (const job of terminal) {
			this.unbind(job);
			this.jobs.delete(job.handle);
			this.recentDone.delete(job.handle);
		}
		this.store.schedule([...this.jobs.values()]);
		this.emit(true);
		return { action: "purge", ok: true, jobs: terminal };
	}

	async retry(handles: string | string[] | undefined): Promise<ActionResult> {
		await this.ensureDaemon();
		const jobs = this.selectJobs(handles, "failed");
		const retried: Job[] = [];
		const problems: string[] = [];
		for (const job of jobs) {
			try {
				await this.readd(job, false);
				retried.push(job);
			} catch (error) {
				job.state = "error";
				if (error instanceof Aria2Error) job.errorCode = error.code;
				job.errorMessage = errorMessage(error);
				problems.push(`${job.handle}: ${errorMessage(error)}`);
			}
		}
		this.store.schedule([...this.jobs.values()]);
		await this.refresh(true);
		return {
			action: "retry",
			ok: problems.length === 0,
			jobs: retried,
			error: problems.length > 0 ? problems.join("; ") : undefined,
		};
	}

	async info(handle: string): Promise<Job> {
		const job = this.resolveHandle(handle);
		if (!job) throw new UserError(`unknown download handle "${handle}"`);
		return job;
	}

	/**
	 * Block until every selected live download is terminal, the timeout expires,
	 * or the caller aborts. Downloads keep running after a timeout or abort.
	 */
	async wait(
		handles: string | string[] | undefined,
		timeoutSec: number,
		signal?: AbortSignal,
		onProgress?: (jobs: Job[], elapsedMs: number) => void,
	): Promise<WaitOutcome> {
		await this.ensureDaemon();
		const live = this.selectJobs(handles, "live");
		// A paused download cannot make progress on its own. Waiting on one would
		// block until the timeout, so report it immediately and let the caller
		// decide whether to resume it.
		const targets = live.filter((job) => job.state !== "paused");
		const started = Date.now();
		if (targets.length === 0) {
			const paused = live.filter((job) => job.state === "paused");
			return {
				// Already-finished jobs are reported as such; paused jobs are
				// reported explicitly because they can never complete on their own.
				jobs: paused.length > 0 ? paused : this.selectJobs(handles, "all"),
				timedOut: false,
				aborted: false,
				elapsedMs: 0,
				pausedOnly: paused.length > 0,
			};
		}
		const wanted = new Set(targets.map((job) => job.handle));
		const timeout = clampTimeout(timeoutSec);
		const deadline = started + timeout * 1000;
		this.waiters += 1;
		try {
			for (;;) {
				await this.refresh(true);
				const current = [...wanted]
					.map((handle) => this.jobs.get(handle))
					.filter((job): job is Job => job !== undefined);
				onProgress?.(current, Date.now() - started);
				if (current.every((job) => isTerminal(job.state))) {
					return { jobs: current, timedOut: false, aborted: false, elapsedMs: Date.now() - started };
				}
				if (signal?.aborted) {
					return { jobs: current, timedOut: false, aborted: true, elapsedMs: Date.now() - started };
				}
				const remaining = deadline - Date.now();
				if (remaining <= 0) {
					return { jobs: current, timedOut: true, aborted: false, elapsedMs: Date.now() - started };
				}
				await sleepUntilAbort(Math.min(400, remaining), signal);
			}
		} finally {
			this.waiters -= 1;
			this.schedulePoll();
		}
	}

	beginDashboard(): void {
		this.dashboardRefs += 1;
		this.widgetEnabled = true;
		this.schedulePoll(0);
		void this.refresh(true);
	}

	endDashboard(): void {
		this.dashboardRefs = Math.max(0, this.dashboardRefs - 1);
		this.schedulePoll();
	}

	async shutdown(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = undefined;
		}
		try {
			this.ui?.setWidget(WIDGET_KEY, undefined);
			this.ui?.setStatus(STATUS_KEY, undefined);
		} catch {
			// UI may already be torn down.
		}
		this.widget = undefined;
		this.widgetTui = undefined;
		await this.store.flush([...this.jobs.values()]);
		const daemon = this.daemon;
		this.daemon = undefined;
		if (daemon) {
			await daemon.shutdown().catch(() => {});
		}
		this.daemonState = "stopped";
		await this.store.dispose();
		this.listeners.clear();
	}

	private newHandle(): string {
		for (let attempt = 0; attempt < 100; attempt++) {
			const handle = `dl-${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}-${randomInt(10, 100)}`;
			if (!this.jobs.has(handle)) return handle;
		}
		return `dl-${randomInt(0x100000, 0xffffff).toString(16)}`;
	}

	private bind(job: Job): void {
		if (!job.gid) return;
		this.gidByHandle.set(job.handle, job.gid);
		this.handleByGid.set(job.gid, job.handle);
	}

	private unbind(job: Job): void {
		const gid = this.gidByHandle.get(job.handle);
		this.gidByHandle.delete(job.handle);
		if (gid) this.handleByGid.delete(gid);
	}

	private markError(job: Job, error: unknown): void {
		job.state = "error";
		job.speed = 0;
		if (error instanceof Aria2Error) job.errorCode = error.code;
		job.errorMessage = errorMessage(error);
	}

	private schedulePoll(delay?: number): void {
		if (this.closed) return;
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = undefined;
		}
		if (!this.daemon) return;
		const jobs = [...this.jobs.values()];
		const hasLive = jobs.some((job) => !isTerminal(job.state));
		const hasRecent = this.recentDone.size > 0;
		if (!hasLive && !hasRecent && this.dashboardRefs === 0 && this.waiters === 0) return;
		const hasActive = jobs.some((job) => job.state === "active");
		const interval =
			delay ??
			(this.waiters > 0
				? 500
				: this.dashboardRefs > 0
					? 900
					: hasActive
						? this.cfg.pollIntervalMs
						: hasRecent
							? 1000
							: 2500);
		this.pollTimer = setTimeout(() => {
			this.pollTimer = undefined;
			void this.refresh();
		}, interval);
		// Polling must never be the reason the process stays alive.
		this.pollTimer.unref?.();
	}

	private pruneRecentDone(): void {
		const cutoff = Date.now() - 6000;
		for (const [handle, at] of this.recentDone) {
			if (at < cutoff) this.recentDone.delete(handle);
		}
	}

	private signature(snapshot: Snapshot): string {
		return [
			snapshot.daemon,
			snapshot.lastError ?? "",
			snapshot.jobs
				.map(
					(job) =>
						`${job.handle}:${job.state}:${percent(job.completedLength, job.totalLength)}:${clamp(Math.round(job.speed / 2048), 0, 1e9)}:${job.errorCode ?? ""}`,
				)
				.join("|"),
		].join("#");
	}

	private emit(force: boolean): void {
		const snapshot = this.snapshot();
		const signature = this.signature(snapshot);
		if (!force && signature === this.lastSignature) return;
		this.lastSignature = signature;
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch {
				// A dashboard listener must not break polling.
			}
		}
		this.updateChrome(snapshot);
	}

	private widgetData(snapshot: Snapshot): WidgetData {
		return { snapshot, recentDone: this.recentDone, now: Date.now() };
	}

	private updateChrome(snapshot: Snapshot): void {
		if (!this.hasUI || !this.ui || this.mode === "print" || this.mode === "json") return;
		const live = snapshot.jobs.filter((job) => !isTerminal(job.state));
		const recent = snapshot.jobs.some((job) => this.recentDone.has(job.handle));
		const active = snapshot.jobs.filter((job) => job.state === "active");
		const speed = rate(snapshot.global.downloadSpeed);

		try {
			if (!this.widgetEnabled) {
				if (live.length > 0) this.ui.setStatus(STATUS_KEY, `${live.length} saved · /downloads`);
				else this.ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			if (live.length === 0 && !recent) {
				this.ui.setWidget(WIDGET_KEY, undefined);
				this.ui.setStatus(STATUS_KEY, undefined);
				this.widget = undefined;
				this.widgetTui = undefined;
				return;
			}
			const status =
				active.length > 0
					? `↓ ${active.length}${speed ? ` · ${speed}` : ""}`
					: live.length > 0
						? `‖ ${live.length} paused`
						: undefined;
			this.ui.setStatus(STATUS_KEY, status);
			if (!this.widget) {
				this.ui.setWidget(
					WIDGET_KEY,
					(tui, theme) => {
						this.widgetTui = tui;
						this.widget = new ProgressWidget(this.widgetData(this.snapshot()), theme);
						return this.widget;
					},
					{ placement: "aboveEditor" },
				);
			} else {
				this.widget.update(this.widgetData(snapshot));
				this.widgetTui?.requestRender();
			}
		} catch {
			// The UI context can be gone during shutdown or a non-interactive turn.
		}
	}
}
