import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readOmpConfig } from "../config.ts";

/**
 * Working indicator with elapsed timer.
 *
 * Spec: show NOTHING while the internal counter is under the grace
 * period. The counter resets on every new message (and steer/tool
 * activity). Only once silence exceeds graceSeconds does the loader row
 * appear, showing the real elapsed time (which starts at the grace
 * value, e.g. 0:10). The label flips to "Still working…" after
 * stillAfterSeconds.
 *
 * The working message is PLAIN TEXT: the TUI Loader wraps it with the
 * theme muted color; raw ANSI prints as literal junk.
 *
 * Config (~/.omp/agent/extensions/pi-yuri-extensions.json):
 *   "working": { "enabled": true, "graceSeconds": 10, "stillAfterSeconds": 45, "debug": false }
 */

const TICK_MS = 500;

function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

interface WorkingUI {
	setWorkingMessage?(message?: string): void;
	setWorkingVisible?(visible: boolean): void;
}

function resolveSettings(): { graceMs: number; stillAfterMs: number; debug: boolean } {
	const module = readOmpConfig().modules?.working ?? {};
	const graceSeconds = module.graceSeconds ?? 10;
	const stillAfterSeconds = module.stillAfterSeconds ?? graceSeconds + 30;
	return {
		graceMs: graceSeconds * 1000,
		stillAfterMs: Math.max(stillAfterSeconds, graceSeconds + 1) * 1000,
		debug: module.debug ?? false,
	};
}

export default function working(pi: ExtensionAPI): void {
	const { graceMs, stillAfterMs, debug } = resolveSettings();
	const log = (msg: string) => pi.logger?.debug?.(`[working] ${msg}`);

	let active = false;
	let lastMessageAt = Date.now();
	// The TUI row is visible by default, so start as "shown" — the first
	// hide() must actually fire to suppress the stock indicator.
	let suppressed = false;
	let ui: WorkingUI | undefined;

	if (debug) log(`init grace=${Math.round(graceMs / 1000)}s stillAfter=${Math.round(stillAfterMs / 1000)}s`);

	function hide(): void {
		if (!suppressed) {
			ui?.setWorkingVisible?.(false);
			suppressed = true;
		}
	}

	function markActivity(event: string): void {
		lastMessageAt = Date.now();
		hide();
		if (debug) log(`${event} reset (active=${active})`);
	}

	function render(): void {
		if (!active || !ui) return;
		const since = Date.now() - lastMessageAt;
		if (since < graceMs) {
			hide();
			return;
		}
		if (suppressed) {
			ui.setWorkingVisible?.(true);
			suppressed = false;
		}
		const label = since >= stillAfterMs ? "Still working…" : "Working…";
		ui.setWorkingMessage?.(`${label} ${formatDuration(since)}`);
	}

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui;
		ctx.setInterval(render, TICK_MS);
	});

	// A run is active from agent start until agent end (steers keep the same run).
	pi.on("agent_start", () => {
		active = true;
		markActivity("agent_start");
	});
	pi.on("turn_start", () => {
		active = true;
		markActivity("turn_start");
	});

	// Every new message, tool exchange, and steer resets the counter and re-hides.
	pi.on("message_start", () => markActivity("message_start"));
	pi.on("message_update", () => markActivity("message_update"));
	pi.on("message_end", () => markActivity("message_end"));
	pi.on("tool_call", () => markActivity("tool_call"));
	pi.on("tool_result", () => markActivity("tool_result"));
	pi.on("input", () => markActivity("input"));

	pi.on("agent_end", async (_event, ctx) => {
		if (debug) log("agent_end restore");
		active = false;
		suppressed = true;
		ctx.ui.setWorkingVisible?.(true);
		ctx.ui.setWorkingMessage?.();
	});
}
