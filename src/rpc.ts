/**
 * Minimal aria2 JSON-RPC client over HTTP.
 *
 * No WebSocket dependency: aria2 serves the same API at POST /jsonrpc, which
 * `fetch` can speak directly. Every call is bounded by a timeout and can be
 * aborted with the tool's AbortSignal.
 */

export class Aria2Error extends Error {
	readonly code: number;

	constructor(code: number, message: string) {
		super(message);
		this.name = "Aria2Error";
		this.code = code;
	}
}

export class RpcTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcTransportError";
	}
}

export interface CallOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface Aria2Status {
	gid: string;
	status: string;
	totalLength?: string;
	completedLength?: string;
	downloadSpeed?: string;
	uploadSpeed?: string;
	connections?: string;
	errorCode?: string;
	errorMessage?: string;
	dir?: string;
	files?: Array<{
		index?: string;
		path?: string;
		length?: string;
		completedLength?: string;
		selected?: string;
	}>;
	bittorrent?: {
		info?: { name?: string };
	};
	infoHash?: string;
	numSeeders?: string;
	seeder?: string;
}

export interface RawGlobalStat {
	downloadSpeed?: string;
	uploadSpeed?: string;
	numActive?: string;
	numWaiting?: string;
	numStopped?: string;
	numStoppedTotal?: string;
}

/** Status fields we ask aria2 for. Fewer fields mean smaller RPC responses. */
export const STATUS_KEYS = [
	"gid",
	"status",
	"totalLength",
	"completedLength",
	"downloadSpeed",
	"uploadSpeed",
	"connections",
	"errorCode",
	"errorMessage",
	"dir",
	"files",
	"bittorrent",
	"numSeeders",
	"seeder",
] as const;

export type MulticallResult =
	| { ok: true; value: unknown }
	| { ok: false; error: Aria2Error };

interface JsonRpcError {
	code?: number;
	message?: string;
}

interface JsonRpcResponse {
	id?: string | number | null;
	jsonrpc?: string;
	result?: unknown;
	error?: JsonRpcError;
}

export interface Aria2ClientOptions {
	endpoint: string;
	secret: string;
	/** Default per-call timeout in ms. */
	timeoutMs?: number;
}

export class Aria2Client {
	readonly endpoint: string;
	private readonly secret: string;
	private readonly timeoutMs: number;
	private nextId = 1;

	constructor(options: Aria2ClientOptions) {
		// Defence in depth: this client may only ever talk to the private daemon
		// we spawn. Refuse anything that is not loopback HTTP on a concrete port.
		let parsed: URL;
		try {
			parsed = new URL(options.endpoint);
		} catch {
			throw new RpcTransportError("aria2 endpoint is not a valid URL");
		}
		const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "localhost";
		if (parsed.protocol !== "http:" || !loopback || !parsed.port || parsed.pathname !== "/jsonrpc") {
			throw new RpcTransportError("refusing a non-loopback aria2 endpoint");
		}
		this.endpoint = parsed.toString();
		this.secret = options.secret;
		this.timeoutMs = options.timeoutMs ?? 8000;
	}

	private async post(payload: unknown, options: CallOptions): Promise<JsonRpcResponse> {
		if (options.signal?.aborted) throw new RpcTransportError("aria2 RPC aborted");
		const timeoutMs = options.timeoutMs ?? this.timeoutMs;
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		const onAbort = () => controller.abort();
		options.signal?.addEventListener("abort", onAbort, { once: true });

		try {
			const response = await fetch(`${this.endpoint}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new RpcTransportError(`aria2 RPC returned HTTP ${response.status}`);
			}
			const text = await response.text();
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				throw new RpcTransportError("aria2 RPC returned invalid JSON");
			}
			if (!parsed || typeof parsed !== "object") {
				throw new RpcTransportError("aria2 RPC returned an unexpected payload");
			}
			return parsed as JsonRpcResponse;
		} catch (error) {
			if (error instanceof RpcTransportError) throw error;
			if (timedOut) throw new RpcTransportError(`aria2 RPC timed out after ${timeoutMs}ms`);
			if (options.signal?.aborted) throw new RpcTransportError("aria2 RPC aborted");
			const detail = error instanceof Error ? error.message : String(error);
			throw new RpcTransportError(`aria2 RPC failed: ${detail}`);
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	async call<T>(method: string, params: unknown[] = [], options: CallOptions = {}): Promise<T> {
		const fullParams = method.startsWith("system.") ? params : [`token:${this.secret}`, ...params];
		const response = await this.post(
			{ jsonrpc: "2.0", id: String(this.nextId++), method, params: fullParams },
			options,
		);
		if (response.error) {
			throw new Aria2Error(Number(response.error.code ?? 1), String(response.error.message ?? "aria2 RPC error"));
		}
		return response.result as T;
	}

	/**
	 * Run several calls in one HTTP round trip. aria2 uses the XML-RPC struct
	 * form (`[{methodName, params}]`), not tuples.
	 */
	async multicall(calls: Array<[string, unknown[]]>, options: CallOptions = {}): Promise<MulticallResult[]> {
		const payload = calls.map(([methodName, params]) => ({
			methodName,
			params: methodName.startsWith("system.") ? params : [`token:${this.secret}`, ...params],
		}));
		const raw = await this.call<unknown[]>("system.multicall", [payload], options);
		if (!Array.isArray(raw)) throw new RpcTransportError("aria2 multicall returned an unexpected payload");
		return raw.map((entry): MulticallResult => {
			if (Array.isArray(entry)) return { ok: true, value: entry[0] };
			if (entry && typeof entry === "object") {
				const record = entry as { code?: unknown; message?: unknown };
				if (typeof record.code === "number") {
					return {
						ok: false,
						error: new Aria2Error(record.code, String(record.message ?? "aria2 error")),
					};
				}
			}
			return { ok: true, value: entry };
		});
	}

	version(options: CallOptions = {}): Promise<{ version: string; enabledFeatures: string[] }> {
		return this.call("aria2.getVersion", [], options);
	}

	addUri(uris: string[], options: Record<string, string> = {}, call: CallOptions = {}): Promise<string> {
		return this.call("aria2.addUri", [uris, options], call);
	}

	tellStatus(gid: string, keys: readonly string[], call: CallOptions = {}): Promise<Aria2Status> {
		return this.call("aria2.tellStatus", [gid, keys], call);
	}

	tellActive(keys: readonly string[], call: CallOptions = {}): Promise<Aria2Status[]> {
		return this.call("aria2.tellActive", [keys], call);
	}

	tellWaiting(offset: number, num: number, keys: readonly string[], call: CallOptions = {}): Promise<Aria2Status[]> {
		return this.call("aria2.tellWaiting", [offset, num, keys], call);
	}

	tellStopped(offset: number, num: number, keys: readonly string[], call: CallOptions = {}): Promise<Aria2Status[]> {
		return this.call("aria2.tellStopped", [offset, num, keys], call);
	}

	pause(gid: string, call: CallOptions = {}): Promise<string> {
		return this.call("aria2.pause", [gid], call);
	}

	unpause(gid: string, call: CallOptions = {}): Promise<string> {
		return this.call("aria2.unpause", [gid], call);
	}

	remove(gid: string, call: CallOptions = {}): Promise<string> {
		return this.call("aria2.remove", [gid], call);
	}

	removeDownloadResult(gid: string, call: CallOptions = {}): Promise<string> {
		return this.call("aria2.removeDownloadResult", [gid], call);
	}

	purgeDownloadResult(call: CallOptions = {}): Promise<string> {
		return this.call("aria2.purgeDownloadResult", [], call);
	}

	getGlobalStat(call: CallOptions = {}): Promise<RawGlobalStat> {
		return this.call("aria2.getGlobalStat", [], call);
	}

	changeGlobalOption(options: Record<string, string>, call: CallOptions = {}): Promise<string> {
		return this.call("aria2.changeGlobalOption", [options], call);
	}

	shutdown(call: CallOptions = {}): Promise<string> {
		return this.call("aria2.shutdown", [], call);
	}
}
