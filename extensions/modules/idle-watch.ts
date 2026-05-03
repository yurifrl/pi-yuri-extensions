/**
 * idle-watch — one-shot notifications when pi sits in the same state too long.
 *
 * Two rules:
 *   1. User idle (no input) for more than `idle` duration → fire once.
 *   2. Pi working (churning on a turn) for more than `working` duration → fire once.
 *
 * Also: no fires during `graceSeconds` after session_start, so a fresh pi
 * doesn't blast you with a "working" notification within 30 seconds of boot.
 *
 * Everything dies with the process. No disk writes, no external watchers,
 * no event plumbing — `ctx.isIdle()` every tick is the ground truth.
 *
 * ── Config (`"idle-watch"` block in pi-extensions.json) ───────────────────
 *   enabled        boolean   default false (registry toggle is source of truth)
 *   tickSeconds    number    default 30
 *   graceSeconds   number    default 300 — suppress fires for N seconds after
 *                            session_start; elapsed time still tracked
 *   working        string    default "10m" — threshold for working alerts
 *   idle           string    default "15m" — threshold for idle alerts
 *   templates      object    per-state title/subtitle/body template overrides
 *
 * Template tokens:
 *   {state}     "working" | "idle"
 *   {emoji}     "⏳" | "💤"
 *   {elapsed}   human duration, e.g. "12m30s"
 *   {threshold} the configured threshold string, e.g. "10m"
 *   {name}      cmux/zellij tab/session name (from env)
 *   {summary}   pi.getSessionName() — the "◇ …" session summary
 *   {cwd}       short cwd, last 2 path segments
 *   {cwdFull}   full absolute cwd
 *   {pid}       process.pid
 *
 * Commands:
 *   /idle           status + effective config
 *   /idle on | off  enable/disable for this session (wiped on restart)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { push as cmuxPush, dismiss as cmuxDismiss, dismissSync as cmuxDismissSync } from "./lib/cmuxNotify.ts";
import { readPiYuConfigFile } from "./lib/config.ts";

// ─── types ───────────────────────────────────────────────────────────────

type PiState = "working" | "idle";

interface Template {
	title: string;
	subtitle: string;
	body: string;
}

interface Config {
	enabled: boolean;
	tickSeconds: number;
	graceSeconds: number;
	/**
	 * Schedule for each state. First element is the initial threshold (how
	 * long to wait after entering the state before the first fire). Subsequent
	 * elements are gaps BETWEEN successive fires. Schedule of length N → N
	 * total fires per state span.
	 *
	 *   ["1m"]              → one fire at 1m
	 *   ["1m", "2m", "5m"]  → fires at 1m, 3m, 8m (3 total)
	 *
	 * A string is accepted for backwards compat and normalized to [string].
	 */
	working: string[];
	idle: string[];
	templates: { working: Template; idle: Template };
}

// ─── defaults ────────────────────────────────────────────────────────────

const DEFAULT_TEMPLATES: { working: Template; idle: Template } = {
	working: {
		title: "{emoji} {name}",
		subtitle: "working for [{elapsed}]",
		body: "{summary}",
	},
	idle: {
		title: "{emoji} {name}",
		subtitle: "idle for [{elapsed}]",
		body: "{summary}",
	},
};

const DEFAULTS: Config = {
	enabled: true,
	tickSeconds: 30,
	graceSeconds: 300,
	working: ["10m"],
	idle: ["15m"],
	templates: DEFAULT_TEMPLATES,
};

const EMOJI: Record<PiState, string> = { working: "⏳", idle: "💤" };

// ─── duration parsing ────────────────────────────────────────────────────

function parseDuration(s: string): number {
	const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/i);
	if (!m) throw new Error(`invalid duration '${s}' (use "30s", "10m", "1h")`);
	const n = parseFloat(m[1]!);
	const u = m[2]!.toLowerCase();
	return Math.round(n * (u === "ms" ? 1 : u === "s" ? 1000 : u === "m" ? 60_000 : 3_600_000));
}

function fmtDuration(ms: number): string {
	if (!isFinite(ms) || ms < 0) return "?";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const r = s % 60;
	if (m < 60) return r ? `${m}m${r}s` : `${m}m`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return rm ? `${h}h${rm}m` : `${h}h`;
}

// ─── config load ─────────────────────────────────────────────────────────

async function loadConfig(cwd: string): Promise<Config> {
	try {
		const { content } = await readPiYuConfigFile(cwd);
		if (!content) return DEFAULTS;
		const raw = (JSON.parse(content) as { "idle-watch"?: Partial<Config> })["idle-watch"];
		if (!raw || typeof raw !== "object") return DEFAULTS;
		return mergeConfig(raw);
	} catch {
		return DEFAULTS;
	}
}

function pickSchedule(v: unknown, fallback: string[]): string[] {
	if (typeof v === "string" && v.trim()) {
		try {
			parseDuration(v);
			return [v];
		} catch {
			return fallback;
		}
	}
	if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) {
		try {
			for (const d of v) parseDuration(d);
			return v as string[];
		} catch {
			return fallback;
		}
	}
	return fallback;
}

function pickBackoff(v: unknown, fallback: false | true | string[]): false | true | string[] {
	if (typeof v === "boolean") return v;
	if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
		// validate durations; if any fails, fall back
		try {
			for (const d of v) parseDuration(d);
			return v as string[];
		} catch {
			return fallback;
		}
	}
	return fallback;
}

function mergeConfig(raw: Partial<Config>): Config {
	const pickStr = (v: unknown, fallback: string): string =>
		typeof v === "string" && v.trim() ? v : fallback;
	const pickNum = (v: unknown, fallback: number, min = 0): number =>
		typeof v === "number" && isFinite(v) && v >= min ? v : fallback;
	const pickTmpl = (over: Partial<Template> | undefined, base: Template): Template =>
		over
			? {
					title: pickStr(over.title, base.title),
					subtitle: pickStr(over.subtitle, base.subtitle),
					body: pickStr(over.body, base.body),
				}
			: base;

	const working = pickSchedule(raw.working, DEFAULTS.working);
	const idle = pickSchedule(raw.idle, DEFAULTS.idle);

	const t = (raw as { templates?: { working?: Partial<Template>; idle?: Partial<Template> } }).templates ?? {};
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
		tickSeconds: Math.max(1, pickNum(raw.tickSeconds, DEFAULTS.tickSeconds, 1)),
		graceSeconds: pickNum(raw.graceSeconds, DEFAULTS.graceSeconds, 0),
		working,
		idle,
		templates: {
			working: pickTmpl(t.working, DEFAULT_TEMPLATES.working),
			idle: pickTmpl(t.idle, DEFAULT_TEMPLATES.idle),
		},
	};
}

// ─── template rendering ──────────────────────────────────────────────────

function envSessionName(): string {
	return (
		process.env.CMUX_SESSION_NAME?.trim() ||
		process.env.ZELLIJ_SESSION_NAME?.trim() ||
		process.env.CLAUDE_SESSION_NAME?.trim() ||
		""
	);
}

// Cached once at session_start. Empty if cmux not available / resolve failed.
let workspaceTitle = "";

interface CmuxWorkspace {
	id?: string;
	title?: string;
	name?: string;
}

async function resolveWorkspaceTitle(pi: ExtensionAPI): Promise<string> {
	const wsId = process.env.CMUX_WORKSPACE_ID?.trim();
	if (!wsId) return "";
	try {
		const res = (await pi.exec("cmux", ["rpc", "workspace.list", "{}"], { timeout: 3000 })) as {
			stdout?: string;
		};
		if (!res?.stdout) return "";
		const parsed = JSON.parse(res.stdout) as { workspaces?: CmuxWorkspace[] };
		const hit = parsed.workspaces?.find((w) => w.id === wsId);
		return (hit?.title ?? hit?.name ?? "").trim();
	} catch {
		return "";
	}
}

function shortCwd(cwd: string): string {
	const parts = cwd.split("/").filter(Boolean);
	return parts.length > 2 ? parts.slice(-2).join("/") : cwd;
}

function buildVars(pi: ExtensionAPI, state: PiState, elapsedMs: number, threshold: string, cwd: string): Record<string, string> {
	let summary = "";
	try {
		summary = pi.getSessionName?.() ?? "";
	} catch {}
	const ws = workspaceTitle;
	return {
		state,
		emoji: EMOJI[state],
		elapsed: fmtDuration(elapsedMs),
		threshold,
		name: envSessionName() || ws || "pi",
		workspace: ws,
		summary,
		cwd: shortCwd(cwd),
		cwdFull: cwd,
		pid: String(process.pid),
	};
}

function render(tmpl: string, vars: Record<string, string>): string {
	return tmpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

// ─── module-scoped state ────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let config: Config = DEFAULTS;
let sessionEnabled: boolean | null = null; // null = defer to config.enabled; bool = session override
let cwdRef = process.cwd();
let ctxRef: unknown = null;
let piRef: ExtensionAPI | null = null;

let state: PiState = "idle";
let enteredAt = Date.now();
let bootAt = Date.now();
const fired: Record<PiState, number> = { working: 0, idle: 0 };
const lastFiredAt: Record<PiState, number | null> = { working: null, idle: null };
const activeNotif: Record<PiState, string | null> = { working: null, idle: null };

// Session-only suppression overrides (cleared on transition/timeout/restart).
let ackedState: PiState | null = null; // if set and === state, no fires until transition
let pausedUntil: number | null = null; // epoch ms; while now < pausedUntil, no fires

// Live count of in-flight work units: turns + tool executions (subagents are
// tools on the parent session, so their in-flight state is reflected here).
// Working iff workCount > 0  OR  ctx.isIdle() === false.
let workCount = 0;
const inFlightTools = new Set<string>(); // toolCallId
let turnsInFlight = 0;

function bumpWork(delta: number): void {
	workCount = Math.max(0, workCount + delta);
}

let exitRegistered = false;

// ─── core loop ──────────────────────────────────────────────────────────

function effectiveEnabled(): boolean {
	return sessionEnabled === null ? config.enabled : sessionEnabled;
}

function pollIsIdle(): boolean | null {
	try {
		const fn = (ctxRef as { isIdle?: () => boolean } | null)?.isIdle;
		if (typeof fn !== "function") return null;
		return fn.call(ctxRef);
	} catch {
		return null;
	}
}

async function tick(): Promise<void> {
	if (!effectiveEnabled()) return;

	const now = Date.now();
	// Ground truth: any work in flight OR main agent streaming.
	const isIdleFromCtx = pollIsIdle();
	const eventWorking = workCount > 0;
	const streaming = isIdleFromCtx === null ? false : !isIdleFromCtx;
	const working = eventWorking || streaming;
	const next: PiState = working ? "working" : "idle";
	if (next !== state) {
			const prev = state;
			state = next;
			enteredAt = now;
			fired.working = 0;
			fired.idle = 0;
			lastFiredAt.working = null;
			lastFiredAt.idle = null;
			ackedState = null; // transitioning clears ack
			// Dismiss the lingering notification from the outgoing state.
			const toDismiss = activeNotif[prev];
			if (toDismiss) {
				activeNotif[prev] = null;
				await cmuxDismiss(toDismiss).catch(() => {});
			}
		}

	// Grace: track state but don't fire.
	const graceMs = Math.max(0, config.graceSeconds) * 1000;
	if (graceMs > 0 && now - bootAt < graceMs) return;

	// Reset enteredAt once at grace end, so thresholds count from grace-end.
	// Detect the "just crossed" edge with a small trick: enteredAt predates bootAt+grace.
	const graceEndedAt = bootAt + graceMs;
	if (graceMs > 0 && enteredAt < graceEndedAt) {
		enteredAt = graceEndedAt;
	}

	// Unified schedule: schedule[0] = initial threshold, schedule[i>0] = gap before fire i.
	const schedule = state === "working" ? config.working : config.idle;
	if (schedule.length === 0) return;

	let thresholdMs = 0;
	try {
		thresholdMs = parseDuration(schedule[0]!);
	} catch {
		return;
	}

	const elapsed = now - enteredAt;
	if (elapsed < thresholdMs) return;

	// Session-only suppressions.
	if (ackedState === state) return;
	if (pausedUntil !== null) {
		if (now < pausedUntil) return;
		pausedUntil = null; // auto-clear when window ends
	}

	// Fire/backoff decision.
	if (fired[state] >= schedule.length) return; // schedule exhausted

	if (fired[state] > 0) {
		const gapRaw = schedule[fired[state]]!;
		let gapMs = 0;
		try {
			gapMs = parseDuration(gapRaw);
		} catch {
			return;
		}
		const last = lastFiredAt[state] ?? now;
		if (now - last < gapMs) return;
	}

	await fire(state, elapsed, schedule[0]!);
	fired[state] += 1;
	lastFiredAt[state] = Date.now();
}

async function fire(s: PiState, elapsed: number, threshold: string): Promise<void> {
	if (!piRef) return;
	const tmpl = config.templates[s];
	const vars = buildVars(piRef, s, elapsed, threshold, cwdRef);

	const title = render(tmpl.title, vars);
	const subtitle = render(tmpl.subtitle, vars);
	const body = render(tmpl.body, vars) || render("{state} for {elapsed}", vars);

	try {
		const id = await cmuxPush({ title, body }, piRef);
		if (id) activeNotif[s] = id;
	} catch {}
}

function shutdown(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
	for (const s of ["working", "idle"] as const) {
		const id = activeNotif[s];
		if (id) {
			activeNotif[s] = null;
			cmuxDismissSync(id);
		}
	}
}

// ─── /idle status + on/off ──────────────────────────────────────────────

function pauseStatusText(now: number): string {
	if (pausedUntil === null) return "off";
	if (pausedUntil === Number.POSITIVE_INFINITY) return "indefinite (run /idle resume)";
	if (now >= pausedUntil) return "off";
	return `${fmtDuration(pausedUntil - now)} left`;
}

function statusText(): string {
	const now = Date.now();
	const graceMs = Math.max(0, config.graceSeconds) * 1000;
	const graceRemain = Math.max(0, graceMs - (now - bootAt));
	const inGrace = graceRemain > 0;
	const on = effectiveEnabled();

	const schedule = state === "working" ? config.working : config.idle;
	const thresholdStr = schedule[0] ?? "?";
	let thresholdMs = 0;
	try {
		thresholdMs = parseDuration(thresholdStr);
	} catch {}
	const sinceEntered = now - enteredAt;

	let eta: string;
	if (!on) {
		eta = "disabled — /idle on";
	} else if (fired[state] >= schedule.length) {
		eta = `schedule exhausted (${fired[state]}/${schedule.length}), waiting for state change`;
	} else if (fired[state] > 0) {
		const gapStr = schedule[fired[state]]!;
		let gapMs = 0;
		try {
			gapMs = parseDuration(gapStr);
		} catch {}
		const last = lastFiredAt[state] ?? now;
		const remain = Math.max(0, gapMs - (now - last));
		eta = `fire ${fired[state] + 1}/${schedule.length} in ${fmtDuration(remain)} (gap ${gapStr})`;
	} else if (inGrace) {
		eta = `next in ≈${fmtDuration(graceRemain + thresholdMs)} (grace + ${thresholdStr})`;
	} else if (sinceEntered >= thresholdMs) {
		eta = "threshold passed — next tick fires";
	} else {
		eta = `next in ${fmtDuration(thresholdMs - sinceEntered)} / ${thresholdStr}`;
	}

	const name = envSessionName() || "(unnamed)";
	let summary = "";
	try {
		summary = piRef?.getSessionName?.() ?? "";
	} catch {}

	// Single dense block. No blank lines, no trailing content. Each line stands
	// alone so the TUI's toast renderer can't collapse empty rows or let the
	// footer panel stomp on whitespace gaps.
	return [
		`${EMOJI[state]} ${state} ${fmtDuration(sinceEntered)}${inGrace ? ` (grace: ${fmtDuration(graceRemain)} left)` : ""}`,
		`${on ? "●" : "○"} ${eta}`,
		`workspace: ${workspaceTitle || "(unset)"}   name: ${name}`,
		`summary: ${summary || "(none)"}`,
		`schedule: working=[${config.working.join(",")}]  idle=[${config.idle.join(",")}]  tick=${config.tickSeconds}s  grace=${config.graceSeconds}s`,
		`work: turns=${turnsInFlight} tools=${inFlightTools.size} total=${workCount}  ctx.isIdle=${pollIsIdle() === null ? "?" : pollIsIdle() ? "true" : "false"}`,
		`suppression: ack=${ackedState ? `${ackedState} (until transition)` : "off"}  pause=${pauseStatusText(now)}`,
		`commands:`,
		`  /idle                 show this status`,
		`  /idle on | off        enable/disable for this session`,
		`  /idle ack             dismiss current notif, mute until state changes`,
		`  /idle pause           pause until next notification would fire (then auto-resume)`,
		`  /idle pause <dur>     pause for a duration (e.g. 10m)`,
		`  /idle resume          clear any active pause`,
		`  /idle reset           clear fire counters for current state`,
	].join("\n");
}

// ─── entry point ────────────────────────────────────────────────────────

export default function idleWatch(pi: ExtensionAPI): void {
	piRef = pi;

	if (!exitRegistered) {
		exitRegistered = true;
		process.on("exit", shutdown);
	}

	pi.on("session_start", async (_event, ctx) => {
		cwdRef = typeof ctx.cwd === "function" ? (ctx.cwd as () => string)() : (ctx.cwd as unknown as string);
		ctxRef = ctx;
		bootAt = Date.now();
		enteredAt = bootAt;
		fired.working = 0;
		fired.idle = 0;
		lastFiredAt.working = null;
		lastFiredAt.idle = null;

		// Reset work counters from a clean slate every session_start.
		workCount = 0;
		turnsInFlight = 0;
		inFlightTools.clear();

		config = await loadConfig(cwdRef);

		// Resolve cmux workspace title once per session for use in notification templates.
		workspaceTitle = await resolveWorkspaceTitle(pi);

		// Seed initial state from ctx.isIdle() so the first tick is accurate.
		const observed = pollIsIdle();
		if (observed !== null) state = observed ? "idle" : "working";

		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			void tick().catch(() => {});
		}, Math.max(1, config.tickSeconds) * 1000);
		try {
			(timer as { unref?: () => void }).unref?.();
		} catch {}
	});

	// Turn-level: main agent LLM streaming. Multiple turns per prompt are possible.
	pi.on("turn_start", () => {
		turnsInFlight++;
		bumpWork(1);
	});
	pi.on("turn_end", () => {
		if (turnsInFlight > 0) {
			turnsInFlight--;
			bumpWork(-1);
		}
	});

	// Tool execution: catches built-in tools AND subagents (subagents are tools).
	pi.on("tool_execution_start", (event) => {
		const id = event?.toolCallId;
		if (!id || inFlightTools.has(id)) return;
		inFlightTools.add(id);
		bumpWork(1);
	});
	pi.on("tool_execution_end", (event) => {
		const id = event?.toolCallId;
		if (!id || !inFlightTools.has(id)) return;
		inFlightTools.delete(id);
		bumpWork(-1);
	});

	// Safety net: when the whole prompt-level run ends, counts should reach 0.
	// If they don't (missed events, errors), force-reset to prevent stuck "working".
	pi.on("agent_end", () => {
		if (turnsInFlight !== 0 || inFlightTools.size !== 0) {
			turnsInFlight = 0;
			inFlightTools.clear();
			workCount = 0;
		}
	});

	pi.on("session_shutdown", async () => {
		shutdown();
	});

	pi.registerCommand?.("idle", {
		description: "idle-watch: /idle [on|off|ack|pause [dur]|resume|reset]",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const parts = raw.split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "").toLowerCase();

			// bare /idle → status
			if (!sub) {
				const text = statusText();
				// eslint-disable-next-line no-console
				console.log(text);
				try {
					ctx?.ui?.notify?.(text, "info");
				} catch {}
				return;
			}

			const notify = (msg: string, kind: "success" | "info" | "error" = "success") => {
				try {
					ctx?.ui?.notify?.(msg, kind);
				} catch {}
			};

			switch (sub) {
				case "on":
				case "off":
					sessionEnabled = sub === "on";
					notify(`idle-watch ${sub}`);
					return;

				case "ack": {
					ackedState = state;
					const id = activeNotif[state];
					if (id) {
						activeNotif[state] = null;
						await cmuxDismiss(id, piRef ?? undefined).catch(() => {});
					}
					notify(`idle-watch: acked ${state} — muted until state changes`);
					return;
				}

				case "pause": {
					const dur = parts[1];
					if (!dur) {
						// indefinite pause — until /idle resume or state change of user's choosing
						pausedUntil = Number.POSITIVE_INFINITY;
						const id = activeNotif[state];
						if (id) {
							activeNotif[state] = null;
							await cmuxDismiss(id, piRef ?? undefined).catch(() => {});
						}
						notify("idle-watch: paused indefinitely — /idle resume to clear");
						return;
					}
					let ms = 0;
					try {
						ms = parseDuration(dur);
					} catch (err) {
						notify(`idle-watch: ${(err as Error).message}`, "error");
						return;
					}
					pausedUntil = Date.now() + ms;
					const id = activeNotif[state];
					if (id) {
						activeNotif[state] = null;
						await cmuxDismiss(id, piRef ?? undefined).catch(() => {});
					}
					notify(`idle-watch: paused for ${fmtDuration(ms)}`);
					return;
				}

				case "resume":
				case "unpause": {
					pausedUntil = null;
					notify("idle-watch: pause cleared");
					return;
				}

				case "reset": {
					fired.working = 0;
					fired.idle = 0;
					lastFiredAt.working = null;
					lastFiredAt.idle = null;
					notify("idle-watch: counters reset");
					return;
				}

				case "status": {
					const text = statusText();
					// eslint-disable-next-line no-console
					console.log(text);
					notify(text, "info");
					return;
				}

				default:
					notify(`idle-watch: unknown subcommand '${sub}'. Try /idle for help.`, "error");
			}
		},
	});
}
