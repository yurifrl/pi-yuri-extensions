/**
 * `/idle` subcommand parser. Pure string handling, no AI, no persistence.
 * All mutations apply to the in-memory session overrides only.
 */

import { parseDuration, fmtDuration, effectiveConfig, getOverrides, updateOverrides } from "./config.ts";
import { resetCounters, snapshot } from "./tracker.ts";
import type { IdleWatchConfig, PiState, StateConfig } from "./types.ts";

const USAGE = [
	"/idle                              show status + effective config",
	"/idle on | off                     enable / disable notifications this session",
	"/idle working <dur>                override working threshold (e.g. 5m, 30s, 1h)",
	"/idle idle <dur>                   override idle threshold",
	"/idle backoff on | off             toggle backoff for both states",
	"/idle backoff <state> on|off|<csv> per-state backoff, e.g. /idle backoff working 2m,5m,15m",
	"/idle reset                        clear fire counters",
].join("\n");

type Reply = { text: string; kind?: "info" | "success" | "error" | "warning" };

export function handle(args: string, fileCfg: IdleWatchConfig): Reply {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const cmd = (tokens[0] ?? "").toLowerCase();

	try {
		if (!cmd) return status(fileCfg);
		if (cmd === "status") return status(fileCfg);
		if (cmd === "on" || cmd === "off") return setEnabled(cmd === "on");
		if (cmd === "reset") return doReset();
		if (cmd === "backoff") return handleBackoff(tokens.slice(1));
		if (cmd === "working" || cmd === "idle") {
			return setThreshold(cmd as PiState, tokens[1]);
		}
		return { text: `unknown subcommand '${cmd}'\n\n${USAGE}`, kind: "error" };
	} catch (err) {
		return { text: `/idle: ${(err as Error).message}\n\n${USAGE}`, kind: "error" };
	}
}

function status(fileCfg: IdleWatchConfig): Reply {
	const snap = snapshot();
	const cfg = effectiveConfig(fileCfg);
	const elapsed = Date.now() - snap.enteredStateAt;
	const overrides = getOverrides();
	const hasOverrides = Object.keys(overrides).length > 0;

	const lines = [
		`state:         ${snap.state} (for ${fmtDuration(elapsed)})`,
		`firedCount:    ${snap.firedCount}`,
		`lastFiredAt:   ${snap.lastFiredAt ? new Date(snap.lastFiredAt).toISOString() : "(none)"}`,
		"",
		`enabled:       ${cfg.enabled}`,
		`tickSeconds:   ${cfg.tickSeconds}`,
		`detection:     events=${cfg.detection.events} workingIndicator=${cfg.detection.workingIndicator}`,
		`working:       enabled=${cfg.states.working.enabled} threshold=${cfg.states.working.threshold} backoff=${fmtBackoff(cfg.states.working.backoff)}`,
		`  title:       ${cfg.states.working.title ?? "(default)"}`,
		`  body:        ${cfg.states.working.body ?? "(default)"}`,
		`idle:          enabled=${cfg.states.idle.enabled} threshold=${cfg.states.idle.threshold} backoff=${fmtBackoff(cfg.states.idle.backoff)}`,
		`  title:       ${cfg.states.idle.title ?? "(default)"}`,
		`  body:        ${cfg.states.idle.body ?? "(default)"}`,
		`heartbeat:     enabled=${cfg.heartbeat.enabled} path=${cfg.heartbeat.path}`,
		"",
		`template tokens: {state} {elapsed} {sessionName} {cwd} {pid}`,
		"",
		hasOverrides ? `session overrides active (cleared on pi restart)` : `no session overrides`,
	];
	return { text: lines.join("\n"), kind: "info" };
}

function fmtBackoff(b: StateConfig["backoff"]): string {
	if (b === false) return "off";
	if (b === true) return "on (defaults)";
	return `[${b.join(",")}]`;
}

function setEnabled(on: boolean): Reply {
	updateOverrides((o) => {
		o.enabled = on;
	});
	return { text: `idle-watch ${on ? "enabled" : "disabled"} (session only)`, kind: "success" };
}

function doReset(): Reply {
	resetCounters();
	return { text: "idle-watch: fire counters reset", kind: "success" };
}

function setThreshold(state: PiState, value: string | undefined): Reply {
	if (!value) throw new Error(`usage: /idle ${state} <duration>`);
	parseDuration(value); // validate, throw if bad
	updateOverrides((o) => {
		o.states = o.states ?? {};
		o.states[state] = { ...(o.states[state] ?? {}), threshold: value };
	});
	return { text: `idle-watch: ${state} threshold set to ${value} (session only)`, kind: "success" };
}

function handleBackoff(rest: string[]): Reply {
	// forms:
	//   backoff on|off          → both states
	//   backoff <state> on|off|<csv>
	if (rest.length === 0) throw new Error("usage: /idle backoff on|off  OR  /idle backoff <state> on|off|<csv>");

	const a = rest[0]!.toLowerCase();

	if (a === "on" || a === "off") {
		const b = a === "on";
		updateOverrides((o) => {
			o.states = o.states ?? {};
			o.states.working = { ...(o.states.working ?? {}), backoff: b };
			o.states.idle = { ...(o.states.idle ?? {}), backoff: b };
		});
		return { text: `idle-watch: backoff ${a} for both states (session only)`, kind: "success" };
	}

	if (a === "working" || a === "idle") {
		const target = a as PiState;
		const v = rest[1];
		if (!v) throw new Error(`usage: /idle backoff ${a} on|off|<csv>`);
		const bv = parseBackoffValue(v);
		updateOverrides((o) => {
			o.states = o.states ?? {};
			o.states[target] = { ...(o.states[target] ?? {}), backoff: bv };
		});
		return { text: `idle-watch: ${a} backoff → ${fmtBackoff(bv)} (session only)`, kind: "success" };
	}

	throw new Error(`unknown backoff target '${a}'`);
}

function parseBackoffValue(raw: string): StateConfig["backoff"] {
	const v = raw.trim().toLowerCase();
	if (v === "on") return true;
	if (v === "off") return false;
	// csv of durations
	const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
	if (parts.length === 0) throw new Error("empty backoff list");
	for (const p of parts) parseDuration(p); // validate each
	return parts;
}

export { USAGE };
