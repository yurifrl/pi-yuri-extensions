/**
 * session-cost component — session spend with per-message average.
 *
 * Computes from the live session branch via sessionSpend() (shared with the budget module) and gateway
 * pricing (shared refcount through gateway.ts). showZero=false hides the segment until the first message.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { color, type StatuslineComponent, type StatuslineTheme } from "../types.ts";
import { registerComponent } from "../registry.ts";
import { gatewaySnapshot, startGateway } from "../gateway.ts";
import { sessionSpend } from "../../budget.ts";

export interface SessionCostConfig {
	enabled: boolean;
	color: Parameters<StatuslineTheme["fg"]>[0];
	showZero: boolean;
	refreshMs: number;
}

type ContextSource = (() => ExtensionContext | undefined) | undefined;

const DEFAULT_REFRESH_MS = 120_000;

const formatUsd = (value: number): string => (value < 0.01 ? value.toFixed(4) : value.toFixed(2));

const component: StatuslineComponent<SessionCostConfig> = {
	name: "sessionCost",
	parseConfig(raw) {
		const input = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<SessionCostConfig>;
		if (input.refreshMs !== undefined && (!Number.isFinite(input.refreshMs) || input.refreshMs < 1_000))
			throw new Error("statusline.components.sessionCost.refreshMs must be a number >= 1000");
		return {
			enabled: input.enabled !== false,
			color: color(input.color, "statusLineCost"),
			showZero: input.showZero ?? true,
			refreshMs: input.refreshMs ?? DEFAULT_REFRESH_MS,
		};
	},
	start(host, cfg) {
		return startGateway({ host, refreshMs: cfg.refreshMs });
	},
	render(cfg, theme) {
		const ctx = hostCtx?.();
		if (!ctx) return "";
		const { prices } = gatewaySnapshot();
		const spend = sessionSpend(ctx, prices);
		if (!cfg.showZero && spend.messages === 0) return "";
		const average = spend.messages > 0 ? spend.total / spend.messages : 0;
		return theme.fg(cfg.color, `󰔛 $${formatUsd(spend.total)} · ~$${formatUsd(average)}/msg`);
	},
};

// Live-context slot; index.ts republishes on session_start/switch.
let hostCtx: ContextSource;

export function publishSessionCostContext(ctx: ContextSource): void {
	hostCtx = ctx;
}

registerComponent(component);
