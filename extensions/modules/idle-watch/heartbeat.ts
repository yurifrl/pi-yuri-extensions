/**
 * Heartbeat writer. Emits JSON to `~/.pi/state/idle-<pid>.json`
 * on every state transition, every tick, and on session_shutdown.
 *
 * External watchers (cron, fish function, supervisor) can detect a hung pi:
 *   now - lastTickAt > tickSeconds * 3  &&  !cleanExit  ⇒ probably stuck
 */

import { writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as pathResolve } from "node:path";
import type { HeartbeatConfig, Tracker } from "./types.ts";

interface HeartbeatPayload {
	pid: number;
	session: string;
	cwd: string;
	state: Tracker["state"];
	enteredStateAt: number;
	lastTickAt: number;
	cleanExit: boolean;
}

let ensuredDir = false;

function expandPath(raw: string): string {
	let p = raw.replace(/\{pid\}/g, String(process.pid));
	if (p.startsWith("~/")) p = pathResolve(homedir(), p.slice(2));
	else if (p === "~") p = homedir();
	return pathResolve(p);
}

function sessionName(): string {
	return (
		process.env.ZELLIJ_SESSION_NAME?.trim() ||
		process.env.CMUX_SESSION_NAME?.trim() ||
		process.env.CLAUDE_SESSION_NAME?.trim() ||
		"unknown"
	);
}

/** Write the heartbeat atomically (temp + rename). Never throws. */
export function writeHeartbeat(
	cfg: HeartbeatConfig,
	tracker: Tracker,
	cwd: string,
	cleanExit: boolean,
): void {
	if (!cfg?.enabled) return;
	try {
		const target = expandPath(cfg.path);
		if (!ensuredDir) {
			mkdirSync(dirname(target), { recursive: true });
			ensuredDir = true;
		}
		const payload: HeartbeatPayload = {
			pid: process.pid,
			session: sessionName(),
			cwd,
			state: tracker.state,
			enteredStateAt: tracker.enteredStateAt,
			lastTickAt: Date.now(),
			cleanExit,
		};
		const tmp = `${target}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
		renameSync(tmp, target);
	} catch {
		// best-effort; never throw
	}
}

/** Best-effort cleanup on clean shutdown. Leaves file intact for external watcher. */
export function finalize(
	cfg: HeartbeatConfig,
	tracker: Tracker,
	cwd: string,
): void {
	writeHeartbeat(cfg, tracker, cwd, true);
}

/** Remove the heartbeat file entirely. Not used by default; exposed for future. */
export function removeHeartbeat(cfg: HeartbeatConfig): void {
	if (!cfg?.enabled) return;
	try {
		unlinkSync(expandPath(cfg.path));
	} catch {}
}
