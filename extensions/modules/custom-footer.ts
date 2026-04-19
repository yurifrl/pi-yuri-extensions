import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
	// -- Summary widget above editor (reads from pi-session-summary via session name) --
	let summaryPollTimer: ReturnType<typeof setInterval> | null = null;
	let lastDisplayedSummary = "";
	let latestCtx: any = null;
	let showSummary = true;

	function updateSummaryWidget() {
		if (!latestCtx?.hasUI) return;
		if (!showSummary) {
			latestCtx.ui.setWidget("summary-above", undefined);
			return;
		}
		const name = pi.getSessionName();
		if (name && name !== lastDisplayedSummary) {
			lastDisplayedSummary = name;
			latestCtx.ui.setWidget("summary-above", (_tui: any, theme: any) => {
				return {
					render: (width: number) => {
						const truncated = truncateToWidth(name, width - 3);
						return [theme.fg("dim", "◇ ") + theme.fg("muted", truncated)];
					},
					invalidate: () => {},
				};
			});
		} else if (!name) {
			lastDisplayedSummary = "";
			latestCtx.ui.setWidget("summary-above", undefined);
		}
	}

	function startSummaryPolling() {
		if (summaryPollTimer) clearInterval(summaryPollTimer);
		let checks = 0;
		summaryPollTimer = setInterval(() => {
			updateSummaryWidget();
			if (++checks >= 15) {
				clearInterval(summaryPollTimer!);
				summaryPollTimer = null;
			}
		}, 2000);
	}

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		updateSummaryWidget();
	});

	pi.on("session_switch", async (_event, ctx) => {
		latestCtx = ctx;
		lastDisplayedSummary = "";
		updateSummaryWidget();
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		updateSummaryWidget();
		startSummaryPolling();
	});

	pi.registerCommand("summary:widget", {
		description: "Show or hide the session summary widget (on/off, no arg toggles)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") showSummary = true;
			else if (arg === "off") showSummary = false;
			else showSummary = !showSummary;
			latestCtx = ctx;
			updateSummaryWidget();
			ctx.ui.notify(`Summary widget ${showSummary ? "on" : "off"}`, "info");
		},
	});

	// -- Custom footer --
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() { unsub(); },
				invalidate() {},
				render(width: number): string[] {
					let input = 0, output = 0, cost = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							input += m.usage.input;
							output += m.usage.output;
							cost += m.usage.cost.total;
						}
					}

					const usage = ctx.getContextUsage();
					const pct = usage?.percent ?? 0;
					const pctColor = pct > 75 ? "error" : pct > 50 ? "warning" : "success";

					function fmt(n: number): string {
						if (n < 1000) return `${n}`;
						return `${(n / 1000).toFixed(1)}k`;
					}

					const tokenStats = [
						theme.fg("accent", `${fmt(input)}/${fmt(output)}`),
						theme.fg("warning", `$${cost.toFixed(2)}`),
						theme.fg(pctColor, `${pct.toFixed(0)}%`),
					].join(" ");

					const parts = process.cwd().split("/");
					const short = parts.length > 2 ? parts.slice(-2).join("/") : process.cwd();
					const cwdStr = theme.fg("muted", `⌂ ${short}`);

					const branch = footerData.getGitBranch();
					const branchStr = branch ? theme.fg("accent", `⎇ ${branch}`) : "";

					const thinking = pi.getThinkingLevel();
					const thinkColor = thinking === "high" ? "warning" : thinking === "medium" ? "accent" : thinking === "low" ? "dim" : "muted";
					const modelId = ctx.model?.id || "no-model";
					const modelStr = theme.fg(thinkColor, "◆") + " " + theme.fg("accent", modelId);

					const sep = theme.fg("dim", " | ");
					const leftParts = [modelStr, tokenStats, cwdStr];
					if (branchStr) leftParts.push(branchStr);
					const left = leftParts.join(sep);

					return [truncateToWidth(left, width)];
				},
			};
		});
	});
}
