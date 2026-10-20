/**
 * context-limit component — live context usage against the /ctx cap.
 *
 * Data comes from ctx.getContextUsage() each frame (cheap, session-owned); no timers. The cap comes from
 * ctxLimitSignal (modules/ctx.ts) so /ctx changes show on the next frame. Once the learned gauge→real
 * calibration is available, the segment appends " ≈Nk" — the provider-true size of the current fill
 * (omp's own estimate over-reads, ×2–3.7 on glm). Threshold coloring:
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
type LimitSource = (() => number | undefined) | undefined;
type RatioSource = (() => number | undefined) | undefined;

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
		const limit = ctxLimit?.();
		const ratio = ctxRatio?.();
		if (tokens === undefined || !limit) return "";
		const percent = (tokens / limit) * 100;
		const real = ratio !== undefined && ratio > 1 ? Math.round(tokens / ratio) : undefined;
		const text = `󰆧 ${percent.toFixed(0)}% ${Math.round(tokens / 1_000)}k/${Math.round(limit / 1_000)}${real === undefined ? "" : ` ≈${Math.round(real / 1_000)}k`}`;
		if (cfg.color !== "auto") return theme.fg(cfg.color, text);
		const auto = percent > 75 ? "error" : percent > 50 ? "warning" : "success";
		return theme.fg(auto, text);
	},
};

// Live-context slot shared with the host aggregate; index.ts keeps it pointed at the current session.
let currentCtx: ContextSource;
let ctxLimit: LimitSource;
let ctxRatio: RatioSource;

export function publishContextSource(ctx: ContextSource, limit: LimitSource, ratio?: RatioSource): void {
	currentCtx = ctx;
	ctxLimit = limit;
	ctxRatio = ratio;
}

registerComponent(component);
