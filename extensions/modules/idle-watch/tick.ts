/**
 * Tick loop: runs every `tickSeconds`, reconciles state, writes heartbeat,
 * evaluates whether to fire a notification.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	push as cmuxPush,
	dismiss as cmuxDismiss,
} from "../lib/cmuxNotify.ts";
import { DEFAULT_BACKOFF, parseDuration, fmtDuration, effectiveConfig } from "./config.ts";
import { pollFromCtx } from "./detection.ts";
import { writeHeartbeat } from "./heartbeat.ts";
import { recordFire, snapshot, transitionTo } from "./tracker.ts";
import type { Backoff, IdleWatchConfig, PiState, StateConfig, Tracker } from "./types.ts";

// Per-state notification ids so we can dismiss on transition.
const activeNotif: Record<PiState, string | null> = { working: null, idle: null };

const STATE_DEFAULTS: Record<PiState, { title: string; body: string }> = {
	working: {
		title: "⏳ pi working",
		body: "pi working for {elapsed}",
	},
	idle: {
		title: "💤 pi idle",
		body: "pi idle for {elapsed}",
	},
};

export const TEMPLATE_TOKENS = ["state", "elapsed", "sessionName", "cwd", "pid"] as const;

function renderTemplate(
	template: string,
	vars: Record<string, string>,
): string {
	return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

/** One tick. Pure-ish: uses module-level tracker/activeNotif. */
export async function tick(
	pi: ExtensionAPI,
	ctx: unknown,
	fileCfg: IdleWatchConfig,
	cwd: string,
): Promise<void> {
	const cfg = effectiveConfig(fileCfg);
	if (!cfg.enabled) return;

	// 1. reconcile from polling if that source is active
	if (cfg.detection.workingIndicator) {
		const observed = pollFromCtx(ctx);
		if (observed) transitionTo(observed);
	}

	// 2. write heartbeat (cheap, post-reconciliation snapshot)
	writeHeartbeat(cfg.heartbeat, snapshot(), cwd, false);

	// 3. evaluate fire conditions for current state
	const tracker = snapshot();
	const stateCfg = cfg.states[tracker.state];
	if (!stateCfg?.enabled) return;

	const now = Date.now();
	const elapsed = now - tracker.enteredStateAt;

	let thresholdMs: number;
	try {
		thresholdMs = parseDuration(stateCfg.threshold);
	} catch {
		return; // malformed threshold — silently skip this tick
	}
	if (elapsed < thresholdMs) return;

	const shouldFire = shouldFireNow(tracker, stateCfg, now);
	if (!shouldFire) return;

	await fire(pi, tracker.state, stateCfg, elapsed, cwd);
}

function shouldFireNow(tracker: Tracker, stateCfg: StateConfig, now: number): boolean {
	const schedule = resolveSchedule(stateCfg.backoff);

	// backoff disabled → fire exactly once per span
	if (!schedule) return tracker.firedCount === 0;

	// backoff enabled
	if (tracker.firedCount === 0) return true;
	if (tracker.firedCount > schedule.length) return false;

	// firedCount >= 1: gap is schedule[firedCount - 1]
	const idx = tracker.firedCount - 1;
	const gapRaw = schedule[idx];
	if (!gapRaw) return false;
	let gapMs: number;
	try {
		gapMs = parseDuration(gapRaw);
	} catch {
		return false;
	}
	if (tracker.lastFiredAt === null) return true;
	return now - tracker.lastFiredAt >= gapMs;
}

function resolveSchedule(b: Backoff): string[] | null {
	if (b === false) return null;
	if (b === true) return DEFAULT_BACKOFF;
	if (Array.isArray(b)) return b;
	return null;
}

async function fire(
	pi: ExtensionAPI,
	state: PiState,
	stateCfg: StateConfig,
	elapsed: number,
	cwd: string,
): Promise<void> {
	const titleTmpl = stateCfg.title ?? STATE_DEFAULTS[state].title;
	const bodyTmpl = stateCfg.body ?? STATE_DEFAULTS[state].body;

	let sessionName = "";
	try {
		sessionName = pi.getSessionName?.() ?? "";
	} catch {}

	const vars: Record<string, string> = {
		state,
		elapsed: fmtDuration(elapsed),
		sessionName,
		cwd,
		pid: String(process.pid),
	};

	const title = renderTemplate(titleTmpl, vars);
	const body = renderTemplate(bodyTmpl, vars);
	const subtitle = fmtDuration(elapsed);

	// Dismiss previous notification for THIS state (escalation replace).
	const prev = activeNotif[state];
	if (prev) {
		await cmuxDismiss(prev).catch(() => {});
		activeNotif[state] = null;
	}

	const id = await cmuxPush({ title, subtitle, body });
	if (id) activeNotif[state] = id;
	recordFire(Date.now());
}

/**
 * Called by tracker on state transition. Dismisses any active notification
 * from the OUTGOING state so the user isn't left with stale info when state flips.
 */
export async function onStateTransition(prev: PiState): Promise<void> {
	const id = activeNotif[prev];
	if (id) {
		activeNotif[prev] = null;
		await cmuxDismiss(id).catch(() => {});
	}
}

/** Sync variant for shutdown path; does not actually dismiss (no sync list). */
export function activeIds(): string[] {
	const ids: string[] = [];
	if (activeNotif.working) ids.push(activeNotif.working);
	if (activeNotif.idle) ids.push(activeNotif.idle);
	return ids;
}
