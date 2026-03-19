/**
 * Agent Loop Extension — Layer 2 of the Personal Agent
 *
 * On session start: reads inbox from agent.db, triages, presents summary.
 * Watches for new inbox items during session.
 * Registers /loop, /status, /budget commands.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const AGENTS_DIR = path.join(process.env.HOME || "", ".agents");
const AGENT_DB = path.join(AGENTS_DIR, "state", "agent.db");
const STATE_DIR = path.join(AGENTS_DIR, "state");

function queryDb(sql: string): string {
	try {
		return execSync(`sqlite3 "${AGENT_DB}" "${sql}"`, {
			encoding: "utf-8",
			timeout: 5000,
		}).trim();
	} catch {
		return "";
	}
}

function getInboxSummary(): { urgent: string[]; normal: string[]; low: string[]; total: number } {
	const urgent: string[] = [];
	const normal: string[] = [];
	const low: string[] = [];

	try {
		const rows = execSync(
			`sqlite3 -json "${AGENT_DB}" "SELECT source, type, priority, title, created_at FROM inbox WHERE status = 'new' ORDER BY created_at DESC LIMIT 50"`,
			{ encoding: "utf-8", timeout: 5000 }
		).trim();

		if (!rows || rows === "[]") return { urgent, normal, low, total: 0 };

		const items = JSON.parse(rows);
		for (const item of items) {
			const line = `[${item.source}] ${item.title}`;
			if (item.priority === "urgent") urgent.push(line);
			else if (item.priority === "normal") normal.push(line);
			else low.push(line);
		}

		return { urgent, normal, low, total: items.length };
	} catch {
		return { urgent, normal, low, total: 0 };
	}
}

function getBudgetStatus(): string {
	const raw = queryDb("SELECT value FROM loop_state WHERE key = 'budget_status'");
	if (!raw) return "No budget data yet. Run daemon first.";

	try {
		const b = JSON.parse(raw);
		const dailyBar = progressBar(b.daily_pct);
		const monthlyBar = progressBar(b.monthly_pct);
		return [
			`  Daily:   ${dailyBar} $${b.daily_spend.toFixed(3)} / $${b.daily_limit.toFixed(2)} (${b.daily_pct.toFixed(1)}%)`,
			`  Monthly: ${monthlyBar} $${b.monthly_spend.toFixed(3)} / $${b.monthly_limit.toFixed(2)} (${b.monthly_pct.toFixed(1)}%)`,
		].join("\n");
	} catch {
		return "Budget data corrupt.";
	}
}

function progressBar(pct: number): string {
	const filled = Math.round(pct / 5);
	const empty = 20 - filled;
	const warn = pct >= 80 ? "🔴" : pct >= 50 ? "🟡" : "🟢";
	return `${warn} [${"█".repeat(filled)}${"░".repeat(Math.max(0, empty))}]`;
}

function getBeadsReady(): string {
	try {
		const result = execSync("cd ~/.agents && bd ready --json 2>/dev/null", {
			encoding: "utf-8",
			timeout: 10000,
		}).trim();
		if (!result || result === "[]") return "No ready work.";
		const items = JSON.parse(result);
		return items.map((i: any) => `  ${i.id}: ${i.title} (P${i.priority})`).join("\n");
	} catch {
		return "Could not check beads (server may be down).";
	}
}

function getCostBreakdown(): string {
	try {
		const daily = execSync(
			`sqlite3 -json "${AGENT_DB}" "SELECT model, SUM(cost_usd) as cost, SUM(input_tokens) as input_tok, SUM(output_tokens) as output_tok, COUNT(*) as calls FROM costs WHERE date(timestamp) = date('now') GROUP BY model"`,
			{ encoding: "utf-8", timeout: 5000 }
		).trim();

		if (!daily || daily === "[]") return "No costs recorded today.";

		const items = JSON.parse(daily);
		const lines = items.map(
			(i: any) =>
				`  ${i.model}: $${i.cost.toFixed(4)} (${i.calls} calls, ${i.input_tok} in / ${i.output_tok} out)`
		);

		const total = items.reduce((s: number, i: any) => s + i.cost, 0);
		lines.push(`  ────────────────────`);
		lines.push(`  Total today: $${total.toFixed(4)}`);
		return lines.join("\n");
	} catch {
		return "No cost data available.";
	}
}

export default function agentLoop(pi: ExtensionAPI) {
	// ─── Session Start: Briefing ────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!fs.existsSync(AGENT_DB)) return;

		const inbox = getInboxSummary();

		if (inbox.total === 0) return; // Nothing to report

		const parts: string[] = ["📬 **Agent Loop Briefing**", ""];

		if (inbox.urgent.length > 0) {
			parts.push(`🔴 **Urgent (${inbox.urgent.length}):**`);
			inbox.urgent.forEach((l) => parts.push(`  ${l}`));
			parts.push("");
		}

		if (inbox.normal.length > 0) {
			parts.push(`🟡 **Normal (${inbox.normal.length}):**`);
			inbox.normal.slice(0, 5).forEach((l) => parts.push(`  ${l}`));
			if (inbox.normal.length > 5) parts.push(`  ...and ${inbox.normal.length - 5} more`);
			parts.push("");
		}

		if (inbox.low.length > 0) {
			parts.push(`🟢 Low: ${inbox.low.length} items`);
		}

		const message = parts.join("\n");

		pi.sendMessage(
			{
				customType: "agent-loop-briefing",
				content: message,
				display: true,
			},
			{ triggerTurn: inbox.urgent.length > 0 }
		);
	});

	// ─── /status Command ────────────────────────────────────────

	pi.registerCommand("status", {
		description: "Show agent status dashboard",
		handler: async (_args, ctx) => {
			const inbox = getInboxSummary();
			const budget = getBudgetStatus();
			const beads = getBeadsReady();
			const lastRun = queryDb("SELECT value FROM loop_state WHERE key = 'last_run'");

			const msg = [
				"📊 **Agent Status**",
				"",
				`**Inbox:** ${inbox.total} new items (${inbox.urgent.length} urgent, ${inbox.normal.length} normal, ${inbox.low.length} low)`,
				"",
				"**Budget:**",
				budget,
				"",
				"**Ready Work (beads):**",
				beads,
				"",
				`**Last daemon run:** ${lastRun || "never"}`,
			].join("\n");

			ctx.ui.notify(msg, "info");
		},
	});

	// ─── /budget Command ────────────────────────────────────────

	pi.registerCommand("budget", {
		description: "Show cost breakdown",
		handler: async (_args, ctx) => {
			const budget = getBudgetStatus();
			const breakdown = getCostBreakdown();

			const msg = [
				"💰 **Budget & Costs**",
				"",
				"**Limits:**",
				budget,
				"",
				"**Today's Breakdown:**",
				breakdown,
			].join("\n");

			ctx.ui.notify(msg, "info");
		},
	});

	// ─── /loop Command ──────────────────────────────────────────

	pi.registerCommand("loop", {
		description: "Run a full agent cycle — check inbox, beads, knowledge",
		handler: async (_args, ctx) => {
			// Run daemon cycle first
			try {
				execSync("cd ~/.agents/skills/pa && uv run daemon.py 2>/dev/null", {
					timeout: 60000,
				});
			} catch {
				// daemon may fail on slack, that's ok
			}

			const inbox = getInboxSummary();
			const beads = getBeadsReady();
			const budget = getBudgetStatus();

			const summary = [
				"🔄 **Agent Loop Cycle Complete**",
				"",
				`**Inbox:** ${inbox.total} items`,
			];

			if (inbox.urgent.length > 0) {
				summary.push("", "🔴 **Urgent:**");
				inbox.urgent.forEach((l) => summary.push(`  ${l}`));
			}

			if (inbox.normal.length > 0) {
				summary.push("", "🟡 **Needs attention:**");
				inbox.normal.slice(0, 5).forEach((l) => summary.push(`  ${l}`));
			}

			summary.push("", "**Ready work:**", beads, "", "**Budget:**", budget);

			// Send as user message so the LLM can reason about what to do
			pi.sendUserMessage(summary.join("\n"));
		},
	});
}
