/** Locate an aria2c binary without a shell, or explain how to install one. */

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export class Aria2MissingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "Aria2MissingError";
	}
}

export function aria2InstallHint(platform = process.platform): string {
	switch (platform) {
		case "darwin":
			return "Install it with `brew install aria2` (or `port install aria2`).";
		case "win32":
			return "Install it with `winget install aria2.aria2`, or download aria2c.exe from https://github.com/aria2/aria2/releases and put it on PATH.";
		case "linux":
			return "Install it with your package manager, for example `sudo apt install aria2` or `sudo dnf install aria2`.";
		default:
			return "Install aria2 and make sure `aria2c` is on PATH.";
	}
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		if (!info.isFile()) return false;
		await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Candidate binary paths in priority order. Exported for tests. */
export function aria2Candidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
	const exe = platform === "win32" ? "aria2c.exe" : "aria2c";
	const candidates: string[] = [];
	if (env.PI_ARIA2_BIN?.trim()) candidates.push(env.PI_ARIA2_BIN.trim());
	candidates.push(join(homedir(), ".pi", "agent", "bin", exe));
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (dir) candidates.push(join(dir, exe));
	}
	if (platform === "win32") {
		if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, "aria2", exe));
		if (env.ProgramFiles) candidates.push(join(env.ProgramFiles, "aria2", exe));
	} else {
		candidates.push("/opt/homebrew/bin/aria2c", "/usr/local/bin/aria2c", "/usr/bin/aria2c");
	}
	// Stable de-duplication, preserving priority.
	return [...new Set(candidates)];
}


/**
 * Resolve aria2c from, in order: `PI_ARIA2_BIN`, `~/.pi/agent/bin`, PATH, common
 * install prefixes. Never runs a shell.
 */
export async function resolveAria2Binary(): Promise<string> {
	if (process.env.PI_ARIA2_BIN?.trim()) {
		const configured = process.env.PI_ARIA2_BIN.trim();
		if (await isExecutable(configured)) return configured;
		throw new Aria2MissingError(
			`PI_ARIA2_BIN points to ${configured}, but it is not an executable file.`,
		);
	}
	for (const candidate of aria2Candidates()) {
		if (await isExecutable(candidate)) return candidate;
	}
	throw new Aria2MissingError(`aria2c was not found. ${aria2InstallHint()}`);
}
