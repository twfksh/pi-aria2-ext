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
import { join } from "node:path";
import { bytes, displayUrl, jobName, percent, progressBar, rate, stateGlyph, stateLabel } from "./format.ts";
import type { DownloadManager } from "./manager.ts";
import type { Job } from "./types.ts";

const DIVIDER = " │ ";
const READY_WIDTH = 46;

function pad(value: string, width: number): string {
	const text = truncateToWidth(value, width);
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function elapsed(job: Job): string {
	const seconds = Math.max(0, Math.floor(((job.finishedAt ?? Date.now()) - job.createdAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

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

export class DownloadsDashboard extends CustomEditor {
	private readonly manager: DownloadManager;
	private readonly uiTheme: Theme;
	private readonly onClose: () => void;
	private readonly unsubscribe: () => void;
	private readonly timer: ReturnType<typeof setInterval>;
	private selectedHandle: string | undefined;
	private pendingRemove: string | undefined;
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
		if (matchesKey(data, "up") && jobs.length) {
			this.selectedHandle = jobs[(index <= 0 ? jobs.length : index) - 1]!.handle;
		} else if (matchesKey(data, "down") && jobs.length) {
			this.selectedHandle = jobs[(index + 1) % jobs.length]!.handle;
		} else if (matchesKey(data, "enter")) {
			this.detailsOpen = !this.detailsOpen;
		} else if (data === "p" && selected) {
			void (selected.state === "paused" ? this.manager.resume(selected.handle) : this.manager.pause(selected.handle));
		} else if (data === "R" && selected?.state === "error") {
			void this.manager.retry(selected.handle);
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

	/** Details for the selected download, shown directly beneath its row. */
	private details(job: Job, width: number): string[] {
		const room = Math.max(12, width - 4 - LABEL_WIDTH - 2);
		const path = job.filePath ?? join(job.options.dir, job.options.out ?? jobName(job));
		const rows: Array<[string, string, ThemeColor]> = [
			["Path", path, "muted"],
			["URL", displayUrl(job.urls[0] ?? ""), "muted"],
			["Size", job.totalLength > 0 ? `${bytes(job.completedLength)} / ${bytes(job.totalLength)}` : bytes(job.completedLength), "muted"],
			["Elapsed", elapsed(job), "muted"],
		];
		if (job.state === "active") rows.splice(2, 0, ["Speed", rate(job.speed) || "starting", "accent"]);
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
		const selected = jobs.find((job) => job.handle === this.selectedHandle);
		const counts = [
			{ label: "active", count: jobs.filter((job) => job.state === "active").length },
			{ label: "queued", count: jobs.filter((job) => ["queued", "waiting", "paused"].includes(job.state)).length },
			{ label: "done", count: jobs.filter((job) => job.state === "complete").length },
			{ label: "failed", count: jobs.filter((job) => job.state === "error").length },
		].filter((item) => item.count > 0).map((item) => `${item.count} ${item.label}`);
		const summary = counts.length > 0 ? counts.join(" · ") : "no downloads";
		const lines = [this.uiTheme.fg("muted", `Downloads · ${summary}`), ""];
		const nameWidth = Math.max(10, Math.min(34, width - 34));

		for (const job of jobs) {
			const isSelected = job.handle === this.selectedHandle;
			const marker = isSelected ? this.uiTheme.fg("accent", "▸") : " ";
			const glyph = this.uiTheme.fg(colour(job.state), stateGlyph(job.state));
			const name = pad(jobName(job), nameWidth);
			const live = job.state === "active" || job.state === "paused" || job.state === "complete";
			const tail = live
				? `${pad(`${percent(job.completedLength, job.totalLength)}%`, 4)} ${this.uiTheme.fg("dim", progressBar(job.completedLength, job.totalLength, 8))}  ${this.uiTheme.fg("muted", job.state === "active" ? `${rate(job.speed) || "starting"} · ${bytes(job.completedLength)}` : bytes(job.totalLength || job.completedLength))}`
				: `${this.uiTheme.fg(colour(job.state), stateLabel(job.state))}${job.state === "complete" || job.state === "error" ? this.uiTheme.fg("muted", ` · ${bytes(job.totalLength || job.completedLength)}`) : ""}`;
			lines.push(`  ${marker} ${glyph} ${isSelected ? this.uiTheme.fg("text", name) : name}  ${tail}`);
			if (isSelected && this.detailsOpen) lines.push(...this.details(job, width));
		}
		if (jobs.length === 0) lines.push(this.uiTheme.fg("dim", "  Nothing queued yet. Ask the agent to download something."));

		lines.push("");
		if (this.pendingRemove) {
			lines.push(this.uiTheme.fg("warning", `  Press d again to remove ${this.pendingRemove}; the file stays on disk.`));
		}
		lines.push(this.uiTheme.fg("dim", "  ↑↓ move · ⏎ details · p pause/resume · R retry · d remove · esc close"));
		return lines.map((line) => truncateToWidth(line, width));
	}

	override invalidate(): void {
		super.invalidate();
	}

	dispose(): void {
		this.unsubscribe();
		clearInterval(this.timer);
	}
}
