import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// -- AWS / Kube context helpers --
function getAwsProfile(): string {
	return (
		process.env.AWS_VAULT ||
		process.env.AWS_PROFILE ||
		process.env.AWS_DEFAULT_PROFILE ||
		""
	).trim();
}

function shortenAws(name: string): string {
	if (!name) return "";
	return name.length > 12 ? name.slice(0, 12) : name;
}

function shortenKube(ctx: string): string {
	if (!ctx) return "";
	let s = ctx;
	// arn:aws:eks:<region>:<acct>:cluster/<name>
	const eksArn = s.match(/^arn:aws:eks:[^:]+:[^:]+:cluster\/(.+)$/);
	if (eksArn) s = eksArn[1];
	// gke_<project>_<zone>_<cluster>
	else if (s.startsWith("gke_")) {
		const parts = s.split("_");
		if (parts.length >= 4) s = parts[parts.length - 1];
	}
	// user@cluster.region.eksctl.io -> cluster
	else if (s.includes("@") && s.includes(".eksctl.io")) {
		const after = s.split("@")[1] || "";
		s = after.split(".")[0] || s;
	}
	// fallback: last segment after / or _
	else if (s.includes("/")) s = s.split("/").pop() || s;
	return s.length > 18 ? s.slice(0, 18) : s;
}

let kubeCtxCache = "";
let kubeCtxLastRead = 0;
function getKubeContext(): string {
	const now = Date.now();
	if (now - kubeCtxLastRead < 10_000) return kubeCtxCache;
	kubeCtxLastRead = now;
	try {
		const path = process.env.KUBECONFIG?.split(":")[0] || join(homedir(), ".kube", "config");
		const contents = readFileSync(path, "utf8");
		const m = contents.match(/^current-context:\s*(.+?)\s*$/m);
		kubeCtxCache = m ? m[1].replace(/^['"]|['"]$/g, "") : "";
	} catch {
		kubeCtxCache = "";
	}
	return kubeCtxCache;
}

export default function (pi: ExtensionAPI) {
	let showContext = true;
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
		if (!latestCtx?.hasUI) return;
		let checks = 0;
		summaryPollTimer = setInterval(() => {
			updateSummaryWidget();
			if (++checks >= 15) {
				clearInterval(summaryPollTimer!);
				summaryPollTimer = null;
			}
		}, 2000);
		summaryPollTimer?.unref?.();
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
	let footerCtx: any = null;
	function installFooter(ctx: any) {
		footerCtx = ctx;
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() { unsub(); },
				invalidate() {},
				render(width: number): string[] {
					const active = footerCtx;
					if (!active) return [""];
					let input = 0, output = 0, cost = 0;
					try {
					for (const e of active.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							input += m.usage.input;
							output += m.usage.output;
							cost += m.usage.cost.total;
						}
					}

					} catch { return [""]; }
					let usage: any;
					try { usage = active.getContextUsage(); } catch { return [""]; }
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

					let awsStr = "";
					let kubeStr = "";
					if (showContext) {
						const aws = shortenAws(getAwsProfile());
						if (aws) awsStr = theme.fg("warning", "☁ ") + theme.fg("accent", aws);
						const kctx = shortenKube(getKubeContext());
						if (kctx) kubeStr = theme.fg("success", "⎈ ") + theme.fg("accent", kctx);
					}

					const thinking = pi.getThinkingLevel();
					const thinkColor = thinking === "high" ? "warning" : thinking === "medium" ? "accent" : thinking === "low" ? "dim" : "muted";
					const modelId = active.model?.id || "no-model";
					const modelStr = theme.fg(thinkColor, "◆") + " " + theme.fg("accent", modelId);

					const sep = theme.fg("dim", " | ");
					const leftParts = [modelStr, tokenStats, cwdStr];
					if (branchStr) leftParts.push(branchStr);
					if (awsStr) leftParts.push(awsStr);
					if (kubeStr) leftParts.push(kubeStr);
					const left = leftParts.join(sep);

					return [truncateToWidth(left, width)];
				},
			};
		});
	}
	pi.on("session_start", async (_event, ctx) => { installFooter(ctx); });
	pi.on("session_switch", async (_event, ctx) => { footerCtx = ctx; kubeCtxLastRead = 0; });

	pi.registerCommand("footer:context", {
		description: "Show or hide AWS / kube context in the footer (on/off, no arg toggles)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") showContext = true;
			else if (arg === "off") showContext = false;
			else showContext = !showContext;
			kubeCtxLastRead = 0;
			ctx.ui.notify(`Footer context ${showContext ? "on" : "off"}`, "info");
		},
	});
}
