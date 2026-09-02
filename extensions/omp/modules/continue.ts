/**
 * Continue — resume work automatically after compaction.
 *
 * Especially useful with subagents: a run that stops at compaction now re-sends a prompt carrying the compaction
 * summary forward, so the task continues without anyone typing "continue". Fires for maintenance compaction the
 * host initiated (see shouldContinueAfterCompact) and for compaction triggered by the ctx context cap
 * (lastCompactionFromCtxCap) — manual /compact and other extension-driven compaction stay manual.
 *
 * The prompt defaults to DEFAULT_PROMPT and is overridden by `continueAfterCompactPrompt` in pi-yuri-extensions.json.
 * Disable: "modules": { "continue": false }.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ctxCompaction } from "../../modules/ctx.ts";
import { readSharedConfig } from "../../modules/config.ts";

export const DEFAULT_PROMPT = "Context compacted. Continue the current task from the compaction summary. Do not ask for the next step.";
/**
 * The host emits `auto_compaction_start` before automatic maintenance compaction
 * (threshold/overflow/idle/incomplete) and `auto_compaction_end` after it, with
 * `session_compact` firing inside that bracket. A manual `/compact` (and any
 * other extension-driven compaction) runs outside the bracket. `fromExtension` is
 * true only for hook-supplied summaries, so it cannot distinguish manual from
 * automatic — the bracket can. The ctx cap sets ctxCompaction.fromCap around
 * its detached `ctx.compact()`, which is why that path continues too.
 */
export function shouldContinueAfterCompact(
	insideAutoCompaction: boolean,
	fromExtension: boolean,
	fromCtxCap = false,
): boolean {
	return (insideAutoCompaction || fromCtxCap) && !fromExtension;
}

export default function continueAfterCompact(pi: ExtensionAPI): void {
	let prompt = DEFAULT_PROMPT;
	let autoCompactionDepth = 0;

	pi.on("session_start", (_event, ctx) => {
		prompt = readSharedConfig().continueAfterCompactPrompt?.trim() || DEFAULT_PROMPT;
	});

	pi.on("auto_compaction_start", () => {
		autoCompactionDepth += 1;
	});
	pi.on("session_compact", (event, ctx) => {
		if (!shouldContinueAfterCompact(autoCompactionDepth > 0, event.fromExtension, ctxCompaction.fromCap)) return;
		ctxCompaction.fromCap = false;
		ctx.setTimeout(() => pi.sendUserMessage(prompt), 0);
	});
}
