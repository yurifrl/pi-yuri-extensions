/**
 * Budget — USD spend gates for the session, enforced with continue/abort prompts.
 *
 * Spend = sum of usage.cost.total over assistant messages on the active branch (sessionSpend(), shared with the
 * statusline). On turn start, every unfired gate at or below the running total is marked fired and one confirm prompts
 * for the highest crossed threshold; declining aborts the run. Gates reload on session start and the fired set resets
 * on session switch, so a resumed session above several gates prompts once, not once per stale gate.
 *
 * /budget — show gates and spend · /budget 50,100 — set (positive, deduped, sorted) · /budget off — clear. Gates
 * persist as `budgetGates` in pi-yuri-extensions.json and apply to every session. Disable: "modules": { "budget": false }.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { readSharedConfig, writeSharedConfig } from "../config.ts";

let gates: number[] = [];
const fired = new Set<number>();

export type SessionPrice = { input: number; output: number; cacheRead: number; cacheWrite: number };

export function sessionSpend(ctx: ExtensionContext, prices: Record<string, SessionPrice> = {}): { total: number; messages: number } {
	let total = 0;
	let messages = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		const usage = message.usage;
		if (!usage) continue;
		const reported = usage.cost?.total ?? 0;
		const price = prices[message.model];
		const calculated = price
			? (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite) / 1_000_000
			: 0;
		total += reported > 0 ? reported : calculated;
		messages += 1;
	}
	return { total, messages };
}

/** All unfired thresholds at or below the given spend, ascending. Callers mark every returned gate fired and prompt once for the highest. */
export function crossedGates(cost: number, thresholds: number[], completed: Set<number>): number[] {
	return [...thresholds].sort((a, b) => a - b).filter((threshold) => cost >= threshold && !completed.has(threshold));
}

function parseGates(value: string): number[] {
	return [
		...new Set(
			value
				.split(/[\s,]+/)
				.map(Number)
				.filter((gate) => Number.isFinite(gate) && gate > 0),
		),
	].sort((a, b) => a - b);
}

export default function budget(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		fired.clear();
		gates = readSharedConfig().budgetGates ?? [];
	});
	// omp-only event (fires for /new, /resume, fork, handoff); registered through a
	// widened signature so the same code typechecks against pi's narrower event map.
	(pi as { on(event: string, handler: () => void): void }).on("session_switch", () => fired.clear());
	pi.on("turn_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const cost = sessionSpend(ctx);
		const crossed = crossedGates(cost.total, gates, fired);
		if (crossed.length === 0) return;
		for (const gate of crossed) fired.add(gate);
		const highest = crossed[crossed.length - 1];
		const continueRun = await ctx.ui.confirm(
			`Budget gate: $${highest.toFixed(2)} spent`,
			`Session cost is $${cost.total.toFixed(2)} (crossed ${crossed.map((gate) => `$${gate}`).join(", ")}). Continue?`,
		);
		if (!continueRun) ctx.abort();
	});
	pi.registerCommand("budget", {
		description: "Show or set session spend gates: /budget [off|50,100]",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value === "" || value === "status") {
				ctx.ui.notify(
					gates.length
						? `Budget gates: ${gates.map((gate) => `$${gate}`).join(", ")} · spent $${sessionSpend(ctx).total.toFixed(2)}`
						: "Budget gates are off.",
					"info",
				);
				return;
			}
			if (value === "off") gates = [];
			else {
				const parsed = parseGates(value);
				if (parsed.length === 0) {
					ctx.ui.notify("Use /budget off or positive comma-separated dollar thresholds.", "error");
					return;
				}
				gates = parsed;
			}
			fired.clear();
			writeSharedConfig({ ...readSharedConfig(), budgetGates: gates });
			ctx.ui.notify(
				gates.length ? `Budget gates saved: ${gates.map((gate) => `$${gate}`).join(", ")}` : "Budget gates disabled.",
				"info",
			);
		},
	});
}
