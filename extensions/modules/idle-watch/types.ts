/**
 * Shared types for the idle-watch module.
 */

export type PiState = "idle" | "working";

/**
 * Backoff schedule:
 *   false       → one-shot (default). Fire once per state span, then silent.
 *   true        → use DEFAULT_BACKOFF.
 *   string[]    → custom schedule of duration strings, e.g. ["5m", "15m", "30m"].
 *                 Values are gaps BETWEEN successive notifications.
 */
export type Backoff = false | true | string[];

export interface StateConfig {
	enabled: boolean;
	/** Duration string, e.g. "10m", "30s", "1h". */
	threshold: string;
	backoff: Backoff;
	/** Optional template for notification title. Tokens: {state}, {elapsed}, {sessionName}, {cwd}, {pid}. */
	title?: string;
	/** Optional template for notification body. Same tokens as title. */
	body?: string;
}

export interface DetectionConfig {
	/** Listen to agent_start / agent_end events to drive state transitions. */
	events: boolean;
	/** Poll ctx.isIdle() on every tick; reconciles tracker on mismatch. */
	workingIndicator: boolean;
}

export interface HeartbeatConfig {
	enabled: boolean;
	/** Path template; `{pid}` is replaced with process.pid. */
	path: string;
}

export interface IdleWatchConfig {
	enabled: boolean;
	tickSeconds: number;
	detection: DetectionConfig;
	states: {
		working: StateConfig;
		idle: StateConfig;
	};
	heartbeat: HeartbeatConfig;
}

/**
 * In-memory tracker. Single instance per pi session.
 * Reset on every state transition.
 */
export interface Tracker {
	state: PiState;
	enteredStateAt: number;
	firedCount: number;
	lastFiredAt: number | null;
}

/**
 * Session-only overrides built by `/idle` subcommands. Partial shape of
 * IdleWatchConfig — any field present overrides the file config layer.
 * Nested partials for states/detection/heartbeat.
 */
export interface SessionOverrides {
	enabled?: boolean;
	tickSeconds?: number;
	detection?: Partial<DetectionConfig>;
	states?: {
		working?: Partial<StateConfig>;
		idle?: Partial<StateConfig>;
	};
	heartbeat?: Partial<HeartbeatConfig>;
}
