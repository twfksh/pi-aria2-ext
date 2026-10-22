/** Input validation and path safety. */

import { constants } from "node:fs";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";

/** A user-facing input problem. The message is safe to show to the model. */
export class UserError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UserError";
	}
}

export const MAX_URLS_PER_ADD = 20;
export const MAX_URL_LENGTH = 8192;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "ftp:", "sftp:", "magnet:"]);

function hasControlChars(value: string): boolean {
	// Anything below space, plus DEL, breaks aria2's config file format or a line-oriented log.
	return /[\u0000-\u001f\u007f]/.test(value);
}

/** Reject whitespace and control characters before handing a URL to aria2. */
export function validateUrl(raw: unknown): string {
	if (typeof raw !== "string") throw new UserError("each url must be a string");
	const url = raw.trim();
	if (!url) throw new UserError("url must not be empty");
	if (url.length > MAX_URL_LENGTH) throw new UserError(`url is longer than ${MAX_URL_LENGTH} characters`);
	if (/\s/.test(url)) throw new UserError("url must not contain whitespace");
	if (hasControlChars(url)) throw new UserError("url contains control characters");

	let protocol: string;
	try {
		protocol = new URL(url).protocol;
	} catch {
		throw new UserError(`not a valid URL: ${url.slice(0, 80)}`);
	}
	if (!ALLOWED_PROTOCOLS.has(protocol)) {
		throw new UserError(
			`unsupported URL scheme "${protocol.replace(":", "")}". Use http, https, ftp, sftp, or magnet.`,
		);
	}
	if (protocol === "magnet:" && !/[?&]xt=/.test(url)) {
		throw new UserError("magnet link is missing an xt= parameter");
	}
	return url;
}

export function parseUrls(input: unknown): string[] {
	if (input === undefined || input === null) throw new UserError("url is required for add");
	const list = Array.isArray(input) ? input : [input];
	if (list.length === 0) throw new UserError("url is required for add");
	if (list.length > MAX_URLS_PER_ADD) {
		throw new UserError(`add accepts at most ${MAX_URLS_PER_ADD} urls per call`);
	}
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const item of list) {
		const url = validateUrl(item);
		if (seen.has(url)) continue;
		seen.add(url);
		urls.push(url);
	}
	return urls;
}

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir(), input.slice(2));
	return input;
}

export interface ResolveDirOptions {
	cwd: string;
	allowedRoot?: string;
}

/**
 * Resolve, create, and validate a download directory.
 *
 * Safety properties:
 * - only a real directory is accepted (never a file);
 * - the filesystem root is refused because `rm -rf`-adjacent mistakes there are unrecoverable;
 * - when `allowedRoot` is configured, the resolved real path must stay inside it;
 * - the directory must be writable before aria2 is pointed at it.
 */
export async function resolveDownloadDir(raw: string | undefined, options: ResolveDirOptions): Promise<string> {
	const input = (raw?.trim() || ".").trim();
	if (!input) throw new UserError("dir must not be empty");
	if (hasControlChars(input)) throw new UserError("dir contains control characters");
	if (input.length > 4096) throw new UserError("dir is too long");

	let dir = expandHome(input);
	if (!isAbsolute(dir)) dir = resolve(options.cwd, dir);
	dir = normalize(dir);

	let real: string;
	try {
		await mkdir(dir, { recursive: true, mode: 0o755 });
		real = await realpath(dir);
	} catch (error) {
		throw new UserError(`cannot use directory ${dir}: ${(error as Error).message}`);
	}

	let info;
	try {
		info = await stat(real);
	} catch (error) {
		throw new UserError(`cannot inspect directory ${real}: ${(error as Error).message}`);
	}
	if (!info.isDirectory()) throw new UserError(`not a directory: ${real}`);
	if (real === parse(real).root) {
		throw new UserError("refusing to download into the filesystem root; choose a subdirectory");
	}

	if (options.allowedRoot) {
		let root: string;
		try {
			root = await realpath(resolve(options.cwd, expandHome(options.allowedRoot.trim())));
		} catch {
			throw new UserError(`configured allowedRoot does not exist: ${options.allowedRoot}`);
		}
		const rel = relative(root, real);
		if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
			// inside the root (equal to it is allowed)
		} else {
			throw new UserError(`dir must stay inside ${root}`);
		}
	}

	try {
		await access(real, constants.W_OK);
	} catch {
		throw new UserError(`directory is not writable: ${real}`);
	}
	return real;
}

/**
 * `out` is a single file name, never a path. aria2 accepts relative paths in
 * `out`; refusing separators here keeps a download from escaping `dir`.
 */
export function sanitizeOutName(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const name = raw.trim();
	if (!name) throw new UserError("out must not be empty");
	if (name === "." || name === "..") throw new UserError("out must be a file name");
	if (name.includes("/") || name.includes("\\")) {
		throw new UserError("out must be a plain file name (it cannot contain path separators)");
	}
	if (hasControlChars(name)) throw new UserError("out contains control characters");
	if (name === ".aria2" || name.toLowerCase().endsWith(".aria2")) {
		throw new UserError("out cannot use aria2's .aria2 control-file suffix");
	}
	if (name.length > 255) throw new UserError("out is longer than 255 characters");
	return name;
}

/** aria2 speed strings: `500K`, `5M`, `1.5G`, or a raw byte count. */
export function parseMaxSpeed(raw: string | number | undefined): string | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw === "number") {
		if (!Number.isFinite(raw) || raw <= 0) throw new UserError("maxSpeed must be a positive number of bytes/second");
		return String(Math.floor(raw));
	}
	const value = raw.trim().toUpperCase();
	if (!/^\d+(\.\d+)?[KMG]?$/.test(value) || Number.parseFloat(value) <= 0) {
		throw new UserError('maxSpeed must look like "5M", "500K", or a positive number of bytes/second');
	}
	return value;
}

export function clampConnections(value: number | undefined, fallback: number): number {
	if (value === undefined) return Math.min(16, Math.max(1, Math.floor(fallback)));
	if (!Number.isFinite(value)) throw new UserError("connections must be a number");
	return Math.min(16, Math.max(1, Math.floor(value)));
}

export function clampTimeout(value: number | undefined, fallback = 300): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value)) throw new UserError("timeoutSec must be a number");
	return Math.min(3600, Math.max(1, Math.floor(value)));
}

/** Normalize a handle for case-insensitive lookup. */
export function normalizeHandle(value: string): string {
	return value.trim().toLowerCase();
}

/** True when `child` is inside `root` (or equal to it). */
export function isInside(root: string, child: string): boolean {
	const rel = relative(root, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}
