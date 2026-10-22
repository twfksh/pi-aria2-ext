import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	clampConnections,
	clampTimeout,
	isInside,
	parseMaxSpeed,
	parseUrls,
	resolveDownloadDir,
	sanitizeOutName,
	UserError,
	validateUrl,
} from "../src/validate.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-aria2-validate-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("validateUrl", () => {
	test("accepts supported schemes", () => {
		expect(validateUrl("https://example.com/a.iso")).toBe("https://example.com/a.iso");
		expect(validateUrl("http://example.com/a")).toContain("http://");
		expect(validateUrl("ftp://example.com/a")).toContain("ftp://");
		expect(validateUrl("sftp://example.com/a")).toContain("sftp://");
		expect(validateUrl("magnet:?xt=urn:btih:abcdef&dn=name")).toContain("magnet:");
	});

	test("rejects other schemes", () => {
		expect(() => validateUrl("file:///etc/passwd")).toThrow(UserError);
		expect(() => validateUrl("javascript:alert(1)")).toThrow(UserError);
		expect(() => validateUrl("data:text/plain,hi")).toThrow(UserError);
	});

	test("rejects whitespace, empty input and malformed magnets", () => {
		expect(() => validateUrl("https://example.com/a b")).toThrow(/whitespace/);
		expect(() => validateUrl("   ")).toThrow(/empty/);
		expect(() => validateUrl("magnet:?dn=name")).toThrow(/xt=/);
		expect(() => validateUrl("not a url at all")).toThrow(UserError);
	});

	test("trims surrounding whitespace", () => {
		expect(validateUrl("  https://example.com/a  ")).toBe("https://example.com/a");
	});
});

describe("parseUrls", () => {
	test("accepts one or many and de-duplicates", () => {
		expect(parseUrls("https://a.test/1")).toEqual(["https://a.test/1"]);
		expect(parseUrls(["https://a.test/1", "https://a.test/1", "https://a.test/2"])).toHaveLength(2);
	});

	test("rejects empty and oversized lists", () => {
		expect(() => parseUrls([])).toThrow(/required/);
		expect(() => parseUrls(undefined)).toThrow(/required/);
		const many = Array.from({ length: 21 }, (_, index) => `https://a.test/${index}`);
		expect(() => parseUrls(many)).toThrow(/at most 20/);
	});
});

describe("sanitizeOutName", () => {
	test("accepts plain names", () => {
		expect(sanitizeOutName(undefined)).toBeUndefined();
		expect(sanitizeOutName("archive.tar.gz")).toBe("archive.tar.gz");
		expect(sanitizeOutName(" spaced name.bin ")).toBe("spaced name.bin");
	});

	test("refuses separators and control files", () => {
		expect(() => sanitizeOutName("../escape")).toThrow(/separators/);
		expect(() => sanitizeOutName("a/b")).toThrow(/separators/);
		expect(() => sanitizeOutName("..\\escape")).toThrow(/separators/);
		expect(() => sanitizeOutName(".")).toThrow(/file name/);
		expect(() => sanitizeOutName("..")).toThrow(/file name/);
		expect(() => sanitizeOutName("x.aria2")).toThrow(/control-file/);
		expect(() => sanitizeOutName("bad\nname")).toThrow(/control/);
	});
});

describe("speeds and limits", () => {
	test("parseMaxSpeed accepts aria2 suffixes", () => {
		expect(parseMaxSpeed(undefined)).toBeUndefined();
		expect(parseMaxSpeed("5M")).toBe("5M");
		expect(parseMaxSpeed("1.5g")).toBe("1.5G");
		expect(parseMaxSpeed(2048)).toBe("2048");
	});

	test("rejects nonsense speeds", () => {
		expect(() => parseMaxSpeed("5MB")).toThrow(UserError);
		expect(() => parseMaxSpeed("fast")).toThrow(UserError);
		expect(() => parseMaxSpeed(0)).toThrow(UserError);
	});

	test("clamps connections and timeouts", () => {
		expect(clampConnections(undefined, 8)).toBe(8);
		expect(clampConnections(0, 8)).toBe(1);
		expect(clampConnections(99, 8)).toBe(16);
		expect(clampTimeout(undefined, 300)).toBe(300);
		expect(clampTimeout(0, 300)).toBe(1);
		expect(clampTimeout(99999, 300)).toBe(3600);
	});
});

describe("resolveDownloadDir", () => {
	test("creates relative directories under cwd", async () => {
		const cwd = await tempDir();
		const resolved = await resolveDownloadDir("downloads/sub", { cwd });
		expect(resolved).toBe(join(cwd, "downloads/sub"));
		expect((await stat(resolved)).isDirectory()).toBe(true);
	});

	test("expands a leading tilde", async () => {
		const cwd = await tempDir();
		const resolved = await resolveDownloadDir("~", { cwd });
		expect(resolved).toBe(await realpath(homedir()));
	});

	test("refuses the filesystem root", async () => {
		const cwd = await tempDir();
		await expect(resolveDownloadDir("/", { cwd })).rejects.toThrow(/filesystem root/);
	});

	test("enforces allowedRoot", async () => {
		const root = await tempDir();
		const outside = await tempDir();
		await expect(resolveDownloadDir(outside, { cwd: root, allowedRoot: root })).rejects.toThrow(
			/inside/,
		);
		const inside = await resolveDownloadDir(join(root, "ok"), { cwd: root, allowedRoot: root });
		expect(inside.startsWith(root)).toBe(true);
	});

	test("isInside understands prefixes", () => {
		expect(isInside("/a/b", "/a/b/c")).toBe(true);
		expect(isInside("/a/b", "/a/b")).toBe(true);
		expect(isInside("/a/b", "/a/bc")).toBe(false);
		expect(isInside("/a/b", "/a")).toBe(false);
	});
});
