/**
 * Context limit — an artificial token cap that keeps live context healthy and small.
 *
 * Checked at turn end: at the cap, action "compact" fires a compaction (detached — awaiting it inside the event would
 * deadlock the agent loop — and re-armed on failure so a transient error never disables the cap) and action "stop"
 * aborts the run. The trigger re-arms whenever usage falls back below the limit.
 *
 * /ctx — visual picker (arrows ±50k, digits = thousands, "o" off) · /ctx set 100k|1m · /ctx action compact|stop ·
 * /ctx status · /ctx off. Persists ctxLimit and ctxLimitAction in pi-yuri-extensions.json. Disable: "modules": { "ctx": false }.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readSharedConfig, writeSharedConfig } from "../config.ts";

type LimitAction = "compact" | "stop";

const STEP = 50_000;
const MAX_LIMIT = 2_000_000;
let limit: number | undefined;
let action: LimitAction = "compact";
let armed = true;

function parseTokens(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
	return Number.isFinite(amount) && amount > 0 ? Math.round(amount * multiplier) : undefined;
}

export function formatTokens(tokens: number | null | undefined): string {
	if (tokens === null) return "off";
	if (tokens === undefined) return "off";
	if (tokens < 1_000) return `${tokens}`;
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}m`;
	return `${Math.round(tokens / 1_000)}k`;
}

function gradient(position: number): string {
	const start = position <= 0.5 ? [46, 204, 113] : [241, 196, 15];
	const end = position <= 0.5 ? [241, 196, 15] : [231, 76, 60];
	const progress = position <= 0.5 ? position * 2 : (position - 0.5) * 2;
	const color = start.map((value, index) => Math.round(value + (end[index]! - value) * progress));
	return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m`;
}

function renderBar(value: number, max: number, width: number): string {
	const cells = Math.max(16, Math.min(56, width - 10));
	const filled = Math.round((value / max) * cells);
	let bar = "";
	for (let index = 0; index < cells; index++)
		bar += index < filled ? `${gradient(index / Math.max(1, cells - 1))}█` : "\x1b[38;2;70;70;80m░";
	return `${bar}\x1b[0m`;
}

function persist(): void {
	writeSharedConfig({ ...readSharedConfig(), ctxLimit: limit, ctxLimitAction: action });
}

async function pickLimit(ctx: ExtensionContext): Promise<number | null> {
	const usage = ctx.getContextUsage();
	const currentTokens = usage?.tokens;
	const max = usage?.contextWindow ?? ctx.model?.contextWindow ?? MAX_LIMIT;
	const initial = Math.min(limit ?? 0, max);
	return ctx.ui.custom(
		(tui, theme, _keys, done) => {
			let value = initial;
			let typed = "";
			const clamp = (next: number) => Math.max(0, Math.min(max, next));
			const redraw = () => tui.requestRender();
			return {
				invalidate() {},
				handleInput(data: string) {
					if (data === "\x1b") return done(null);
					if (data === "\r" || data === "\n") return done(value);
					if (data === "\x1b[A" || data === "\x1b[C" || data === "+" || data === "=") {
						typed = "";
						value = clamp(Math.round(value / STEP) * STEP + STEP);
					} else if (data === "\x1b[B" || data === "\x1b[D" || data === "-") {
						typed = "";
						value = clamp(Math.round(value / STEP) * STEP - STEP);
					} else if (data.toLowerCase() === "o") {
						typed = "";
						value = 0;
					} else if (data === "\x7f") {
						typed = typed.slice(0, -1);
						value = clamp(Number(typed || 0) * 1_000);
					} else if (/^\d$/.test(data)) {
						typed = `${typed}${data}`.slice(0, 5);
						value = clamp(Number(typed) * 1_000);
					}
					redraw();
				},
				render(width: number): string[] {
					const cells = Math.max(16, Math.min(56, width - 16));
					const percentage = Math.round((value / max) * 100);
					const currentPosition =
						currentTokens == null
							? undefined
							: Math.max(0, Math.min(cells - 1, Math.round((currentTokens / max) * (cells - 1))));
					const marker =
						currentPosition === undefined
							? ""
							: `  ${" ".repeat(currentPosition)}${theme.fg("accent", "▲")} ${theme.fg("dim", `now ${formatTokens(currentTokens)}`)}`;
					const scale = `  ${theme.fg("dim", "0")}${" ".repeat(Math.max(1, cells - formatTokens(max).length - 1))}${theme.fg("dim", formatTokens(max))}`;
					const typedHint = typed ? theme.fg("accent", `typing: ${typed}k`) : theme.fg("dim", "type digits = k");
					return [
						"",
						`  ${theme.fg("accent", theme.bold("Context limit"))}  ${theme.fg("dim", "compacts when live context reaches the cap")}`,
						"",
						`  ${renderBar(value, max, width)}  ${theme.fg("accent", theme.bold(value ? `${formatTokens(value)} · ${percentage}%` : "OFF"))}`,
						scale,
						marker,
						"",
						`  ${theme.fg("dim", "↑/→ +50k   ↓/← −50k   ")}${typedHint}${theme.fg("dim", "   o off   enter save   esc cancel")}`,
						"",
					];
				},
			};
		},
		{ overlay: true },
	);
}

export default function contextLimit(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const config = readSharedConfig();
		limit = config.ctxLimit;
		action = config.ctxLimitAction ?? "compact";
		armed = true;
	});
	pi.on("turn_end", (_event, ctx) => {
		if (limit === undefined) return;
		const usage = ctx.getContextUsage();
		if (usage === undefined || usage.tokens === null || usage.tokens < limit) {
			armed = true;
			return;
		}
		if (action === "stop") {
			if (armed) ctx.ui.notify(`Context limit ${formatTokens(limit)} reached (${formatTokens(usage.tokens)}). Run stopped.`, "error");
			armed = false;
			ctx.abort();
			return;
		}
		if (!armed) return;
		armed = false;
		ctx.ui.notify(`Context limit ${formatTokens(limit)} reached (${formatTokens(usage.tokens)}). Compacting.`, "warning");
		// `session.compact()` aborts the live run and waits for the agent to go idle;
		// awaiting it here would deadlock, because the agent loop is itself awaiting
		// this handler. Detach it, and re-arm on failure so a transient error
		// ("Nothing to compact", "Compaction already in progress") does not silently
		// disable the cap for the rest of the session.
		const result = ctx.compact() as unknown;
		if (result instanceof Promise)
			result.catch((error: unknown) => {
				armed = true;
				const message = `Context limit compaction failed: ${error instanceof Error ? error.message : String(error)}`;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				});
	});
	pi.registerCommand("ctx", {
		description: "Set an artificial context cap; bare /ctx opens the visual picker",
		handler: async (args, ctx) => {
			const [command, value] = args.trim().toLowerCase().split(/\s+/, 2);
			if (command === undefined || command === "") {
				const selected = await pickLimit(ctx);
				if (selected === null) return;
				limit = selected || undefined;
			} else if (command === "status") {
				ctx.ui.notify(`Context limit: ${formatTokens(limit)} · action: ${action}`, "info");
				return;
			} else if (command === "off") limit = undefined;
			else if (command === "set") {
				const parsed = parseTokens(value ?? "");
				if (parsed === undefined) {
					ctx.ui.notify("Use /ctx set 100k, /ctx set 1m, or /ctx off.", "error");
					return;
				}
				limit = parsed;
			} else if (command === "action" && (value === "compact" || value === "stop")) action = value;
			else {
				ctx.ui.notify("Usage: /ctx [set 100k|action compact|stop|off|status]", "error");
				return;
			}
			armed = true;
			persist();
			ctx.ui.notify(`Context limit: ${formatTokens(limit)} · action: ${action}`, "info");
		},
	});
}
