/** Focused split-pane downloads dashboard that takes over the prompt editor. */
import { CustomEditor, type KeybindingsManager, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	Key,
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bytes, displayUrl, jobName, percent, progressBar, rate, stateGlyph, stateLabel } from "./format.ts";
import type { DownloadManager } from "./manager.ts";
import type { Job } from "./types.ts";


function pad(value: string, width: number, alignRight = false): string {
	const text = truncateToWidth(value, width);
	const fill = " ".repeat(Math.max(0, width - visibleWidth(text)));
	return alignRight ? `${fill}${text}` : `${text}${fill}`;
}

function clockText(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Time spent actually transferring the file, not time since it was queued.
 * Undefined for downloads tracked before this was measured (restored history).
 */
function transferTime(job: Job): string | undefined {
	const settled = job.activeMs ?? 0;
	const running = job.activeSince !== undefined ? Date.now() - job.activeSince : 0;
	if (settled === 0 && running === 0) return undefined;
	return clockText(settled + running);
}

/** Path to hand to the desktop opener, or undefined when the file is not here yet. */
function localFile(job: Job): string | undefined {
	if (job.filePath) return job.filePath;
	if (!job.options.out) return undefined;
	return join(job.options.dir, job.options.out);
}

const RAIL = "┃";
const LABEL_WIDTH = 8;

function colour(state: Job["state"]): ThemeColor {
	switch (state) {
		case "active":
			return "accent";
		case "complete":
			return "success";
		case "error":
			return "error";
		case "paused":
			return "warning";
		default:
			return "muted";
	}
}

/** Handle at `index`, or undefined when the queue is empty. */
function handleAt(jobs: Job[], index: number): string | undefined {
	return jobs[index]?.handle;
}

/** Detail text shown after the progress bar. */
function progressDetail(job: Job): string {
	if (job.state === "active") return `${rate(job.speed) || "starting"} · ${bytes(job.completedLength)}`;
	if (job.state === "paused") return `paused · ${bytes(job.completedLength)}`;
	return bytes(job.totalLength || job.completedLength);
}

export class DownloadsDashboard extends CustomEditor {
	private readonly manager: DownloadManager;
	private readonly uiTheme: Theme;
	private readonly onClose: () => void;
	private readonly unsubscribe: () => void;
	private readonly timer: ReturnType<typeof setInterval>;
	private selectedHandle: string | undefined;
	private pendingRemove: string | undefined;
	private notice: string | undefined;
	private detailsOpen = true;

	constructor(
		manager: DownloadManager,
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		theme: Theme,
		onClose: () => void,
	) {
		super(tui, editorTheme, keybindings);
		this.manager = manager;
		this.uiTheme = theme;
		this.onClose = onClose;
		this.selectedHandle = this.jobs()[0]?.handle;
		this.unsubscribe = manager.subscribe(() => this.tui.requestRender());
		this.timer = setInterval(() => this.tui.requestRender(), 1000);
		this.timer.unref?.();
	}

	/** Stable order so selection cycles exactly one row per key press. */
	private jobs(): Job[] {
		return [...this.manager.snapshot().jobs].sort(
			(a, b) => a.createdAt - b.createdAt || a.handle.localeCompare(b.handle),
		);
	}

	override handleInput(data: string): void {
		// Kitty-protocol release events match the same key id as the press, so
		// dropping them is what keeps one physical press to exactly one move.
		if (isKeyRelease(data)) return;
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrlShift("o"))) {
			this.onClose();
			return;
		}
		const jobs = this.jobs();
		const index = jobs.findIndex((job) => job.handle === this.selectedHandle);
		const selected = jobs[index];
		this.notice = undefined;
		const up = matchesKey(data, "up") || data === "k";
		const down = matchesKey(data, "down") || data === "j";
		if (up && jobs.length) {
			this.selectedHandle = handleAt(jobs, (index <= 0 ? jobs.length : index) - 1);
		} else if (down && jobs.length) {
			this.selectedHandle = handleAt(jobs, (index + 1) % jobs.length);
		} else if (matchesKey(data, "enter")) {
			this.detailsOpen = !this.detailsOpen;
		} else if (data === "p" && selected) {
			void (selected.state === "paused" ? this.manager.resume(selected.handle) : this.manager.pause(selected.handle));
		} else if (data === "R" && selected?.state === "error") {
			void this.manager.retry(selected.handle);
		} else if (data === "o" && selected) {
			this.openSelected(selected);
		} else if (data === "d" && selected) {
			if (this.pendingRemove === selected.handle) {
				this.pendingRemove = undefined;
				void this.manager.remove(selected.handle);
			} else {
				this.pendingRemove = selected.handle;
			}
		} else {
			// The prompt is replaced, so printable keys must not land in the hidden
			// editor buffer; only control sequences (ctrl+c, etc.) pass through.
			if (data.length > 1 || data.charCodeAt(0) < 32) super.handleInput(data);
			return;
		}
		this.tui.requestRender();
	}

	/** Hand the finished file to the desktop's default program for its type. */
	private openSelected(job: Job): void {
		const path = localFile(job);
		if (!path || !existsSync(path)) {
			this.notice = "nothing to open yet — the file is not on disk";
			return;
		}
		const [command, args] =
			process.platform === "darwin"
				? ["open", [path]]
				: process.platform === "win32"
					? ["cmd", ["/c", "start", "", path]]
					: ["xdg-open", [path]];
		try {
			spawn(command, args, { detached: true, stdio: "ignore" }).unref();
			this.notice = `opened ${jobName(job)}`;
		} catch {
			this.notice = `could not open ${jobName(job)}`;
		}
	}

	/** Details for the selected download, shown directly beneath its row. */
	private details(job: Job, width: number): string[] {
		const room = Math.max(12, width - 4 - LABEL_WIDTH - 2);
		const path = job.filePath ?? join(job.options.dir, job.options.out ?? jobName(job));
		const rows: Array<[string, string, ThemeColor]> = [
			["Path", path, "muted"],
			["URL", displayUrl(job.urls[0] ?? ""), "muted"],
			["Size", job.totalLength > 0 ? `${bytes(job.completedLength)} / ${bytes(job.totalLength)}` : bytes(job.completedLength), "muted"],
		];
		if (job.state === "active") rows.splice(2, 0, ["Speed", rate(job.speed) || "starting", "accent"]);
		const took = transferTime(job);
		if (took) rows.push([job.state === "complete" ? "Took" : "Elapsed", took, "muted"]);
		if (job.errorMessage) rows.push(["Reason", job.errorMessage, "error"]);
		rows.push(["Handle", job.handle, "dim"]);
		return rows.map(([label, value, tone]) => {
			const padding = " ".repeat(Math.max(0, LABEL_WIDTH - label.length));
			return `      ${this.uiTheme.fg("dim", label)}${padding}${this.uiTheme.fg(tone, truncateToWidth(value, room))}`;
		});
	}

	override render(width: number): string[] {
		const jobs = this.jobs();
		if (!jobs.some((job) => job.handle === this.selectedHandle)) {
			this.selectedHandle = jobs[0]?.handle;
			this.pendingRemove = undefined;
		}
		const tally = { active: 0, queued: 0, done: 0, failed: 0 };
		for (const job of jobs) {
			if (job.state === "active") tally.active += 1;
			else if (job.state === "queued" || job.state === "waiting" || job.state === "paused") tally.queued += 1;
			else if (job.state === "complete") tally.done += 1;
			else if (job.state === "error") tally.failed += 1;
		}
		const summary =
			(
				[
					["active", tally.active],
					["queued", tally.queued],
					["done", tally.done],
					["failed", tally.failed],
				] as const
			)
				.filter(([, count]) => count > 0)
				.map(([label, count]) => `${count} ${label}`)
				.join(" · ") || "no downloads";

		// Every line hangs off a left rail so the dashboard reads as its own pane,
		// the way the prompt editor is framed.
		const body: Array<{ text: string; active: boolean }> = [];
		const inner = Math.max(10, width - RAIL.length);
		body.push({ text: ` ${this.uiTheme.fg("muted", `Downloads · ${summary}`)}`, active: false });
		body.push({ text: "", active: false });

		// One column template for every row: glyph, name, then a status area that
		// starts at a fixed column whether or not the row has progress to draw.
		const pctWidth = 4;
		const barWidth = 8;
		const chrome = 1 + 1 + 1 + 2 + pctWidth + 1 + barWidth + 2; // rail gutter, glyph, name gap, cells
		const nameColumn = Math.max(8, Math.min(32, inner - chrome - 18));
		const detailRoom = Math.max(6, inner - chrome - nameColumn);

		for (const job of jobs) {
			const isSelected = job.handle === this.selectedHandle;
			const glyph = this.uiTheme.fg(colour(job.state), stateGlyph(job.state));
			const rawName = pad(jobName(job), nameColumn);
			const name = isSelected
				? this.uiTheme.bold(this.uiTheme.fg("accent", rawName))
				: this.uiTheme.fg("text", rawName);
			const status = this.rowStatus(job, pctWidth, barWidth, detailRoom);
			const text = isSelected ? this.uiTheme.bold(status) : status;
			body.push({ text: ` ${glyph} ${name}  ${text}`, active: isSelected });
			if (isSelected && this.detailsOpen) {
				for (const line of this.details(job, inner)) body.push({ text: line, active: true });
			}
		}
		if (jobs.length === 0) {
			body.push({ text: this.uiTheme.fg("dim", " Nothing queued yet. Ask the agent to download something."), active: false });
		}

		body.push({ text: "", active: false });
		if (this.pendingRemove) {
			body.push({ text: this.uiTheme.fg("warning", ` Press d again to remove ${this.pendingRemove}; the file stays on disk.`), active: false });
		}
		if (this.notice) {
			body.push({ text: this.uiTheme.fg("muted", ` ${this.notice}`), active: false });
		}
		body.push({ text: this.uiTheme.fg("dim", " ↑↓ / j k move · ⏎ details · o open · p pause/resume · R retry · d remove · esc close"), active: false });

		return body.map(({ text, active }) => {
			const rail = active ? this.uiTheme.fg("accent", RAIL) : this.uiTheme.fg("border", RAIL);
			return truncateToWidth(`${rail}${text}`, width);
		});
	}

	/** Percent, bar, and detail for rows with progress; a plain status for the rest. */
	private rowStatus(job: Job, pctWidth: number, barWidth: number, room: number): string {
		if (job.state === "active" || job.state === "paused" || job.state === "complete") {
			const pct = pad(`${percent(job.completedLength, job.totalLength)}%`, pctWidth, true);
			const bar = this.uiTheme.fg("dim", progressBar(job.completedLength, job.totalLength, barWidth));
			const detail = truncateToWidth(progressDetail(job), room);
			return `${pct} ${bar}  ${this.uiTheme.fg("muted", detail)}`;
		}
		const size = bytes(job.totalLength || job.completedLength);
		const status = truncateToWidth(`${stateLabel(job.state)} · ${size}`, room + pctWidth + barWidth);
		return this.uiTheme.fg(colour(job.state), status);
	}

	override invalidate(): void {
		super.invalidate();
	}

	dispose(): void {
		this.unsubscribe();
		clearInterval(this.timer);
	}
}
