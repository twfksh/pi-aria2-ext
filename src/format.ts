/** Pure, dependency-free formatting helpers. Unit tested without a daemon or TUI. */

import { URL } from "node:url";
import type { Job, JobState, Snapshot } from "./types.ts";

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Human byte size using binary units. `0` renders as `0 B`. */
export function bytes(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0 B";
	let n = value;
	let unit = 0;
	while (n >= 1024 && unit < UNITS.length - 1) {
		n /= 1024;
		unit++;
	}
	const digits = unit === 0 || n >= 100 ? 0 : 1;
	return `${n.toFixed(digits)} ${UNITS[unit]}`;
}

/** Human transfer rate, e.g. `1.2 MiB/s`. Empty string when idle. */
export function rate(bytesPerSecond: number): string {
	return bytesPerSecond > 0 ? `${bytes(bytesPerSecond)}/s` : "";
}

/** Human duration, e.g. `45s`, `1m12s`, `2h03m`. */
export function duration(seconds: number | undefined): string {
	if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";
	const s = Math.ceil(seconds);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return `${h}h${String(m).padStart(2, "0")}m`;
}

/** Completion percentage rounded to an integer, or 0 when the total is unknown. */
export function percent(completed: number, total: number): number {
	if (!Number.isFinite(total) || total <= 0) return 0;
	return clamp(Math.round((completed / total) * 100), 0, 100);
}

export function fraction(completed: number, total: number): number {
	if (!Number.isFinite(total) || total <= 0) return 0;
	return clamp(completed / total, 0, 1);
}

/** Seconds remaining at the current speed, or undefined when unknowable. */
export function etaSeconds(job: Pick<Job, "completedLength" | "totalLength" | "speed">): number | undefined {
	if (job.totalLength <= 0 || job.speed <= 0) return undefined;
	const remaining = job.totalLength - job.completedLength;
	if (remaining <= 0) return 0;
	return Math.ceil(remaining / job.speed);
}

/** Plain progress bar using full/empty blocks. Colours are applied by the renderer. */
export function progressBar(completed: number, total: number, width: number): string {
	const w = Math.max(1, Math.floor(width));
	const filled = clamp(Math.round(fraction(completed, total) * w), 0, w);
	return "█".repeat(filled) + "░".repeat(w - filled);
}

const STATE_GLYPHS: Record<JobState, string> = {
	queued: "…",
	waiting: "◌",
	active: "●",
	paused: "‖",
	complete: "✓",
	error: "✗",
	removed: "–",
};

export function stateGlyph(state: JobState): string {
	return STATE_GLYPHS[state] ?? "?";
}

export function stateLabel(state: JobState): string {
	switch (state) {
		case "queued":
			return "queued";
		case "waiting":
			return "waiting";
		case "active":
			return "downloading";
		case "paused":
			return "paused";
		case "complete":
			return "done";
		case "error":
			return "failed";
		case "removed":
			return "removed";
		default:
			return "unknown";
	}
}

export function isTerminal(state: JobState): boolean {
	return state === "complete" || state === "error" || state === "removed";
}

export function isLive(state: JobState): boolean {
	return !isTerminal(state);
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * URL for display. Userinfo and the query string are dropped so signed URLs and
 * access tokens never land in the transcript. The full URL stays in memory and
 * in the 0600 state file.
 */
export function displayUrl(raw: string): string {
	const value = raw.trim();
	if (/^magnet:/i.test(value)) {
		const name = /[?&]dn=([^&]+)/i.exec(value)?.[1];
		const hash = /[?&]xt=urn:btih:([a-z0-9]+)/i.exec(value)?.[1];
		const label = name ? safeDecode(name) : hash ? `${hash.slice(0, 10)}…` : "torrent";
		return truncate(`magnet:${label}`, 60);
	}
	try {
		const url = new URL(value);
		const auth = url.username || url.password ? "…@" : "";
		return truncate(`${url.protocol}//${auth}${url.host}${url.pathname}`, 80);
	} catch {
		return truncate(value, 80);
	}
}

/** Best-effort file name from a URL; falls back to the host. */
export function fileNameFromUrl(raw: string): string | undefined {
	if (/^magnet:/i.test(raw)) {
		const name = /[?&]dn=([^&]+)/i.exec(raw)?.[1];
		return name ? safeDecode(name) : undefined;
	}
	try {
		const url = new URL(raw);
		const base = url.pathname.split("/").filter(Boolean).pop();
		return base ? safeDecode(base) : url.hostname || undefined;
	} catch {
		return undefined;
	}
}

export function baseName(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? path;
}

/** Display name: aria2 path, then torrent name, then URL, then handle. */
export function jobName(job: Pick<Job, "handle" | "filePath" | "name" | "urls">): string {
	if (job.name) return job.name;
	if (job.filePath) return baseName(job.filePath);
	const fromUrl = job.urls[0] ? fileNameFromUrl(job.urls[0]) : undefined;
	return fromUrl || job.handle;
}

const ERROR_HINTS: Record<number, string> = {
	1: "unknown error",
	2: "timed out",
	3: "resource not found (404)",
	4: "resource not found after the configured retries",
	5: "download aborted: speed too slow",
	6: "network problem",
	7: "unfinished downloads remain",
	8: "remote server did not support resume",
	9: "disk full",
	10: "piece length mismatch",
	11: "another file with the same name is already being downloaded",
	12: "another torrent with the same info hash is already being downloaded",
	13: "file already exists (pi-aria2 never overwrites)",
	14: "could not rename the file",
	15: "could not open an existing file",
	16: "could not create a new file",
	17: "file I/O error",
	18: "could not create the destination directory",
	19: "name resolution failed (DNS)",
	20: "could not parse the Metalink document",
	21: "FTP command failed",
	22: "unexpected HTTP response header",
	23: "too many redirects",
	24: "HTTP authorization failed",
	25: "could not parse the bencoded file",
	26: "corrupt .torrent file",
	27: "invalid magnet URI",
	28: "invalid or unrecognized aria2 option",
	29: "remote server could not handle the request",
	30: "could not parse the RPC request",
};

/** Human explanation for an aria2 error, including its numeric code. */
export function humanError(code: number | undefined, message?: string): string {
	if (!code && !message) return "unknown error";
	const hint = code ? ERROR_HINTS[code] : undefined;
	const detail = message?.trim();
	if (hint && detail && !detail.toLowerCase().includes(hint.split(" (")[0]!.toLowerCase())) {
		return `error ${code}: ${hint} (${detail})`;
	}
	if (hint) return `error ${code}: ${hint}`;
	if (detail) return code ? `error ${code}: ${detail}` : detail;
	return "unknown error";
}

/** One compact line describing a job. Plain text; callers add colour. */
export function jobLine(job: Job, options: { barWidth?: number; nameWidth?: number } = {}): string {
	const name = truncate(jobName(job), options.nameWidth ?? 34);
	const barWidth = options.barWidth ?? 14;
	const glyph = stateGlyph(job.state);
	if (job.state === "error") {
		return `${glyph} ${job.handle}  ${humanError(job.errorCode, job.errorMessage)}  ${name}`;
	}
	const pct = percent(job.completedLength, job.totalLength);
	const bar = progressBar(job.completedLength, job.totalLength, barWidth);
	const size = `${bytes(job.completedLength)}/${job.totalLength > 0 ? bytes(job.totalLength) : "?"}`;
	const speed = rate(job.speed);
	const eta = duration(etaSeconds(job));
	const tail =
		job.state === "paused"
			? `${size} · paused`
			: job.state === "complete"
				? bytes(job.totalLength || job.completedLength)
				: [size, speed, eta ? `eta ${eta}` : ""].filter(Boolean).join(" · ");
	return `${glyph} ${job.handle}  ${String(pct).padStart(3)}% ${bar}  ${name}  ${tail}`.trimEnd();
}

/** Aggregate one-liner used for collapsed tool results and the status bar. */
export function summaryLine(snapshot: Snapshot): string {
	const active = snapshot.jobs.filter((j) => j.state === "active").length;
	const waiting = snapshot.jobs.filter((j) => j.state === "waiting" || j.state === "queued").length;
	const paused = snapshot.jobs.filter((j) => j.state === "paused").length;
	const failed = snapshot.jobs.filter((j) => j.state === "error").length;
	const done = snapshot.jobs.filter((j) => j.state === "complete").length;
	const speed = rate(snapshot.global.downloadSpeed);
	const parts = [
		active ? `${active} active` : "",
		waiting ? `${waiting} waiting` : "",
		paused ? `${paused} paused` : "",
		failed ? `${failed} failed` : "",
		speed,
	].filter(Boolean);
	if (parts.length) return parts.join(" · ");
	if (done > 0) return `${done} finished`;
	return "no active downloads";
}

export function sortJobs(jobs: Job[]): Job[] {
	const order: Record<JobState, number> = {
		active: 0,
		queued: 1,
		waiting: 2,
		paused: 3,
		error: 4,
		complete: 5,
		removed: 6,
	};
	return [...jobs].sort((a, b) => {
		const byState = order[a.state] - order[b.state];
		return byState !== 0 ? byState : a.createdAt - b.createdAt;
	});
}

export function formatHandles(handles: string[]): string {
	if (handles.length === 0) return "all";
	if (handles.length === 1) return handles[0]!;
	return `${handles[0]} +${handles.length - 1}`;
}
