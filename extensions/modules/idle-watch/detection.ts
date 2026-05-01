/**
 * Detection sources. Two independent paths, either or both may be active:
 *   - events: agent_start / agent_end drive instant transitions
 *   - polling: ctx.isIdle() read on every tick, reconciled as ground truth
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PiState } from "./types.ts";
import { transitionTo } from "./tracker.ts";

/**
 * Attach event-based detection. Idempotent-ish: callers should only call once
 * per session. No teardown needed — listeners die with the pi process.
 */
export function attachEvents(pi: ExtensionAPI): void {
	pi.on("agent_start", () => {
		transitionTo("working");
	});
	pi.on("agent_end", () => {
		transitionTo("idle");
	});
}

/**
 * Read the TUI "Working..." indicator via ctx.isIdle().
 * Returns null if ctx doesn't expose isIdle (defensive; should not happen in
 * supported pi versions).
 */
export function pollFromCtx(ctx: unknown): PiState | null {
	try {
		const isIdle = (ctx as { isIdle?: () => boolean } | null | undefined)?.isIdle;
		if (typeof isIdle !== "function") return null;
		return isIdle.call(ctx) ? "idle" : "working";
	} catch {
		return null;
	}
}
