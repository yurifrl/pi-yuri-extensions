/**
 * context-limit component — live context usage against the /ctx cap.
 *
 * Data comes from ctx.getContextUsage() each frame (cheap, session-owned); no timers. Threshold coloring:
 * >50% warning, >75% error, unless a color is configured. Also publishes pressure into the host aggregate
 * for the indicator.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { StatuslineComponent, StatuslineTheme } from "../types.ts";
import { registerComponent } from "../registry.ts";

export interface ContextLimitConfig {
	enabled: boolean;
	color: StatuslineColor | "auto";
}

type StatuslineColor = Parameters<StatuslineTheme["fg"]>[0];

type ContextSource = (() => ExtensionContext | undefined) | undefined;

const component: StatuslineComponent<ContextLimitConfig> = {
	name: "contextLimit",
	parseConfig(raw) {
		const input = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<ContextLimitConfig>;
		return { enabled: input.enabled !== false, color: input.color ?? "auto" };
	},
	start(_host, _cfg) {
		return () => {};
	},
	render(cfg, theme) {
		const ctx = currentCtx?.();
		const usage = ctx?.getContextUsage();
		const tokens = usage?.tokens ?? undefined;
		const limit = ctxLimit;
		if (tokens === undefined || !limit) return "";
		const percent = (tokens / limit) * 100;
		const text = `󰆧 ${percent.toFixed(0)}% ${Math.round(tokens / 1_000)}k/${Math.round(limit / 1_000)}`;
		if (cfg.color !== "auto") return theme.fg(cfg.color, text);
		const auto = percent > 75 ? "error" : percent > 50 ? "warning" : "success";
		return theme.fg(auto, text);
	},
};

// Live-context slot shared with the host aggregate; index.ts keeps it pointed at the current session.
let currentCtx: ContextSource;
let ctxLimit: number | undefined;

export function publishContextSource(ctx: ContextSource, limit: number | undefined): void {
	currentCtx = ctx;
	ctxLimit = limit;
}

registerComponent(component);
