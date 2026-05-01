/**
 * Config loading + layered resolution for idle-watch.
 *
 *   defaults  →  file config (pi-extensions.json: "idle-watch")  →  session overrides
 *
 * Session overrides live in memory; /idle subcommands mutate them.
 * Pi restart wipes overrides by design.
 */

import { readPiYuConfigFile } from "../lib/config.ts";
import type {
	Backoff,
	DetectionConfig,
	HeartbeatConfig,
	IdleWatchConfig,
	SessionOverrides,
	StateConfig,
} from "./types.ts";

// ─── defaults ────────────────────────────────────────────────────────────

export const DEFAULT_TICK_SECONDS = 30;
export const DEFAULT_WORKING_THRESHOLD = "10m";
export const DEFAULT_IDLE_THRESHOLD = "15m";
export const DEFAULT_BACKOFF: string[] = ["5m", "15m", "30m"];
export const DEFAULT_HEARTBEAT_PATH = "~/.pi/state/idle-{pid}.json";

export const DEFAULT_CONFIG: IdleWatchConfig = {
	enabled: true,
	tickSeconds: DEFAULT_TICK_SECONDS,
	detection: {
		events: false,
		workingIndicator: true,
	},
	states: {
		working: { enabled: true, threshold: DEFAULT_WORKING_THRESHOLD, backoff: false },
		idle: { enabled: true, threshold: DEFAULT_IDLE_THRESHOLD, backoff: false },
	},
	heartbeat: {
		enabled: true,
		path: DEFAULT_HEARTBEAT_PATH,
	},
};

// ─── duration parsing ────────────────────────────────────────────────────

/**
 * Parse "10m", "30s", "1h" → ms.
 * Throws on invalid input; callers should catch and show the message.
 */
export function parseDuration(input: string): number {
	if (typeof input !== "string") {
		throw new Error(`duration must be a string, got ${typeof input}`);
	}
	const s = input.trim();
	if (!s) throw new Error("duration is empty");
	const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/i);
	if (!m) throw new Error(`invalid duration '${input}' (use e.g. "30s", "10m", "1h")`);
	const n = parseFloat(m[1]!);
	const unit = m[2]!.toLowerCase();
	const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
	return Math.round(n * mult);
}

/** Human-friendly duration formatter. */
export function fmtDuration(ms: number): string {
	if (!isFinite(ms) || ms < 0) return "?";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const remS = s % 60;
	if (m < 60) return remS === 0 ? `${m}m` : `${m}m${remS}s`;
	const h = Math.floor(m / 60);
	const remM = m % 60;
	return remM === 0 ? `${h}h` : `${h}h${remM}m`;
}

// ─── file config load ────────────────────────────────────────────────────

type FileBlock = Partial<IdleWatchConfig> & { states?: Partial<IdleWatchConfig["states"]> };

/**
 * Read the "idle-watch" block from pi-extensions.json and merge it over defaults.
 * On any read/parse error, returns DEFAULT_CONFIG.
 */
export async function loadFileConfig(cwd: string): Promise<IdleWatchConfig> {
	try {
		const { content } = await readPiYuConfigFile(cwd);
		if (!content) return cloneDefaults();
		const parsed = JSON.parse(content) as { "idle-watch"?: FileBlock };
		const raw = parsed?.["idle-watch"];
		if (!raw || typeof raw !== "object") return cloneDefaults();
		return mergeIntoDefaults(raw);
	} catch {
		return cloneDefaults();
	}
}

function cloneDefaults(): IdleWatchConfig {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function mergeIntoDefaults(file: FileBlock): IdleWatchConfig {
	const base = cloneDefaults();

	if (typeof file.enabled === "boolean") base.enabled = file.enabled;
	if (typeof file.tickSeconds === "number" && file.tickSeconds > 0) {
		base.tickSeconds = file.tickSeconds;
	}

	if (file.detection && typeof file.detection === "object") {
		base.detection = mergeDetection(base.detection, file.detection);
	}
	if (file.states && typeof file.states === "object") {
		if (file.states.working) {
			base.states.working = mergeState(base.states.working, file.states.working);
		}
		if (file.states.idle) {
			base.states.idle = mergeState(base.states.idle, file.states.idle);
		}
	}
	if (file.heartbeat && typeof file.heartbeat === "object") {
		base.heartbeat = mergeHeartbeat(base.heartbeat, file.heartbeat);
	}

	return base;
}

function mergeDetection(base: DetectionConfig, over: Partial<DetectionConfig>): DetectionConfig {
	return {
		events: typeof over.events === "boolean" ? over.events : base.events,
		workingIndicator:
			typeof over.workingIndicator === "boolean" ? over.workingIndicator : base.workingIndicator,
	};
}

function mergeState(base: StateConfig, over: Partial<StateConfig>): StateConfig {
	return {
		enabled: typeof over.enabled === "boolean" ? over.enabled : base.enabled,
		threshold: typeof over.threshold === "string" && over.threshold ? over.threshold : base.threshold,
		backoff: isValidBackoff(over.backoff) ? (over.backoff as Backoff) : base.backoff,
		title: typeof over.title === "string" ? over.title : base.title,
		body: typeof over.body === "string" ? over.body : base.body,
	};
}

function mergeHeartbeat(base: HeartbeatConfig, over: Partial<HeartbeatConfig>): HeartbeatConfig {
	return {
		enabled: typeof over.enabled === "boolean" ? over.enabled : base.enabled,
		path: typeof over.path === "string" && over.path ? over.path : base.path,
	};
}

function isValidBackoff(v: unknown): boolean {
	if (typeof v === "boolean") return true;
	if (Array.isArray(v) && v.every((x) => typeof x === "string")) return true;
	return false;
}

// ─── session overrides ───────────────────────────────────────────────────

let sessionOverrides: SessionOverrides = {};

export function getOverrides(): SessionOverrides {
	return sessionOverrides;
}

export function updateOverrides(mut: (o: SessionOverrides) => void): void {
	mut(sessionOverrides);
}

export function clearOverrides(): void {
	sessionOverrides = {};
}

/** Layer session overrides on top of the supplied file config. */
export function effectiveConfig(fileCfg: IdleWatchConfig): IdleWatchConfig {
	const o = sessionOverrides;
	const out: IdleWatchConfig = {
		enabled: o.enabled ?? fileCfg.enabled,
		tickSeconds: o.tickSeconds ?? fileCfg.tickSeconds,
		detection: {
			events: o.detection?.events ?? fileCfg.detection.events,
			workingIndicator: o.detection?.workingIndicator ?? fileCfg.detection.workingIndicator,
		},
		states: {
			working: applyStateOverride(fileCfg.states.working, o.states?.working),
			idle: applyStateOverride(fileCfg.states.idle, o.states?.idle),
		},
		heartbeat: {
			enabled: o.heartbeat?.enabled ?? fileCfg.heartbeat.enabled,
			path: o.heartbeat?.path ?? fileCfg.heartbeat.path,
		},
	};
	return out;
}

function applyStateOverride(base: StateConfig, over?: Partial<StateConfig>): StateConfig {
	if (!over) return base;
	return {
		enabled: over.enabled ?? base.enabled,
		threshold: over.threshold ?? base.threshold,
		backoff: over.backoff ?? base.backoff,
		title: over.title ?? base.title,
		body: over.body ?? base.body,
	};
}
