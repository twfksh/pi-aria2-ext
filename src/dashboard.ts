/** Interactive `/downloads` manager: a full-screen, keyboard-driven dashboard. */

import { join } from "node:path";
import { copyToClipboard, type ExtensionContext, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	type KeybindingsManager,
	type TUI,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	bytes,
	duration,
	etaSeconds,
	jobName,
	percent,
	progressBar,
	rate,
	sortJobs,
	stateGlyph,
	stateLabel,
	summaryLine,
	displayUrl,
} from "./format.ts";
import { DownloadManager, errorMessage } from "./manager.ts";
import { type JobFilter, filterJobs } from "./present.ts";
import type { Job, JobState } from "./types.ts";

const MAX_ROWS = 10;
const FILTERS: JobFilter[] = ["all", "active", "waiting", "paused", "done", "failed"];

function nextFilter(current: JobFilter): JobFilter {
	const index = FILTERS.indexOf(current);
	return FILTERS[(index + 1) % FILTERS.length] ?? "all";
}

function glyphColour(state: JobState): ThemeColor {
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

export class DownloadsDashboard implements Component {
	private readonly manager: DownloadManager;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (result: void) => void;
	private readonly unsubscribe: () => void;
	private readonly timer: ReturnType<typeof setInterval>;

	private filter: JobFilter = "all";
	private selectedHandle: string | undefined;
	private pendingRemove: string | undefined;
	private pendingPurge = false;
	private statusLine = "";
	private statusError = false;
	private statusUntil = 0;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private closed = false;

	constructor(
		manager: DownloadManager,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: void) => void,
	) {
		this.manager = manager;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.unsubscribe = manager.subscribe(() => this.refresh());
		this.timer = setInterval(() => {
			void manager.refresh();
		}, 1000);
		this.timer.unref?.();
		void manager.refresh(true);
	}

	private visibleJobs(): Job[] {
		return sortJobs(filterJobs(this.manager.snapshot().jobs, this.filter));
	}

	private selected(): Job | undefined {
		const jobs = this.visibleJobs();
		if (jobs.length === 0) return undefined;
		if (this.selectedHandle) {
			const found = jobs.find((job) => job.handle === this.selectedHandle);
			if (found) return found;
		}
		this.selectedHandle = jobs[0]!.handle;
		return jobs[0];
	}

	private move(delta: number): void {
		const jobs = this.visibleJobs();
		if (jobs.length === 0) return;
		const current = this.selected();
		const index = current ? jobs.findIndex((job) => job.handle === current.handle) : 0;
		const next = (index + delta + jobs.length) % jobs.length;
		this.selectedHandle = jobs[next]!.handle;
	}

	private refresh(): void {
		if (this.closed) return;
		this.invalidate();
		this.tui.requestRender();
	}

	private setStatus(message: string, error = false): void {
		if (this.closed) return;
		this.statusLine = message;
		this.statusError = error;
		this.statusUntil = Date.now() + 5000;
		this.refresh();
	}

	private act(label: string, action: () => Promise<unknown>): void {
		this.setStatus(`${label}…`);
		void action()
			.then(() => this.setStatus(label))
			.catch((error) => this.setStatus(errorMessage(error), true));
	}

	private toggleSelected(): void {
		const job = this.selected();
		if (!job) return;
		if (job.state === "paused") {
			this.act(`resumed ${job.handle}`, () => this.manager.resume(job.handle));
		} else if (job.state === "error") {
			this.act(`retried ${job.handle}`, () => this.manager.retry(job.handle));
		} else if (job.state === "active" || job.state === "waiting" || job.state === "queued") {
			this.act(`paused ${job.handle}`, () => this.manager.pause(job.handle));
		}
	}

	private copySelectedPath(): void {
		const job = this.selected();
		if (!job) return;
		const path = job.filePath ?? join(job.options.dir, job.options.out ?? jobName(job));
		void copyToClipboard(path)
			.then(() => this.setStatus(`copied ${path}`))
			.catch(() => this.setStatus(`path: ${path}`));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}

		const job = this.selected();
		const isRemoveConfirm = data === "d" && job !== undefined && this.pendingRemove === job.handle;
		const isPurgeConfirm = data === "x" && this.pendingPurge;

		if (this.keybindings.matches(data, "tui.select.up")) this.move(-1);
		else if (this.keybindings.matches(data, "tui.select.down")) this.move(1);
		else if (this.keybindings.matches(data, "tui.select.pageUp")) this.move(-MAX_ROWS);
		else if (this.keybindings.matches(data, "tui.select.pageDown")) this.move(MAX_ROWS);
		else if (this.keybindings.matches(data, "tui.select.confirm") || data === " ") this.toggleSelected();
		else if (data === "p" && job) this.act(`paused ${job.handle}`, () => this.manager.pause(job.handle));
		else if (data === "r" && job) this.act(`resumed ${job.handle}`, () => this.manager.resume(job.handle));
		else if (data === "R" && job) this.act(`retried ${job.handle}`, () => this.manager.retry(job.handle));
		else if (data === "c") this.copySelectedPath();
		else if (data === "f") {
			this.filter = nextFilter(this.filter);
			this.selectedHandle = undefined;
			this.setStatus(`filter: ${this.filter}`);
		} else if (data === "a") this.act("paused all downloads", () => this.manager.pause(undefined));
		else if (data === "A") this.act("resumed all downloads", () => this.manager.resume(undefined));
		else if (isRemoveConfirm && job) {
			this.pendingRemove = undefined;
			if (this.selectedHandle === job.handle) this.selectedHandle = undefined;
			this.act(`removed ${job.handle} (files kept)`, () => this.manager.remove(job.handle));
		} else if (data === "d" && job) {
			this.pendingRemove = job.handle;
			this.setStatus(`press d again to remove ${job.handle} — files stay on disk`, true);
			return;
		} else if (isPurgeConfirm) {
			this.pendingPurge = false;
			this.act("cleared finished downloads", () => this.manager.purge());
		} else if (data === "x") {
			this.pendingPurge = true;
			this.setStatus("press x again to clear finished/failed entries (files stay on disk)", true);
			return;
		} else {
			this.refresh();
			return;
		}

		if (!isRemoveConfirm && data !== "d") this.pendingRemove = undefined;
		if (!isPurgeConfirm && data !== "x") this.pendingPurge = false;
		this.refresh();
	}

	private detail(job: Job): string {
		if (job.state === "complete") return bytes(job.totalLength || job.completedLength);
		if (job.state === "error") return "failed";
		if (job.state === "paused") return `${bytes(job.completedLength)} · paused`;
		if (job.state === "waiting" || job.state === "queued") return stateLabel(job.state);
		const size = `${bytes(job.completedLength)}/${job.totalLength > 0 ? bytes(job.totalLength) : "?"}`;
		const speed = rate(job.speed);
		const eta = etaSeconds(job);
		return [size, speed, eta ? `eta ${duration(eta)}` : ""].filter(Boolean).join(" · ");
	}

	private row(job: Job, selected: boolean, width: number): string {
		const pct = percent(job.completedLength, job.totalLength);
		const bar = progressBar(job.completedLength, job.totalLength, 12);
		const empty = bar.indexOf("░");
		const split = empty === -1 ? bar.length : empty;
		const paintedBar = `${this.theme.fg(job.state === "error" ? "error" : "success", bar.slice(0, split))}${this.theme.fg("dim", bar.slice(split))}`;
		const marker = selected ? this.theme.fg("accent", "▸") : " ";
		const glyph = this.theme.fg(glyphColour(job.state), stateGlyph(job.state));
		const handle = this.theme.fg("dim", job.handle);
		const nameRoom = Math.max(12, width - 62 - job.handle.length);
		const name = truncateToWidth(jobName(job), nameRoom);
		const left = `${marker} ${glyph} ${String(pct).padStart(3)}% ${paintedBar}  ${handle} ${this.theme.fg(selected ? "text" : "muted", name)}`;
		const right = this.detail(job);
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return truncateToWidth(`${left}${" ".repeat(gap)}${this.theme.fg("dim", right)}`, width);
	}

	private contentWidth(width: number): number {
		return Math.max(10, width - 2);
	}

	private boxLine(content: string, width: number): string {
		const inner = this.contentWidth(width);
		const trunc = truncateToWidth(content, inner, "…", true);
		const pad = Math.max(0, inner - visibleWidth(trunc));
		return `${this.theme.fg("border", "│")}${trunc}${" ".repeat(pad)}${this.theme.fg("border", "│")}`;
	}

	private buildLines(width: number): string[] {
		const snapshot = this.manager.snapshot();
		const jobs = sortJobs(filterJobs(snapshot.jobs, this.filter));
		const allJobs = snapshot.jobs;
		const selected = this.selected();
		const inner = this.contentWidth(width);
		const border = (text: string) => this.theme.fg("border", text);

		const title = ` Downloads `;
		const topFill = Math.max(0, width - 2 - title.length);
		const lines: string[] = [
			`${border("┌─")}${this.theme.fg("accent", title)}${border("─".repeat(topFill))}${border("┐")}`,
		];

		const counts = summaryLine(snapshot);
		const filterLabel = this.filter === "all" ? "" : `  ·  filter: ${this.filter}`;
		lines.push(this.boxLine(` ${this.theme.fg("muted", counts)}${this.theme.fg("dim", filterLabel)}`, width));
		lines.push(this.boxLine("", width));

		if (jobs.length === 0) {
			const message =
				allJobs.length === 0
					? "No downloads. Use /download <url> or ask the agent to add one."
					: `No ${this.filter === "all" ? "" : `${this.filter} `}downloads. Press f to change the filter.`;
			lines.push(this.boxLine(` ${this.theme.fg("dim", message)}`, width));
		} else {
			const limit = Math.min(MAX_ROWS, Math.max(3, this.tui.terminal?.rows ? this.tui.terminal.rows - 12 : MAX_ROWS));
			const shown = jobs.slice(0, limit);
			for (const job of shown) {
				lines.push(this.boxLine(` ${this.row(job, job.handle === selected?.handle, inner - 2)}`, width));
			}
			if (jobs.length > shown.length) {
				lines.push(this.boxLine(` ${this.theme.fg("dim", `+${jobs.length - shown.length} more — press f to filter`)}`, width));
			}
		}

		lines.push(this.boxLine("", width));
		if (selected) {
			lines.push(this.boxLine(` ${this.theme.fg("text", jobName(selected))}`, width));
			const path = selected.filePath ?? selected.options.out ?? "—";
			lines.push(this.boxLine(` ${this.theme.fg("dim", path)}`, width));
			lines.push(this.boxLine(` ${this.theme.fg("dim", displayUrl(selected.urls[0] ?? ""))}`, width));
			if (selected.state === "error") {
				const reason = selected.errorMessage ?? "failed";
				lines.push(this.boxLine(` ${this.theme.fg("error", reason)}`, width));
			}
		} else {
			lines.push(this.boxLine(` ${this.theme.fg("dim", "Nothing selected")}`, width));
		}

		lines.push(this.boxLine("", width));
		if (this.statusLine && Date.now() < this.statusUntil) {
			lines.push(
				this.boxLine(
					` ${this.theme.fg(this.statusError ? "warning" : "success", this.statusLine)}`,
					width,
				),
			);
		} else {
			lines.push(
				this.boxLine(
					` ${this.theme.fg("muted", "↑/↓ move")}  ${this.theme.fg("muted", "enter pause/resume")}  ${this.theme.fg("muted", "p pause")}  ${this.theme.fg("muted", "r resume")}  ${this.theme.fg("muted", "d remove")}  ${this.theme.fg("muted", "R retry")}`,
					width,
				),
			);
			lines.push(
				this.boxLine(
					` ${this.theme.fg("muted", "c copy path")}  ${this.theme.fg("muted", "f filter")}  ${this.theme.fg("muted", "x clear done")}  ${this.theme.fg("muted", "a/A all")}  ${this.theme.fg("muted", "esc close")}`,
					width,
				),
			);
		}
		lines.push(`${border("└")}${border("─".repeat(Math.max(0, width - 2)))}${border("┘")}`);

		return lines.map((line) => truncateToWidth(line, width));
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = this.buildLines(Math.max(20, width));
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe();
		clearInterval(this.timer);
	}

	private close(): void {
		this.dispose();
		this.done();
	}
}

/** Open the dashboard. Returns when the user closes it. */
export async function openDownloadsDashboard(manager: DownloadManager, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The downloads dashboard needs interactive mode; use download({ action: \"list\" }).", "warning");
		return;
	}
	manager.beginDashboard();
	try {
		await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
			return new DownloadsDashboard(manager, tui, theme, keybindings, done);
		});
	} finally {
		manager.endDashboard();
	}
}
