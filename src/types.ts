/** Shared types for the pi-aria2 extension. */

export type JobState =
	| "queued"
	| "waiting"
	| "active"
	| "paused"
	| "complete"
	| "error"
	| "removed";

export type DaemonState = "stopped" | "starting" | "running" | "error";

export interface JobOptions {
	dir: string;
	out?: string;
	connections: number;
	maxSpeed?: string;
}

export interface Job {
	handle: string;
	urls: string[];
	options: JobOptions;
	createdAt: number;
	/** aria2 gid for the current daemon. Undefined before the daemon starts. */
	gid?: string;
	state: JobState;
	completedLength: number;
	totalLength: number;
	speed: number;
	connections: number;
	errorCode?: number;
	errorMessage?: string;
	filePath?: string;
	/** Display name cached from the status file path or the URL. */
	name?: string;
	finishedAt?: number;
}

/** The subset of a job that is safe and useful to persist between sessions. */
export interface PersistedJob {
	handle: string;
	urls: string[];
	dir: string;
	out?: string;
	connections: number;
	maxSpeed?: string;
	createdAt: number;
	state: JobState;
	totalLength?: number;
	completedLength?: number;
	filePath?: string;
	name?: string;
	errorCode?: number;
	errorMessage?: string;
}

export interface PersistedState {
	version: 1;
	cwd: string;
	updatedAt: number;
	jobs: PersistedJob[];
}

export interface GlobalStat {
	downloadSpeed: number;
	uploadSpeed: number;
	numActive: number;
	numWaiting: number;
	numStopped: number;
}

export interface Snapshot {
	jobs: Job[];
	global: GlobalStat;
	daemon: DaemonState;
	lastError?: string;
	version?: string;
}

export type SnapshotListener = (snapshot: Snapshot) => void;

export interface Aria2Config {
	/** Directory used when a download does not name one. Relative paths resolve against cwd. */
	defaultDir: string;
	/** aria2 connections per file (1-16). */
	split: number;
	/** Maximum simultaneous downloads. */
	maxConcurrent: number;
	/** Global download cap, e.g. "5M". */
	maxSpeed?: string;
	/** Notify on completion and failure. */
	notifyOnComplete: boolean;
	/** Persist job intent across Pi restarts. */
	persist: boolean;
	/** Use aria2 --stop-with-process so a crashed Pi never leaves an orphan daemon. */
	stopWithPi: boolean;
	/** If set, downloads must resolve inside this directory. */
	allowedRoot?: string;
	/** Poll interval while downloads are active (ms). */
	pollIntervalMs: number;
	/** Enable BitTorrent DHT (off by default: it opens a UDP port). */
	enableDht: boolean;
}

export interface AddInput {
	urls: string | string[];
	dir?: string;
	out?: string;
	connections?: number;
	maxSpeed?: string | number;
	paused?: boolean;
}

export interface WaitOutcome {
	jobs: Job[];
	timedOut: boolean;
	aborted: boolean;
	elapsedMs: number;
	/** Every selected download is paused, so there was nothing that could progress. */
	pausedOnly?: boolean;
}

export interface ActionResult {
	action: string;
	ok: boolean;
	jobs: Job[];
	message?: string;
	error?: string;
}
