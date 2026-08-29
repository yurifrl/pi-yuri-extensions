import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readOmpConfig } from "../config.ts";
import type { ModuleConfig } from "../../modules/config.ts";

/**
 * Working indicator with elapsed timer.
 *
 * Message is PLAIN TEXT: the TUI Loader wraps it with the theme's muted
 * color, so ANSI escapes in the message end up rendered as literal junk
 * (e.g. "[32m"). Don't add any.
 *
 * Behavior (all measured from the last activity event):
 *   0 .. graceSeconds        → "Working…" (no timer yet)
 *   graceSeconds .. still    → "Working… M:SS" (counts from grace elapsed)
 *   >= stillAfterSeconds     → "Still working… M:SS"
 *
 * Activity events that reset the timer: message_start/update/end,
 * tool_call, tool_result, input (covers user/harness steers mid-run),
 * agent_start, turn_start.
 *
 * Config (~/.omp/agent/extensions/pi-yuri-extensions.json):
 *   "working": { "enabled": true, "graceSeconds": 10, "stillAfterSeconds": 25 }
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
}

function resolveSettings(): Required<Pick<ModuleConfig, "graceSeconds" | "stillAfterSeconds">> {
	const module = readOmpConfig().modules?.working ?? {};
	const graceSeconds = module.graceSeconds ?? 10;
	const stillAfterSeconds = module.stillAfterSeconds ?? graceSeconds + 15;
	return {
		graceSeconds,
		// "Still working…" must land after the grace period, else clamp.
		stillAfterSeconds: Math.max(stillAfterSeconds, graceSeconds + 1),
	};
}

export default function working(pi: ExtensionAPI): void {
	const { graceSeconds, stillAfterSeconds } = resolveSettings();
	const graceMs = graceSeconds * 1000;
	const stillAfterMs = stillAfterSeconds * 1000;

	let active = false;
	let lastActivityAt = Date.now();

	function markActivity(): void {
		lastActivityAt = Date.now();
	}

	function render(ui: WorkingUI): void {
		if (!active) return;
		const since = Date.now() - lastActivityAt;
		let message: string;
		if (since < graceMs) {
			message = "Working…";
		} else {
			const label = since >= stillAfterMs ? "Still working…" : "Working…";
			message = `${label} ${formatDuration(since - graceMs)}`;
		}
		ui.setWorkingMessage?.(message);
	}

	pi.on("session_start", async (_event, ctx) => {
		ctx.setInterval(() => render(ctx.ui), TICK_MS);
	});

	// A run is active from agent start until agent end (steers keep the same run).
	pi.on("agent_start", markActivity);
	pi.on("turn_start", markActivity);

	// Every streamed message, tool exchange, and steer resets the timer.
	pi.on("message_start", markActivity);
	pi.on("message_update", markActivity);
	pi.on("message_end", markActivity);
	pi.on("tool_call", markActivity);
	pi.on("tool_result", markActivity);
	pi.on("input", markActivity);

	pi.on("agent_end", async (_event, ctx) => {
		active = false;
		ctx.ui.setWorkingMessage?.();
	});
}
