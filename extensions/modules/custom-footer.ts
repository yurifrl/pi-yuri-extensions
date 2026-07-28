import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readPiYuConfigFile, resolvePiYuConfigPath } from "./lib/config.ts";

// Full custom footer (replaces pi's native footer via setFooter) so every line
// is ours to format: a worst-of health dot + context-cap %, native-equivalent
// usage stats, then a location line. Model-agnostic — reads pi's built-in usage.

const LARGE_CONTEXT_TOKENS = 50_000; // ponytail: fixed floor for "worth warning about re-sending"

interface Config {
	ctxCap: number | null; // effective window = min(ctxCap, model window); null = model window
	warnCost: number; // session $ at which the health dot ratchets to yellow
	critCost: number; // session $ at which it ratchets to red
	cacheTtlSec: number; // prompt-cache TTL used for the freshness countdown
	components: Record<string, boolean>; // per-field visibility; missing key = shown
}
// Persistent default comes from pi-yuri-extensions.json `customFooter`; the
// /footer:ctxcap command overrides ctxCap in-memory for the current session only.
const config: Config = { ctxCap: null, warnCost: 3, critCost: 10, cacheTtlSec: 300, components: {} };

// Toggleable footer fields, in display order. label shown in /footer:toggle menu.
const COMPONENTS: { key: string; label: string }[] = [
	{ key: "health", label: "🟢 health dot" },
	{ key: "context", label: "🧠 context %" },
	{ key: "cacheHit", label: "CH cache-hit %" },
	{ key: "freshness", label: "⧗ cache freshness" },
	{ key: "usage", label: "↑↓ token usage / cost" },
	{ key: "model", label: "◆ model" },
	{ key: "cwd", label: "⌂ working dir" },
	{ key: "git", label: "⎇ git branch" },
	{ key: "aws", label: "☁ aws profile" },
	{ key: "kube", label: "⎈ kube context" },
	{ key: "extensions", label: "other plugins' statuses (bottom line)" },
];
const on = (key: string) => config.components[key] !== false; // default on

let lastActivityMs = Date.now(); // last time the cache was (re)written = last turn end
let promptedThisEpisode = false;

async function loadConfig(cwd: string): Promise<void> {
	try {
		const { content } = await readPiYuConfigFile(cwd);
		if (!content) return;
		const cf = (JSON.parse(content) as { customFooter?: Partial<Config> }).customFooter ?? {};
		if (typeof cf.ctxCap === "number" || cf.ctxCap === null) config.ctxCap = cf.ctxCap ?? null;
		if (typeof cf.warnCost === "number" && cf.warnCost > 0) config.warnCost = cf.warnCost;
		if (typeof cf.critCost === "number" && cf.critCost > 0) config.critCost = cf.critCost;
		if (typeof cf.cacheTtlSec === "number" && cf.cacheTtlSec > 0) config.cacheTtlSec = cf.cacheTtlSec;
		if (cf.components && typeof cf.components === "object") config.components = { ...cf.components };
	} catch {
		/* keep defaults */
	}
}
function parseTokenCount(s: string): number | null {
	const m = s.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
	if (!m) return null;
	const n = parseFloat(m[1]);
	if (m[2] === "k") return Math.round(n * 1_000);
	if (m[2] === "m") return Math.round(n * 1_000_000);
	return Math.round(n);
}
function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

// -- AWS / kube context helpers --
function getAwsProfile(): string {
	return (process.env.AWS_VAULT || process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE || "").trim();
}
function shortenAws(name: string): string {
	return !name ? "" : name.length > 12 ? name.slice(0, 12) : name;
}
let kubeCtxCache = "";
let kubeCtxLastRead = 0;
function getKubeContext(): string {
	const now = Date.now();
	if (now - kubeCtxLastRead < 10_000) return kubeCtxCache;
	kubeCtxLastRead = now;
	try {
		const path = process.env.KUBECONFIG?.split(":")[0] || join(homedir(), ".kube", "config");
		let s = readFileSync(path, "utf8").match(/^current-context:\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, "") || "";
		const eksArn = s.match(/^arn:aws:eks:[^:]+:[^:]+:cluster\/(.+)$/);
		if (eksArn) s = eksArn[1];
		else if (s.startsWith("gke_")) {
			const parts = s.split("_");
			if (parts.length >= 4) s = parts[parts.length - 1];
		} else if (s.includes("@") && s.includes(".eksctl.io")) s = (s.split("@")[1] || "").split(".")[0] || s;
		else if (s.includes("/")) s = s.split("/").pop() || s;
		kubeCtxCache = s.length > 18 ? s.slice(0, 18) : s;
	} catch {
		kubeCtxCache = "";
	}
	return kubeCtxCache;
}
function homeRelative(cwd: string): string {
	const home = homedir();
	return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

// -- signals --
type Band = "ok" | "warn" | "bad";
const rank: Record<Band, number> = { ok: 0, warn: 1, bad: 2 };
interface Signals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	lastCost: number;
	ctxTokens: number | null;
	effectiveWindow: number;
	ctxPercent: number | null;
	cacheHit: number | null;
	freshMsLeft: number;
	stale: boolean;
	largeContext: boolean;
}
function computeSignals(ctx: ExtensionContext): Signals {
	let input = 0,
		output = 0,
		cacheRead = 0,
		cacheWrite = 0,
		cost = 0;
	let cacheHit: number | null = null;
	let lastCost = 0;
	try {
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				const u = (e.message as AssistantMessage).usage;
				input += u.input;
				output += u.output;
				cacheRead += u.cacheRead;
				cacheWrite += u.cacheWrite;
				cost += u.cost.total;
				lastCost = u.cost.total;
				const prompt = u.input + u.cacheRead + u.cacheWrite;
				cacheHit = prompt > 0 && u.cacheRead + u.cacheWrite > 0 ? (u.cacheRead / prompt) * 100 : null;
			}
		}
	} catch {
		/* ignore */
	}
	let usage: ReturnType<ExtensionContext["getContextUsage"]>;
	try {
		usage = ctx.getContextUsage();
	} catch {
		usage = undefined;
	}
	const modelWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const effectiveWindow = config.ctxCap ? Math.min(config.ctxCap, modelWindow || config.ctxCap) : modelWindow;
	const ctxTokens = usage?.tokens ?? null;
	const ctxPercent =
		ctxTokens !== null && effectiveWindow > 0 ? Math.min(100, (ctxTokens / effectiveWindow) * 100) : null;
	const freshMsLeft = config.cacheTtlSec * 1000 - (Date.now() - lastActivityMs);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cost,
		lastCost,
		ctxTokens,
		effectiveWindow,
		ctxPercent,
		cacheHit,
		freshMsLeft,
		stale: freshMsLeft <= 0,
		largeContext: (ctxTokens ?? 0) >= LARGE_CONTEXT_TOKENS,
	};
}

async function maybePromptHandoff(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI || promptedThisEpisode) return;
	const s = computeSignals(ctx);
	if (!(s.stale && s.largeContext)) return;
	promptedThisEpisode = true;
	const handoff = await ctx.ui.confirm(
		"Context is stale & large — hand off?",
		`The prompt cache expired and ~${fmtTokens(s.ctxTokens ?? 0)} of context will be re-sent uncached (full price). ` +
			`Yes = start a fresh session now (pick up via /resume + /usage). No = continue here.`,
	);
	if (handoff) {
		const ns = (ctx as unknown as { newSession?: () => Promise<unknown> }).newSession;
		if (typeof ns === "function") {
			try {
				await ns.call(ctx);
				return;
			} catch {
				/* fall through */
			}
		}
		ctx.ui.notify("Run /handoff to start a fresh session (summary is kept for /resume).", "info");
	}
}

export default function customFooter(pi: ExtensionAPI) {
	let showSummary = true;
	let latestCtx: ExtensionContext | null = null;
	let footerCtx: ExtensionContext | null = null;
	let lastDisplayedSummary = "";
	let dotLevel: Band = "ok"; // ratchets up over the session, never back down
	let requestFooterRender: (() => void) | null = null;

	// Persist config.components back to the resolved pi-yuri-extensions.json.
	async function saveComponents(cwd: string): Promise<void> {
		const configPath = await resolvePiYuConfigPath(cwd);
		let existing: Record<string, any> = {};
		try {
			existing = JSON.parse(readFileSync(configPath, "utf8"));
		} catch {
			/* new file */
		}
		existing.customFooter = { ...(existing.customFooter ?? {}), components: config.components };
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
	}

	// -- summary widget above the input --
	function updateSummaryWidget() {
		if (!latestCtx?.hasUI) return;
		if (!showSummary) {
			latestCtx.ui.setWidget("summary-above", undefined);
			return;
		}
		const name = pi.getSessionName();
		if (name && name !== lastDisplayedSummary) {
			lastDisplayedSummary = name;
			latestCtx.ui.setWidget("summary-above", (_tui: any, theme: any) => ({
				render: (width: number) => [theme.fg("dim", "📌 ") + theme.fg("muted", truncateToWidth(name, width - 3))],
				invalidate: () => {},
			}));
		} else if (!name) {
			lastDisplayedSummary = "";
			latestCtx.ui.setWidget("summary-above", undefined);
		}
	}

	// -- custom footer (2 lines + shared plugin-status line) --
	function installFooter(ctx: ExtensionContext) {
		footerCtx = ctx;
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestFooterRender = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			const timer = setInterval(() => tui.requestRender(), 1000); // keep the freshness countdown live
			timer.unref?.();
			return {
				dispose() {
					unsub();
					clearInterval(timer);
				},
				invalidate() {},
				render(width: number): string[] {
					const active = footerCtx;
					if (!active) return [""];
					const s = computeSignals(active);

					const colorOf = (b: Band) => (b === "bad" ? "error" : b === "warn" ? "warning" : "success");
					const ctxBand: Band =
						s.ctxPercent === null ? "ok" : s.ctxPercent > 75 ? "bad" : s.ctxPercent > 50 ? "warn" : "ok";
					const chBand: Band = s.cacheHit === null ? "ok" : s.cacheHit >= 80 ? "ok" : s.cacheHit >= 50 ? "warn" : "bad";
					// Health dot: a ratchet on cumulative session cost — only ever escalates,
					// signalling "this session is getting expensive, start a fresh one."
					const costBand: Band = s.cost >= config.critCost ? "bad" : s.cost >= config.warnCost ? "warn" : "ok";
					if (rank[costBand] > rank[dotLevel]) dotLevel = costBand;
					const dot = dotLevel === "bad" ? "🔴" : dotLevel === "warn" ? "🟡" : "🟢";
					const sep = theme.fg("dim", " · ");

					// -- line 1: health + usage + model --
					const l1: string[] = [];
					if (on("health")) l1.push(dot);
					if (on("context")) {
						if (s.ctxPercent !== null)
							l1.push(theme.fg(colorOf(ctxBand), `🧠 ${s.ctxPercent.toFixed(0)}%/${fmtTokens(s.effectiveWindow)}`));
						else if (s.effectiveWindow > 0) l1.push(theme.fg("dim", `🧠 ?/${fmtTokens(s.effectiveWindow)}`));
					}
					if (on("cacheHit"))
						l1.push(
							s.cacheHit !== null ? theme.fg(colorOf(chBand), `CH${s.cacheHit.toFixed(0)}%`) : theme.fg("dim", "CH —"),
						);
					// Cache-freshness countdown (own colored field; does NOT drive the cost-ratchet dot)
					const staleBand: Band =
						s.stale && s.largeContext ? "bad" : s.freshMsLeft < 60_000 && s.largeContext ? "warn" : "ok";
					if (on("freshness")) {
						if (s.stale && s.largeContext) l1.push(theme.fg("error", `⧗ STALE ${fmtTokens(s.ctxTokens ?? 0)}`));
						else if (s.stale) l1.push(theme.fg("dim", "⧗ stale"));
						else {
							const secs = Math.max(0, Math.floor(s.freshMsLeft / 1000));
							l1.push(
								theme.fg(
									s.largeContext ? colorOf(staleBand) : "dim",
									`⧗ ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`,
								),
							);
						}
					}
					if (on("usage")) {
						const usageBits = [theme.fg("accent", `↑${fmtTokens(s.input)} ↓${fmtTokens(s.output)}`)];
						if (s.cacheRead) usageBits.push(theme.fg("dim", `R${fmtTokens(s.cacheRead)}`));
						if (s.cacheWrite) usageBits.push(theme.fg("dim", `W${fmtTokens(s.cacheWrite)}`));
						usageBits.push(theme.fg("warning", `$${s.cost.toFixed(2)}`));
						if (s.lastCost > 0) usageBits.push(theme.fg("dim", `Δ$${s.lastCost.toFixed(3)}`));
						l1.push(usageBits.join(" "));
					}

					if (on("model")) {
						const thinking = pi.getThinkingLevel();
						const thinkColor =
							thinking === "high" ? "warning" : thinking === "medium" ? "accent" : thinking === "low" ? "dim" : "muted";
						const model = active.model;
						const provider = model && footerData.getAvailableProviderCount() > 1 ? `(${model.provider}) ` : "";
						l1.push(
							theme.fg(thinkColor, "◆") +
								" " +
								theme.fg("dim", provider) +
								theme.fg("accent", model?.id || "no-model") +
								(model?.reasoning ? theme.fg("dim", ` · ${thinking}`) : ""),
						);
					}

					// -- line 2: location + other plugins' statuses --
					const l2: string[] = [];
					if (on("cwd")) l2.push(theme.fg("muted", `⌂ ${homeRelative(active.sessionManager.getCwd())}`));
					const branch = footerData.getGitBranch();
					if (on("git") && branch) l2.push(theme.fg("accent", `⎇ ${branch}`));
					const aws = shortenAws(getAwsProfile());
					if (on("aws") && aws) l2.push(theme.fg("warning", "☁ ") + theme.fg("accent", aws));
					const kube = getKubeContext();
					if (on("kube") && kube) l2.push(theme.fg("success", "⎈ ") + theme.fg("accent", kube));

					const statuses = on("extensions")
						? Array.from(footerData.getExtensionStatuses().entries())
								.sort(([a], [b]) => a.localeCompare(b))
								.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
								.filter(Boolean)
						: [];

					const lines = [truncateToWidth(l1.join(sep), width), truncateToWidth(l2.join(sep), width)];
					if (statuses.length > 0) lines.push(truncateToWidth(statuses.join(sep), width));
					return lines;
				},
			};
		});
	}

	pi.on("session_start", async (_e, ctx) => {
		latestCtx = ctx;
		dotLevel = "ok";
		lastActivityMs = Date.now();
		promptedThisEpisode = false;
		await loadConfig(typeof ctx.cwd === "function" ? ctx.cwd() : ctx.cwd);
		installFooter(ctx);
		updateSummaryWidget();
	});
	pi.on("session_switch", async (_e, ctx) => {
		latestCtx = ctx;
		footerCtx = ctx;
		kubeCtxLastRead = 0;
		dotLevel = "ok";
		lastActivityMs = Date.now();
		promptedThisEpisode = false;
		lastDisplayedSummary = "";
		updateSummaryWidget();
	});
	pi.on("agent_end", async (_e, ctx) => {
		latestCtx = ctx;
		updateSummaryWidget();
	});
	// About-to-send moment: if the cache went stale with a big context, ask first.
	pi.on("turn_start", async (_e, ctx) => {
		footerCtx = ctx;
		await maybePromptHandoff(ctx);
	});
	// Turn finished => cache just (re)written => reset the freshness clock.
	pi.on("turn_end", async (_e, ctx) => {
		footerCtx = ctx;
		lastActivityMs = Date.now();
		promptedThisEpisode = false;
	});

	pi.registerCommand("summary:widget", {
		description: "Show or hide the session summary widget (on/off, no arg toggles)",
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			showSummary = a === "on" ? true : a === "off" ? false : !showSummary;
			latestCtx = ctx;
			updateSummaryWidget();
			ctx.ui.notify(`Summary widget ${showSummary ? "on" : "off"}`, "info");
		},
	});
	pi.registerCommand("footer:ctxcap", {
		description:
			"Override the context cap for THIS session only (e.g. 250k, 1m, off). Persistent default lives in pi-yuri-extensions.json customFooter.ctxCap.",
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			if (a === "off" || a === "" || a === "none") {
				config.ctxCap = null;
				ctx.ui.notify("Context cap cleared for this session — using model window.", "info");
				return;
			}
			const n = parseTokenCount(a);
			if (n === null || n <= 0) {
				ctx.ui.notify(`Invalid cap '${args.trim()}'. Use e.g. 250k, 1m, or off.`, "error");
				return;
			}
			config.ctxCap = n;
			ctx.ui.notify(`Context cap set to ${fmtTokens(n)} for this session only.`, "info");
		},
	});
	pi.registerCommand("footer:toggle", {
		description: "Show/hide individual footer components (interactive menu).",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const cwd = typeof ctx.cwd === "function" ? ctx.cwd() : ctx.cwd;
			// Loop the menu so multiple toggles are done in one sitting.
			for (;;) {
				const labels = COMPONENTS.map((c) => `${on(c.key) ? "[x]" : "[ ]"} ${c.label}`);
				labels.push("Done");
				const choice = await ctx.ui.select("Toggle footer components:", labels);
				if (!choice || choice === "Done") break;
				const idx = labels.indexOf(choice);
				const comp = COMPONENTS[idx];
				if (!comp) break;
				config.components[comp.key] = !on(comp.key);
				requestFooterRender?.();
			}
			await saveComponents(cwd);
			ctx.ui.notify("Footer layout saved.", "info");
		},
	});

	pi.registerCommand("handoff", {
		description: "Start a fresh session now (the current session's summary stays available via /resume).",
		handler: async (_args, ctx) => {
			try {
				await ctx.newSession();
			} catch (e) {
				ctx.ui.notify(`Handoff failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});

	pi.registerMessageRenderer("footer-help", (message) => new Text(message.content, 0, 0));
	pi.registerCommand("footer:help", {
		description: "Explain every field shown in the custom footer.",
		handler: async (_args, ctx) => {
			const t = ctx.ui.theme;
			const h = (s: string) => t.fg("accent", t.bold(s));
			const k = (s: string) => t.fg("success", s);
			const d = (s: string) => t.fg("dim", s);
			const lines = [
				h("Custom footer — field guide"),
				d("─".repeat(52)),
				`${k("🟢/🟡/🔴")}   Session-cost ratchet — escalates as cumulative $ crosses warn/crit thresholds and never drops back. Red = start a fresh session.`,
				`${k("🧠 12%/1.0M")}  Context used vs the effective window ${d("(min(cap, model window); set via /footer:ctxcap)")}.`,
				`${k("CH88%")}       Last-turn cache-hit rate = cacheRead / (input + cacheRead + cacheWrite).`,
				`${d("            ≥ 80 green · 50–80 yellow · <50 red · ‘—’ = no cache activity yet.")}`,
				`${k("⧗ 4:20")}      Cache-freshness countdown — time until the prompt cache expires ${d("(default: customFooter.cacheTtlSec)")}.`,
				`${d("            Resets each turn; at 0 with a large context → ")}${t.fg("error", "⧗ STALE <tokens>")}${d(" (next msg re-sends everything, full price).")}`,
				`${k("↑0 ↓0")}       Cumulative fresh input ↑ and output ↓ tokens this session.`,
				`${k("R15.1M")}      Cumulative tokens READ from cache ${d("(cheap, ~10% of input price)")}.`,
				`${k("W1.3M")}       Cumulative tokens WRITTEN to cache ${d("(one-time, slightly above input price)")}.`,
				`${k("$0.00")}       Cumulative API cost this session.`,
				`${k("Δ$0.030")}     Price of the most recent message ${d("(last completed turn; spikes on a cacheless/STALE message)")}.`,
				`${k("◆ (provider) model · level")}  Model, provider ${d("(shown when >1 provider)")}, and thinking level.`,
				`${k("⌂ ~/DotFiles")} Working directory · ${k("⎇ branch")} git · ${k("☁ aws")} · ${k("⎈ kube")}.`,
				"",
				d("Note: CH% is last-turn only; R/W and cost are cumulative — so ‘CH —’ next to a big R just means the latest turn had no cache read."),
				d(`Dot thresholds: yellow ≥ $${config.warnCost}, red ≥ $${config.critCost} (set customFooter.warnCost / critCost in config).`),
				"",
				h("Commands"),
				`${k("/footer:ctxcap 250k|off")}  cap the context window for this session ${d("(default: customFooter.ctxCap in config)")}`,
				`${k("/summary:widget on|off")}   show/hide the 📌 summary line above the input`,
				`${k("/handoff")}                 start a fresh session now`,
			];
			pi.sendMessage({ customType: "footer-help", content: lines.join("\n"), display: true, details: {} });
		},
	});
}
