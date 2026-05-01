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

/**
 * Detection mode — single-choice string.
 *   - "polling" (default): ctx.isIdle() is ground truth. agent_* events ignored.
 *   - "events":            agent_start / agent_end drive transitions. poll ignored.
 *   - "hybrid":            events drive transitions; poll reconciles only after
 *                          N consecutive ticks of disagreement (hybridDebounceTicks).
 */
export type DetectionMode = "events" | "polling" | "hybrid";

/**
 * Legacy shape — retained only so `translateDetection()` can accept old
 * `pi-extensions.json` blocks and translate them to a DetectionMode string.
 * New configs should use the string form.
 */
export interface LegacyDetectionConfig {
	events?: boolean;
	workingIndicator?: boolean;
}

export interface HeartbeatConfig {
	enabled: boolean;
	/** Path template; `{pid}` is replaced with process.pid. */
	path: string;
	/**
	 * Write the heartbeat file at most every Nth tick when nothing else forces
	 * a write (transition, fire, shutdown, or payload change). Default 4.
	 */
	everyNTicks: number;
}

export interface IdleWatchConfig {
	enabled: boolean;
	tickSeconds: number;
	/**
	 * Seconds after each `session_start` during which notification firing is
	 * suppressed. State tracking continues. 0 disables the grace window.
	 */
	startupGraceSeconds: number;
	/**
	 * When true (default), `enteredStateAt` is reset to the moment the grace
	 * window ends, so thresholds count from grace-end rather than session-start.
	 */
	resetThresholdAfterGrace: boolean;
	detection: DetectionMode;
	/**
	 * Only used when detection mode is "hybrid". Number of consecutive ticks
	 * the poll value must disagree with the event-driven state before the
	 * poll wins. Default 2.
	 */
	hybridDebounceTicks: number;
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
 * Nested partials for states/heartbeat.
 */
export interface SessionOverrides {
	enabled?: boolean;
	tickSeconds?: number;
	startupGraceSeconds?: number;
	resetThresholdAfterGrace?: boolean;
	detection?: DetectionMode;
	hybridDebounceTicks?: number;
	states?: {
		working?: Partial<StateConfig>;
		idle?: Partial<StateConfig>;
	};
	heartbeat?: Partial<HeartbeatConfig>;
}
