/**
 * pi-aria2-ext — fast, resumable downloads for Pi.
 *
 * One private aria2 daemon per session, loopback-only and secret-authenticated.
 * The model gets short `dl-*` handles; the user gets a live widget, a downloads
 * dashboard, and `/download` for quick adds.
 */

import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { loadConfig } from "./config.ts";
import { openDownloadsDashboard } from "./dashboard.ts";
import { displayUrl, formatHandles } from "./format.ts";
import { DownloadManager, errorMessage } from "./manager.ts";
import {
	type DownloadDetails,
	filterJobs,
	oneLine,
	renderAction,
	renderAdd,
	renderInfo,
	renderList,
	renderStats,
	renderWait,
	renderWaitProgress,
	summaryFor,
	toView,
	type JobFilter,
} from "./present.ts";
import { JobStore } from "./store.ts";
import type { Job } from "./types.ts";
import { clampTimeout, parseUrls, UserError } from "./validate.ts";

const ACTIONS = ["add", "list", "info", "pause", "resume", "rm", "retry", "purge", "wait", "stats"] as const;
const FILTERS = ["all", "active", "waiting", "paused", "done", "failed"] as const;

const DownloadParams = Type.Object({
	action: Type.Union(ACTIONS.map((action) => Type.Literal(action))),
	url: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String(), { maxItems: 20 })]),
	),
	handle: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String(), { maxItems: 50 })]),
	),
	dir: Type.Optional(Type.String({ description: "Destination directory for add. Defaults to the configured directory or cwd." })),
	out: Type.Optional(Type.String({ description: "File name for add (single URL only). Must not contain path separators." })),
	connections: Type.Optional(Type.Integer({ minimum: 1, maximum: 16, description: "Connections per file (1-16)." })),
	maxSpeed: Type.Optional(
		Type.Union([Type.String(), Type.Number({ minimum: 1 }), Type.Null()], {
			description: 'Per-download cap such as "5M" or "500K", or bytes/second.',
		}),
	),
	paused: Type.Optional(Type.Boolean({ description: "For add: queue without starting." })),
	filter: Type.Optional(Type.Union(FILTERS.map((filter) => Type.Literal(filter)))),
	timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
});

type DownloadArgs = Static<typeof DownloadParams>;

let manager: DownloadManager | undefined;

function stateDirectory(): string {
	return process.env.PI_ARIA2_HOME?.trim() || join(getAgentDir(), "pi-aria2");
}

function getManager(ctx: ExtensionContext): DownloadManager {
	if (manager) return manager;
	const config = loadConfig(getAgentDir());
	const store = new JobStore(stateDirectory(), ctx.cwd, config.persist);
	manager = new DownloadManager(config, store, ctx.cwd);
	manager.setUI(ctx.ui, ctx.hasUI, ctx.mode);
	return manager;
}

function normalizeHandles(value: string | string[] | undefined): string | string[] | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) return value.length === 0 ? undefined : value;
	return value;
}

function firstHandle(value: string | string[] | undefined): string | undefined {
	if (value === undefined) return undefined;
	return Array.isArray(value) ? value[0] : value;
}

function detailsFor(
	action: string,
	ok: boolean,
	text: string,
	snapshot: ReturnType<DownloadManager["snapshot"]>,
	jobs: Job[],
	extra: { error?: string; timedOut?: boolean; summary?: string } = {},
): DownloadDetails {
	const summary = extra.summary ?? summaryFor(action, snapshot, jobs);
	return {
		_type: "pi-aria2-ext",
		action,
		ok,
		summary,
		text,
		jobs: jobs.map(toView),
		global: snapshot.global,
		daemon: snapshot.daemon,
		version: snapshot.version,
		error: extra.error,
		timedOut: extra.timedOut,
	};
}

function failureDetails(
	action: string,
	message: string,
	snapshot: ReturnType<DownloadManager["snapshot"]>,
): DownloadDetails {
	return {
		_type: "pi-aria2-ext",
		action,
		ok: false,
		summary: message,
		text: message,
		jobs: [],
		global: snapshot.global,
		daemon: snapshot.daemon,
		version: snapshot.version,
		error: message,
	};
}

function toolResult(details: DownloadDetails) {
	return {
		content: [{ type: "text" as const, text: details.text }],
		details,
		isError: !details.ok,
	};
}

export default function registerDownloads(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "download",
		label: "Download",
		description: [
			"Fast, resumable downloads through a private local aria2 daemon.",
			"",
			"Actions:",
			'- add: queue one or more URLs. Parameters: url (string or array), dir, out, connections (1-16), maxSpeed ("5M"), paused.',
			"- list: show tracked downloads. Parameter: filter (all|active|waiting|paused|done|failed).",
			"- info: details for one handle.",
			'- pause | resume | rm | retry: act on handle (a dl-* handle, an aria2 gid, "all", or an array). rm removes downloads from the queue and never deletes files.',
			"- purge: clear finished/failed entries from the list; files are kept.",
			"- wait: block until the selected downloads finish. Parameters: handle, timeoutSec (1-3600, default 300). Downloads keep running if the wait times out.",
			"- stats: daemon and queue summary.",
			"",
			"Downloads never overwrite an existing file and resume from partial files. A live progress widget appears while transfers run; the user can open /downloads for the interactive manager.",
		].join("\n"),
		promptSnippet: "Download files quickly and resumably via aria2, with a managed queue",
		promptGuidelines: [
			"Prefer `download` over `bash` curl/wget for large, resumable, or progress-tracked files.",
			"After `add`, call `download({action:'wait', handle})` when the next step needs the file; it streams progress and returns when the download finishes.",
			"`download` never deletes or overwrites files. To re-download, remove the existing file first, then use `retry` or `add`.",
		],
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		executionMode: "sequential",
		parameters: DownloadParams,

		renderCall(args, theme) {
			const typed = args as DownloadArgs;
			const action = String(typed.action ?? "");
			const target = typed.url
				? Array.isArray(typed.url)
					? typed.url.map(displayUrl).join(", ")
					: displayUrl(typed.url)
				: typed.handle
					? Array.isArray(typed.handle)
						? formatHandles(typed.handle)
						: typed.handle
					: typed.filter && action === "list"
						? String(typed.filter)
						: "";
			const color =
				action === "rm" || action === "purge"
					? "error"
					: action === "pause"
						? "warning"
						: action === "add" || action === "resume"
							? "success"
							: "accent";
			return new Text(
				`${theme.fg("accent", "download")} ${theme.fg(color, action)}${target ? ` ${theme.fg("muted", target)}` : ""}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as DownloadDetails | undefined;
			const fallback = result.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n");
			if (!details) return new Text(fallback, 0, 0);
			if (options.isPartial) return new Text(theme.fg("dim", details.text), 0, 0);
			if (!details.ok) return new Text(theme.fg("error", details.text), 0, 0);
			if (!options.expanded) {
				return new Text(`${theme.fg("success", "✓")} ${theme.fg("toolOutput", oneLine(details.summary))}`, 0, 0);
			}
			return new Text(details.text, 0, 0);
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const mgr = getManager(ctx);
			const action = params.action;
			try {
				switch (action) {
					case "add": {
						const jobs = await mgr.add({
							urls: params.url ?? [],
							dir: params.dir,
							out: params.out,
							connections: params.connections,
							maxSpeed: params.maxSpeed ?? undefined,
							paused: params.paused,
						});
						const ok = jobs.some((job) => job.state !== "error");
						const snapshot = mgr.snapshot();
						const text = renderAdd(jobs, jobs[0]?.options.dir ?? mgr.config.defaultDir);
						return toolResult(detailsFor("add", ok, text, snapshot, jobs));
					}

					case "list": {
						await mgr.ensureDaemon().catch(() => {});
						const snapshot = await mgr.refresh(true);
						const filter = (params.filter ?? "all") as JobFilter;
						let text = renderList(snapshot, filter);
						if (snapshot.daemon === "error" && snapshot.lastError) {
							text = `⚠ ${snapshot.lastError}\n\n${text}`;
						}
						return toolResult(detailsFor("list", true, text, snapshot, filterJobs(snapshot.jobs, filter)));
					}

					case "info": {
						const handle = firstHandle(params.handle);
						if (!handle) throw new UserError("info requires a handle");
						await mgr.refresh(true).catch(() => {});
						const job = await mgr.info(handle);
						const snapshot = mgr.snapshot();
						return toolResult(detailsFor("info", true, renderInfo(job, snapshot), snapshot, [job]));
					}

					case "pause":
					case "resume":
					case "rm":
					case "retry": {
						const handles = normalizeHandles(params.handle);
						const result =
							action === "pause"
								? await mgr.pause(handles)
								: action === "resume"
									? await mgr.resume(handles)
									: action === "rm"
										? await mgr.remove(handles)
										: await mgr.retry(handles);
						const snapshot = mgr.snapshot();
						const text = renderAction(action, result.jobs, result.error);
						return toolResult(detailsFor(action, result.ok, text, snapshot, result.jobs, { error: result.error }));
					}

					case "purge": {
						const result = await mgr.purge();
						const snapshot = mgr.snapshot();
						const text = renderAction("purge", result.jobs, "Cleared finished and failed entries; downloaded files were kept.");
						return toolResult(detailsFor("purge", true, text, snapshot, result.jobs));
					}

					case "stats": {
						await mgr.ensureDaemon().catch(() => {});
						const snapshot = await mgr.refresh(true).catch(() => mgr.snapshot());
						return toolResult(detailsFor("stats", true, renderStats(snapshot, mgr.config), snapshot, snapshot.jobs));
					}

					case "wait": {
						const handles = normalizeHandles(params.handle);
						const timeout = clampTimeout(params.timeoutSec, 300);
						const outcome = await mgr.wait(handles, timeout, signal, (jobs, elapsedMs) => {
							const snapshot = mgr.snapshot();
							onUpdate?.(
								toolResult(
									detailsFor("wait", true, renderWaitProgress(jobs, elapsedMs), snapshot, jobs, {
										summary: `waiting · ${jobs.length} download${jobs.length === 1 ? "" : "s"}`,
									}),
								),
							);
						});
						const snapshot = mgr.snapshot();
						const failed = outcome.jobs.filter((job) => job.state === "error").length;
						const ok = failed === 0;
						const summary = outcome.pausedOnly
							? "nothing to wait for (paused)"
							: outcome.aborted
								? "wait cancelled"
								: outcome.timedOut
									? `wait timed out · ${outcome.jobs.length} still running`
								: `${outcome.jobs.filter((job) => job.state === "complete").length}/${outcome.jobs.length} finished`;
						return toolResult(
							detailsFor("wait", ok, renderWait(outcome, timeout), snapshot, outcome.jobs, {
								timedOut: outcome.timedOut,
								summary,
							}),
						);
					}

					default:
						return toolResult(failureDetails(action, `unknown action "${action}"`, mgr.snapshot()));
				}
			} catch (error) {
				return toolResult(failureDetails(action, errorMessage(error), mgr.snapshot()));
			}
		},
	});

	pi.registerCommand("downloads", {
		description: "Open the interactive downloads dashboard",
		handler: async (_args, ctx) => {
			const mgr = getManager(ctx);
			try {
				await openDownloadsDashboard(mgr, ctx);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.registerCommand("download", {
		description: "Add a download: /download <url> [dir]",
		handler: async (args, ctx) => {
			const mgr = getManager(ctx);
			const trimmed = args.trim();
			const parts = trimmed.split(/\s+/).filter(Boolean);
			let url = parts[0];
			let dir = parts.length > 1 ? parts.slice(1).join(" ") : undefined;
			if (!url) {
				const entered = await ctx.ui.input("Download URL", "https://…");
				if (!entered) return;
				url = entered.trim();
				dir = undefined;
			}
			try {
				parseUrls(url);
				const jobs = await mgr.add({ urls: url, dir });
				const failed = jobs.filter((job) => job.state === "error");
				if (failed.length > 0) {
					ctx.ui.notify(`✗ ${failed[0]!.errorMessage ?? "download failed"}`, "error");
				} else {
					ctx.ui.notify(`↓ ${jobs.length} download${jobs.length === 1 ? "" : "s"} started`, "info");
				}
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.registerShortcut(Key.ctrlShift("o"), {
		description: "Open the downloads dashboard",
		handler: async (ctx) => {
			const mgr = getManager(ctx);
			try {
				await openDownloadsDashboard(mgr, ctx);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (manager) {
			await manager.shutdown().catch(() => {});
			manager = undefined;
		}
		const mgr = getManager(ctx);
		await mgr.load();
	});

	pi.on("session_shutdown", async () => {
		const mgr = manager;
		manager = undefined;
		if (mgr) await mgr.shutdown().catch(() => {});
	});
}
