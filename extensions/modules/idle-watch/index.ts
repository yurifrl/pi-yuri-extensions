/**
 * idle-watch — periodic state detection with threshold-driven notifications.
 *
 * Default OFF at the pi-extensions registry level. When enabled:
 *   - Detects pi session state via ctx.isIdle() (default) and/or agent events
 *   - Fires cmux notifications when pi is "working" or "idle" too long
 *   - Writes a heartbeat JSON so external watchers can detect hangs
 *   - Registers /idle slash command for session-only overrides
 *
 * Config lives under the "idle-watch" key in pi-extensions.json.
 * See ../../README.md for the full config surface.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { dismissSync as cmuxDismissSync } from "../lib/cmuxNotify.ts";
import { effectiveConfig, loadFileConfig } from "./config.ts";
import { attachEvents } from "./detection.ts";
import { finalize, writeHeartbeat } from "./heartbeat.ts";
import { onTransition, snapshot, transitionTo } from "./tracker.ts";
import { activeIds, onStateTransition, tick } from "./tick.ts";
import { handle as handleCommand } from "./commands.ts";
import type { IdleWatchConfig } from "./types.ts";

export default function idleWatch(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | null = null;
	let fileCfg: IdleWatchConfig | null = null;
	let cwdRef = process.cwd();
	let ctxRef: unknown = null;

	pi.on("session_start", async (_event, ctx) => {
		cwdRef = typeof ctx.cwd === "function" ? (ctx.cwd as () => string)() : (ctx.cwd as unknown as string);
		ctxRef = ctx;

		fileCfg = await loadFileConfig(cwdRef);
		const cfg = effectiveConfig(fileCfg);

		// Seed tracker from ctx.isIdle() if available, so first tick is already accurate.
		try {
			const isIdle = (ctx as { isIdle?: () => boolean }).isIdle;
			if (typeof isIdle === "function") {
				transitionTo(isIdle.call(ctx) ? "idle" : "working");
			}
		} catch {}

		// Events path: opt-in.
		if (cfg.detection.events) attachEvents(pi);

		// Dismiss active notifications on state transition.
		onTransition((_next, prev) => {
			void onStateTransition(prev).catch(() => {});
		});

		// Initial heartbeat so external watchers see us immediately.
		writeHeartbeat(cfg.heartbeat, snapshot(), cwdRef, false);

		if (timer) return;
		const ms = Math.max(1, cfg.tickSeconds) * 1000;
		timer = setInterval(() => {
			if (!fileCfg) return;
			void tick(pi, ctxRef, fileCfg, cwdRef).catch(() => {});
		}, ms);
		try {
			(timer as { unref?: () => void }).unref?.();
		} catch {}
	});

	pi.on("session_shutdown", async () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		if (fileCfg) {
			try {
				finalize(effectiveConfig(fileCfg).heartbeat, snapshot(), cwdRef);
			} catch {}
		}
		for (const id of activeIds()) cmuxDismissSync(id);
	});

	// Safety net: clean up on process exit if session_shutdown didn't fire.
	process.on("exit", () => {
		for (const id of activeIds()) cmuxDismissSync(id);
		if (fileCfg) {
			try {
				finalize(effectiveConfig(fileCfg).heartbeat, snapshot(), cwdRef);
			} catch {}
		}
	});

	pi.registerCommand?.("idle", {
		description: "Show or tune idle-watch (session only): /idle [on|off|working <dur>|idle <dur>|backoff ...|reset]",
		handler: async (args: string, ctx: { ui?: { notify?: (msg: string, kind?: string) => void } }) => {
			if (!fileCfg) {
				try {
					ctx?.ui?.notify?.("idle-watch not initialized yet", "warning");
				} catch {}
				return;
			}
			const reply = handleCommand(args ?? "", fileCfg);
			// eslint-disable-next-line no-console
			console.log(reply.text);
			try {
				ctx?.ui?.notify?.(
					reply.kind === "error" ? "idle-watch: error (see terminal)" : "idle-watch status printed",
					reply.kind ?? "info",
				);
			} catch {}
		},
	});
}
