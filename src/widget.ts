/** Rendering for the persistent progress widget above the editor. */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	bytes,
	duration,
	etaSeconds,
	jobName,
	percent,
	progressBar,
	rate,
	stateGlyph,
	summaryLine,
} from "./format.ts";
import type { Job, Snapshot } from "./types.ts";

export interface WidgetData {
	snapshot: Snapshot;
	/** Completed jobs stay visible briefly so the user sees them land. */
	recentDone: Map<string, number>;
	now: number;
}

const MAX_ROWS = 6;
const HEADER = "Downloads";
const BAR_WIDTH = 12;


function stateColour(state: Job["state"]): ThemeColor {
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

function jobRow(theme: Theme, job: Job, width: number): string {
	const pct = percent(job.completedLength, job.totalLength);
	const bar = progressBar(job.completedLength, job.totalLength, BAR_WIDTH);
	const empty = bar.indexOf("░");
	const split = empty === -1 ? bar.length : empty;
	const paintedBar = `${theme.fg(stateColour(job.state), bar.slice(0, split))}${theme.fg("dim", bar.slice(split))}`;
	const name = jobName(job);
	const glyph = theme.fg(stateColour(job.state), stateGlyph(job.state));
	const pctText = theme.fg("muted", `${String(pct).padStart(3)}%`);
	const detail =
		job.state === "complete"
			? `${bytes(job.totalLength || job.completedLength)}`
			: job.state === "paused"
				? `${bytes(job.completedLength)}/${job.totalLength > 0 ? bytes(job.totalLength) : "?"} · paused`
				: `${bytes(job.completedLength)}/${job.totalLength > 0 ? bytes(job.totalLength) : "?"} · ${rate(job.speed) || "starting"}${
						etaSeconds(job) ? ` · ${duration(etaSeconds(job))}` : ""
					}`;
	const left = `  ${glyph} ${pctText} ${paintedBar}  ${name}`;
	const right = `  ${detail}`;
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(`${left}${" ".repeat(gap)}${theme.fg("dim", right)}`, width);
}

export function renderWidgetLines(data: WidgetData, theme: Theme, width: number): string[] {
	const { snapshot, recentDone, now } = data;

	const live = snapshot.jobs.filter(
		(job) => job.state === "active" || job.state === "waiting" || job.state === "queued" || job.state === "paused",
	);
	const recentlyDone = snapshot.jobs.filter((job) => {
		const at = recentDone.get(job.handle);
		return job.state === "complete" && at !== undefined && now - at < 5000;
	});
	const rows = [...live, ...recentlyDone].slice(0, MAX_ROWS);
	if (rows.length === 0) return [];

	const speed = rate(snapshot.global.downloadSpeed);
	const counts = summaryLine(snapshot);
	const heading = `${theme.fg("accent", "↓")} ${theme.fg("accent", HEADER)}`;
	const subtitle = `${speed ? `${speed} · ` : ""}${counts}${snapshot.jobs.length > rows.length ? ` · +${snapshot.jobs.length - rows.length} more` : ""}`;
	const lines = [truncateToWidth(`${heading}  ${theme.fg("dim", subtitle)}`, width)];
	for (const job of rows) lines.push(jobRow(theme, job, width));
	if (snapshot.daemon === "error" && snapshot.lastError) {
		lines.push(truncateToWidth(`  ${theme.fg("error", snapshot.lastError)}`, width));
	} else if (live.length === 0) {
		lines.push(truncateToWidth(`  ${theme.fg("dim", "open /downloads to manage the queue")}`, width));
	}
	return lines;
}

/** Stateless component; the manager mutates the data and requests a render. */
export class ProgressWidget implements Component {
	private data: WidgetData;
	private theme: Theme;

	constructor(data: WidgetData, theme: Theme) {
		this.data = data;
		this.theme = theme;
	}

	update(data: WidgetData, theme?: Theme): void {
		this.data = data;
		if (theme) this.theme = theme;
	}

	render(width: number): string[] {
		return renderWidgetLines(this.data, this.theme, width).map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		// Rendering is recomputed from data on every frame.
	}
}
