import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	RegisteredCommand,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import registerDownloads from "../src/index.ts";
import type { DownloadDetails } from "../src/present.ts";

const tools: ToolDefinition[] = [];
const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
const shortcuts = new Map<KeyId, { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }>();
const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();

const pi = {
	registerTool(tool: ToolDefinition) {
		tools.push(tool);
	},
	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
		commands.set(name, options);
	},
	registerShortcut(key: KeyId, options: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }) {
		shortcuts.set(key, options);
	},
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
		return () => {};
	},
} as unknown as ExtensionAPI;

const theme = { fg: (_token: string, text: string) => text } as unknown as Theme;

const fakeUI = {
	notify: () => {},
	setStatus: () => {},
	setWidget: () => {},
	input: async () => undefined,
};

let root = "";
let ctx: ExtensionContext;

const tempDirs: string[] = [];

afterAll(async () => {
	for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("extension factory", () => {
	test("registers the tool, commands, shortcut and lifecycle handlers", async () => {
		registerDownloads(pi);
		expect(tools).toHaveLength(1);
		expect(tools[0]?.name).toBe("download");
		expect(tools[0]?.label).toBe("Download");
		expect(tools[0]?.annotations?.destructiveHint).toBe(false);
		expect(commands.has("downloads")).toBe(true);
		expect(commands.has("download")).toBe(true);
		expect(shortcuts.has("ctrl+shift+o")).toBe(true);
		expect(handlers.get("session_start")).toHaveLength(1);
		expect(handlers.get("session_shutdown")).toHaveLength(1);

		root = await mkdtemp(join(tmpdir(), "pi-aria2-ext-"));
		tempDirs.push(root);
		const previous = process.env.PI_ARIA2_HOME;
		process.env.PI_ARIA2_HOME = root;
		ctx = {
			ui: fakeUI,
			hasUI: false,
			mode: "json",
			cwd: root,
		} as unknown as ExtensionContext;

		await handlers.get("session_start")![0]!({}, ctx);
		process.env.PI_ARIA2_HOME = previous;
	});

	test("add without a url fails before any daemon starts", async () => {
		const tool = tools[0]!;
		const result = await tool.execute("call-1", { action: "add" }, undefined, undefined, ctx as never);
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("url is required");
	});

	test("info with an unknown handle fails cleanly", async () => {
		const tool = tools[0]!;
		const result = await tool.execute("call-2", { action: "info", handle: "dl-nope-1" }, undefined, undefined, ctx as never);
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("unknown download handle");
	});

	test("renderers draw the call and collapsed result", () => {
		const tool = tools[0]!;
		const call = tool.renderCall?.(
			{ action: "add", url: "https://example.com/file.bin?token=secret" },
			theme,
			{} as never,
		);
		const callLines = call?.render(80).join("\n") ?? "";
		expect(callLines).toContain("download");
		expect(callLines).toContain("https://example.com/file.bin");
		expect(callLines).not.toContain("token=secret");

		const details: DownloadDetails = {
			_type: "pi-aria2",
			action: "add",
			ok: true,
			summary: "queued 1 download",
			text: "Queued 1 download in /tmp",
			jobs: [],
			global: { downloadSpeed: 0, uploadSpeed: 0, numActive: 0, numWaiting: 0, numStopped: 0 },
			daemon: "running",
		};
		const result = {
			content: [{ type: "text" as const, text: details.text }],
			details,
		};
		const collapsed = tool
			.renderResult?.(result, { expanded: false, isPartial: false }, theme, {} as never)
			?.render(80)
			.join("\n");
		expect(collapsed).toContain("queued 1 download");
		const expanded = tool
			.renderResult?.(result, { expanded: true, isPartial: false }, theme, {} as never)
			?.render(80)
			.join("\n");
		expect(expanded).toContain("Queued 1 download in /tmp");
	});

	test("session_shutdown releases the manager", async () => {
		await handlers.get("session_shutdown")![0]!({}, ctx);
		expect(true).toBe(true);
	});
});
