import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Aria2Client, Aria2Error, RpcTransportError } from "../src/rpc.ts";

interface Recorded {
	id: string;
	method: string;
	params: unknown[];
}

let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];
let respond: (request: Recorded, res: ServerResponse) => void;

function json(res: ServerResponse, body: unknown, status = 200): void {
	res.statusCode = status;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}

beforeAll(async () => {
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
				id: string;
				method: string;
				params: unknown[];
			};
			const request = { id: body.id, method: body.method, params: body.params };
			recorded.push(request);
			respond(request, res);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	baseUrl = `http://127.0.0.1:${port}/jsonrpc`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(): Aria2Client {
	return new Aria2Client({ endpoint: baseUrl, secret: "s3cret", timeoutMs: 1000 });
}

describe("Aria2Client", () => {
	test("authenticates aria2.* calls with the token", async () => {
		recorded = [];
		respond = (request, res) => json(res, { id: request.id, jsonrpc: "2.0", result: { version: "1.37.0" } });
		const version = await client().version();
		expect(version.version).toBe("1.37.0");
		expect(recorded[0]?.params[0]).toBe("token:s3cret");
	});

	test("does not add a token to system.* calls", async () => {
		recorded = [];
		respond = (request, res) => json(res, { id: request.id, result: ["aria2.getVersion"] });
		await client().call("system.listMethods");
		expect(recorded[0]?.params).toEqual([]);
	});

	test("turns JSON-RPC errors into Aria2Error", async () => {
		respond = (request, res) =>
			json(res, { id: request.id, error: { code: 13, message: "File already exists" } });
		await expect(client().version()).rejects.toBeInstanceOf(Aria2Error);
		try {
			await client().version();
		} catch (error) {
			expect((error as Aria2Error).code).toBe(13);
		}
	});

	test("parses multicall structs into values and errors", async () => {
		recorded = [];
		respond = (request, res) =>
			json(res, {
				id: request.id,
				result: [[{ version: "1.37.0" }], { code: 1, message: "GID not found" }],
			});
		const results = await client().multicall([
			["aria2.getVersion", []],
			["aria2.tellStatus", ["deadbeef"]],
		]);
		expect(results[0]).toEqual({ ok: true, value: { version: "1.37.0" } });
		expect(results[1]).toMatchObject({ ok: false });
		if (results[1] && !results[1].ok) expect(results[1].error.message).toBe("GID not found");

		const payload = recorded[0]!.params[0] as Array<{ methodName: string; params: unknown[] }>;
		expect(payload[0]?.methodName).toBe("aria2.getVersion");
		expect(payload[0]?.params).toEqual(["token:s3cret"]);
	});

	test("reports invalid JSON as a transport error", async () => {
		respond = (_request, res) => {
			res.setHeader("content-type", "application/json");
			res.end("not json");
		};
		await expect(client().version()).rejects.toBeInstanceOf(RpcTransportError);
	});

	test("times out hung calls", async () => {
		respond = () => {
			/* never respond */
		};
		const quick = new Aria2Client({ endpoint: baseUrl, secret: "s3cret", timeoutMs: 60 });
		await expect(quick.version()).rejects.toThrow(/timed out/);
	});

	test("only accepts a loopback /jsonrpc endpoint", () => {
		expect(() => new Aria2Client({ endpoint: "http://example.com:6800/jsonrpc", secret: "x" })).toThrow(
			/non-loopback/,
		);
		expect(() => new Aria2Client({ endpoint: "https://127.0.0.1:6800/jsonrpc", secret: "x" })).toThrow(
			/non-loopback/,
		);
		expect(() => new Aria2Client({ endpoint: "http://127.0.0.1:6800/other", secret: "x" })).toThrow(
			/non-loopback/,
		);
		expect(() => new Aria2Client({ endpoint: "http://localhost:6800/jsonrpc", secret: "x" })).not.toThrow();
	});
});
