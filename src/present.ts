/** Pure presentation helpers used by the tool result and by tests. */

import {
	bytes,
	duration,
	etaSeconds,
	humanError,
	jobLine,
	jobName,
	percent,
	rate,
	sortJobs,
	stateGlyph,
	stateLabel,
	summaryLine,
	displayUrl,
} from "./format.ts";
import type { Aria2Config, GlobalStat, Job, JobState, Snapshot, WaitOutcome } from "./types.ts";

export type JobFilter = "all" | "active" | "waiting" | "paused" | "done" | "failed";

export interface JobView {
	handle: string;
	name: string;
	state: JobState;
	percent: number;
	completedLength: number;
	totalLength: number;
	speed: number;
	etaSeconds?: number;
	filePath?: string;
	url: string;
	dir: string;
	errorCode?: number;
	errorMessage?: string;
	live: boolean;
}

export interface DownloadDetails {
	_type: "pi-aria2-ext";
	action: string;
	ok: boolean;
	summary: string;
	text: string;
	jobs: JobView[];
	global: GlobalStat;
	daemon: string;
	version?: string;
	error?: string;
	timedOut?: boolean;
}

export function toView(job: Job): JobView {
	return {
		handle: job.handle,
		name: jobName(job),
		state: job.state,
		percent: percent(job.completedLength, job.totalLength),
		completedLength: job.completedLength,
		totalLength: job.totalLength,
		speed: job.speed,
		etaSeconds: etaSeconds(job),
		filePath: job.filePath,
		url: displayUrl(job.urls[0] ?? ""),
		dir: job.options.dir,
		errorCode: job.errorCode,
		errorMessage: job.errorMessage,
		live: job.state !== "complete" && job.state !== "error" && job.state !== "removed",
	};
}

export function filterJobs(jobs: Job[], filter: JobFilter): Job[] {
	switch (filter) {
		case "active":
			return jobs.filter((job) => job.state === "active");
		case "waiting":
			return jobs.filter((job) => job.state === "queued" || job.state === "waiting");
		case "paused":
			return jobs.filter((job) => job.state === "paused");
		case "done":
			return jobs.filter((job) => job.state === "complete");
		case "failed":
			return jobs.filter((job) => job.state === "error");
		case "all":
			return jobs;
	}
}

function section(title: string, jobs: Job[], barWidth = 14): string[] {
	if (jobs.length === 0) return [];
	const lines = [`${title} (${jobs.length})`];
	for (const job of sortJobs(jobs)) lines.push(`  ${jobLine(job, { barWidth })}`);
	return lines;
}

const FILTER_LABEL: Record<JobFilter, string> = {
	all: "all downloads",
	active: "downloads",
	waiting: "waiting downloads",
	paused: "paused downloads",
	done: "finished downloads",
	failed: "failed downloads",
};

const FILTER_COUNT: Record<JobFilter, string> = {
	all: "downloads",
	active: "active",
	waiting: "waiting",
	paused: "paused",
	done: "finished",
	failed: "failed",
};

export function renderList(snapshot: Snapshot, filter: JobFilter = "all"): string {
	const jobs = filterJobs(snapshot.jobs, filter);
	if (jobs.length === 0) {
		if (snapshot.jobs.length === 0) {
			return "No downloads yet.\nUse download({ action: \"add\", url: \"https://…\" }) to start one.";
		}
		return `No ${FILTER_LABEL[filter]}.`;
	}

	const active = jobs.filter((job) => job.state === "active");
	const waiting = jobs.filter((job) => job.state === "queued" || job.state === "waiting");
	const paused = jobs.filter((job) => job.state === "paused");
	const done = jobs.filter((job) => job.state === "complete");
	const failed = jobs.filter((job) => job.state === "error");

	const sections: string[] = [];
	const activeSpeed = rate(active.reduce((sum, job) => sum + job.speed, 0));
	if (active.length > 0) sections.push(...section(activeSpeed ? `Active · ${activeSpeed}` : "Active", active));
	if (waiting.length > 0) sections.push(...section("Waiting", waiting));
	if (paused.length > 0) sections.push(...section("Paused", paused));
	if (done.length > 0) sections.push(...section("Done", done));
	if (failed.length > 0) sections.push(...section("Failed", failed));

	const header =
		filter === "all"
			? summaryLine(snapshot)
			: `${jobs.length} ${FILTER_COUNT[filter]}`;
	return [header, "", ...sections].join("\n").trimEnd();
}

export function renderAdd(jobs: Job[], dir: string): string {
	if (jobs.length === 0) return "No downloads were added.";
	const failed = jobs.filter((job) => job.state === "error");
	const ok = jobs.length - failed.length;
	const head =
		failed.length === 0
			? `Queued ${ok} download${ok === 1 ? "" : "s"} in ${dir}`
			: `Queued ${ok} of ${jobs.length} downloads in ${dir}`;
	const lines = [head];
	for (const job of jobs) {
		if (job.state === "error") {
			lines.push(`  ${stateGlyph(job.state)} ${job.handle}  ${humanError(job.errorCode, job.errorMessage)}`);
		} else {
			lines.push(`  ${stateGlyph(job.state)} ${job.handle}  ${jobName(job)}  ${displayUrl(job.urls[0] ?? "")}`);
		}
	}
	const firstOk = jobs.find((job) => job.state !== "error");
	if (firstOk) {
		lines.push("");
		lines.push(
			`Track progress with download({ action: "wait", handle: "${firstOk.handle}" }) or open /downloads.`,
		);
	}
	return lines.join("\n");
}

export function renderInfo(job: Job, snapshot: Snapshot): string {
	const view = toView(job);
	const lines = [
		`${job.handle} · ${stateLabel(job.state)} · ${view.percent}%`,
		`  name      ${view.name}`,
		`  url       ${view.url}`,
		`  dir       ${view.dir}`,
	];
	if (view.filePath) lines.push(`  file      ${view.filePath}`);
	if (view.totalLength > 0) {
		lines.push(
			`  size      ${bytes(view.completedLength)} of ${bytes(view.totalLength)} (${view.percent}%)`,
		);
	} else if (view.completedLength > 0) {
		lines.push(`  size      ${bytes(view.completedLength)}`);
	}
	if (job.state === "error") {
		lines.push(`  error     ${humanError(job.errorCode, job.errorMessage)}`);
	} else if (job.state === "paused") {
		lines.push(`  transfer  paused`);
	} else if (job.state === "active") {
		lines.push(
			`  transfer  ${rate(job.speed) || "—"}${job.connections ? ` · ${job.connections} connections` : ""}${
				view.etaSeconds ? ` · eta ${duration(view.etaSeconds)}` : ""
			}`,
		);
	} else if (job.state === "complete") {
		lines.push(`  transfer  finished`);
	}
	lines.push(`  added     ${new Date(job.createdAt).toISOString()}`);
	if (snapshot.daemon !== "running") lines.push(`  daemon    ${snapshot.daemon}`);
	return lines.join("\n");
}

export function renderStats(snapshot: Snapshot, config: Aria2Config): string {
	const live = snapshot.jobs.filter((job) => job.state !== "complete" && job.state !== "error");
	const done = snapshot.jobs.filter((job) => job.state === "complete");
	const failed = snapshot.jobs.filter((job) => job.state === "error");
	const lines = [
		`aria2 ${snapshot.version ?? "(not running)"} · daemon ${snapshot.daemon}`,
		`  ${live.length} live · ${done.length} finished · ${failed.length} failed`,
		`  download  ${rate(snapshot.global.downloadSpeed) || "idle"}${
			snapshot.global.uploadSpeed > 0 ? ` · upload ${rate(snapshot.global.uploadSpeed)}` : ""
		}`,
		`  dir       ${config.defaultDir}`,
		`  files     ${config.split} connections per file · ${config.maxConcurrent} concurrent`,
	];
	if (config.allowedRoot) lines.push(`  confined  ${config.allowedRoot}`);
	if (snapshot.lastError) lines.push(`  last error  ${snapshot.lastError}`);
	return lines.join("\n");
}

export function renderAction(action: string, jobs: Job[], extra?: string): string {
	if (jobs.length === 0) return extra ?? `Nothing to ${action}.`;
	const lines: string[] = [];
	if (extra) lines.push(extra);
	for (const job of jobs) {
		const name = jobName(job);
		const suffix =
			job.state === "error"
				? humanError(job.errorCode, job.errorMessage)
				: `${stateLabel(job.state)}${job.state === "active" ? ` · ${rate(job.speed) || "starting"}` : ""}`;
		lines.push(`  ${stateGlyph(job.state)} ${job.handle}  ${name}  ${suffix}`);
	}
	return lines.join("\n");
}

export function renderWait(outcome: WaitOutcome, timeoutSec: number): string {
	const finished = outcome.jobs.filter((job) => job.state === "complete");
	const failed = outcome.jobs.filter((job) => job.state === "error");
	const running = outcome.jobs.filter((job) => job.state !== "complete" && job.state !== "error");
	const elapsed = duration(outcome.elapsedMs / 1000);
	const lines: string[] = [];
	if (outcome.jobs.length === 0) return "No downloads to wait for.";
	if (outcome.pausedOnly) {
		lines.push(
			`Nothing to wait for: ${outcome.jobs.length} download${outcome.jobs.length === 1 ? " is" : "s are"} paused. Resume with download({ action: "resume" }).`,
		);
	} else if (outcome.aborted) {
		lines.push(`Wait cancelled after ${elapsed}; downloads continue in the background.`);
	} else if (outcome.timedOut) {
		lines.push(`Wait timed out after ${timeoutSec}s; ${running.length} download(s) still running (they continue).`);
	} else if (failed.length === 0) {
		lines.push(
			outcome.elapsedMs === 0 && finished.length > 0
				? `✓ ${finished.length} download${finished.length === 1 ? "" : "s"} already finished`
				: `✓ ${finished.length} download${finished.length === 1 ? "" : "s"} finished in ${elapsed}`,
		);
	} else if (finished.length === 0) {
		lines.push(`✗ ${failed.length} download${failed.length === 1 ? "" : "s"} failed after ${elapsed}`);
	} else {
		lines.push(`${finished.length} finished, ${failed.length} failed after ${elapsed}`);
	}
	for (const job of outcome.jobs) {
		if (job.state === "complete") {
			lines.push(`  ✓ ${job.handle}  ${jobName(job)}  ${bytes(job.totalLength || job.completedLength)}${job.filePath ? `  ${job.filePath}` : ""}`);
		} else if (job.state === "error") {
			lines.push(`  ✗ ${job.handle}  ${jobName(job)}  ${humanError(job.errorCode, job.errorMessage)}`);
		} else {
			lines.push(`  ${stateGlyph(job.state)} ${job.handle}  ${jobLine(job)}`);
		}
	}
	return lines.join("\n");
}

export function summaryFor(action: string, snapshot: Snapshot, jobs: Job[]): string {
	const failed = jobs.filter((job) => job.state === "error").length;
	switch (action) {
		case "add": {
			const ok = jobs.length - failed;
			return failed ? `queued ${ok} of ${jobs.length} (${failed} failed)` : `queued ${ok} download${ok === 1 ? "" : "s"}`;
		}
		case "list":
			return `${snapshot.jobs.length} job${snapshot.jobs.length === 1 ? "" : "s"} · ${summaryLine(snapshot)}`;
		case "info":
			return jobs[0] ? `${jobName(jobs[0])} · ${stateLabel(jobs[0].state)} · ${percent(jobs[0].completedLength, jobs[0].totalLength)}%` : "not found";
		case "pause":
			return `paused ${jobs.length} download${jobs.length === 1 ? "" : "s"}`;
		case "resume":
			return `resumed ${jobs.length} download${jobs.length === 1 ? "" : "s"}`;
		case "rm":
			return `removed ${jobs.length} download${jobs.length === 1 ? "" : "s"} (files kept)`;
		case "retry":
			return `retrying ${jobs.length} download${jobs.length === 1 ? "" : "s"}`;
		case "purge":
			return `cleared ${jobs.length} finished download${jobs.length === 1 ? "" : "s"}`;
		case "stats":
			return summaryLine(snapshot);
		case "wait":
			return `${jobs.filter((job) => job.state === "complete").length}/${jobs.length} finished`;
		default:
			return summaryLine(snapshot);
	}
}
/** Live partial result while `wait` is blocking. */
export function renderWaitProgress(jobs: Job[], elapsedMs: number): string {
	const age = duration(elapsedMs / 1000);
	const speed = rate(jobs.filter((job) => job.state === "active").reduce((sum, job) => sum + job.speed, 0));
	const lines = [
		`Waiting for ${jobs.length} download${jobs.length === 1 ? "" : "s"} · ${age}${speed ? ` · ${speed}` : ""}`,
	];
	for (const job of sortJobs(jobs)) lines.push(`  ${jobLine(job)}`);
	return lines.join("\n");
}

/** Short, single-line text for the collapsed tool row. */
export function oneLine(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

