/** Configuration: defaults, `config.json`, and environment overrides. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMaxSpeed } from "./validate.ts";
import type { Aria2Config } from "./types.ts";

export interface ConfigFile {
	defaultDir?: string;
	split?: number;
	maxConcurrent?: number;
	maxSpeed?: string | number;
	notifyOnComplete?: boolean;
	persist?: boolean;
	stopWithPi?: boolean;
	allowedRoot?: string;
	pollIntervalMs?: number;
	enableDht?: boolean;
}

export function configPath(agentDir: string): string {
	return join(agentDir, "pi-aria2", "config.json");
}

function bool(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function readConfigFile(agentDir: string): ConfigFile {
	try {
		const raw = readFileSync(configPath(agentDir), "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as ConfigFile;
	} catch {
		return {};
	}
}

export function loadConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): Aria2Config {
	const file = readConfigFile(agentDir);

	const defaultDir = env.PI_ARIA2_DIR?.trim() || file.defaultDir?.trim() || ".";
	const split = integer(env.PI_ARIA2_SPLIT ?? file.split, 8, 1, 16);
	const maxConcurrent = integer(env.PI_ARIA2_MAX_CONCURRENT ?? file.maxConcurrent, 5, 1, 20);
	const pollIntervalMs = integer(env.PI_ARIA2_POLL_MS ?? file.pollIntervalMs, 800, 250, 5000);
	const notifyOnComplete = bool(env.PI_ARIA2_NOTIFY) ?? file.notifyOnComplete ?? true;
	const persist = bool(env.PI_ARIA2_NO_PERSIST) === true ? false : (file.persist ?? true);
	// Historical naming: PI_ARIA2_KEEP_DAEMON=1 means do NOT tie the daemon to Pi's pid.
	const keepDaemon = bool(env.PI_ARIA2_KEEP_DAEMON) ?? false;
	const stopWithPi = keepDaemon ? false : (file.stopWithPi ?? true);
	const enableDht = bool(env.PI_ARIA2_DHT) ?? file.enableDht ?? false;
	const allowedRoot = env.PI_ARIA2_ALLOWED_ROOT?.trim() || file.allowedRoot?.trim() || undefined;

	let maxSpeed: string | undefined;
	try {
		maxSpeed = parseMaxSpeed(env.PI_ARIA2_MAX_SPEED ?? file.maxSpeed);
	} catch {
		maxSpeed = undefined;
	}

	return {
		defaultDir,
		split,
		maxConcurrent,
		maxSpeed,
		notifyOnComplete,
		persist,
		stopWithPi,
		allowedRoot,
		pollIntervalMs,
		enableDht,
	};
}
