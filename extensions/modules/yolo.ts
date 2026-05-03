/**
 * yolo — opt-in non-interactive mode.
 *
 * Triggered by `pi --yolo` (registered flag) or `YOLO=1 pi` (env var).
 * When active, disables pi-guardrails by writing a project-scoped
 * `.pi/extensions/guardrails.json` with `{ "enabled": false }`.
 *
 * Limits (cannot bypass from extension space):
 *   - pi core write/edit protected-path prompts (hardcoded)
 *   - AskUserQuestion tool (no API to auto-answer)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function envYolo(): boolean {
	const v = process.env.YOLO?.toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

export default function yolo(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const flagOn = pi.getFlag("yolo") === true;
		const envOn = envYolo();
		if (!flagOn && !envOn) return;

		const cwd = typeof ctx.cwd === "function" ? (ctx.cwd as () => string)() : (ctx.cwd as unknown as string);
		const dir = join(cwd, ".pi", "extensions");
		const target = join(dir, "guardrails.json");

		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(target, JSON.stringify({ enabled: false }, null, 2) + "\n", "utf8");
			console.log(`[yolo] wrote: ${target}`);
			ctx.ui.notify(
				`🚨 YOLO: wrote ${target} (guardrails off until you re-enable)`,
				"warning",
			);
		} catch (err) {
			ctx.ui.notify(`yolo: failed to write guardrails override: ${(err as Error).message}`, "error");
		}
	});
}
