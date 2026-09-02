/**
 * budget component — AI Hub daily budget vs limit.
 *
 * Shares one gateway refcount/timer through gateway.ts (with session-cost). Threshold coloring on percent
 * of the limit; reports "attention" through the host when the limit is enabled and spend is at/over it.
 */
import type { StatuslineComponent, StatuslineTheme, ComponentHost } from "../types.ts";
import { color } from "../types.ts";
import { registerComponent } from "../registry.ts";
import { gatewaySnapshot, startGateway } from "../gateway.ts";

type StatuslineColor = Parameters<StatuslineTheme["fg"]>[0];

export interface BudgetConfig {
	enabled: boolean;
	color: StatuslineColor;
	refreshMs: number;
}

const DEFAULT_REFRESH_MS = 120_000;

let host: ComponentHost | undefined;
let attentionActive = false;

const component: StatuslineComponent<BudgetConfig> = {
	name: "budget",
	parseConfig(raw) {
		const input = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<BudgetConfig>;
		if (input.refreshMs !== undefined && (!Number.isFinite(input.refreshMs) || input.refreshMs < 1_000))
			throw new Error("statusline.components.budget.refreshMs must be a number >= 1000");
		return { enabled: input.enabled !== false, color: color(input.color, "statusLineSpend"), refreshMs: input.refreshMs ?? DEFAULT_REFRESH_MS };
	},
	start(componentHost, cfg) {
		host = componentHost;
		const evaluate = () => {
			const { budget } = gatewaySnapshot();
			const over = budget !== undefined && budget.limitEnabled && budget.limitUsd > 0 && budget.spentUsd >= budget.limitUsd;
			if (over !== attentionActive) {
				attentionActive = over;
				host?.setStatus(over ? "attention" : "idle");
			}
		};
		const stop = startGateway({ host: componentHost, refreshMs: cfg.refreshMs, onRefresh: evaluate });
		evaluate();
		return () => {
			stop();
			if (attentionActive) {
				attentionActive = false;
				host?.setStatus("idle");
			}
			host = undefined;
		};
	},
	render(cfg, theme) {
		const { budget } = gatewaySnapshot();
		if (!budget) return "";
		const text = `󰆼 $${budget.spentUsd.toFixed(0)}${budget.limitEnabled ? `/${budget.limitUsd.toFixed(0)}` : ""}`;
		const percent = budget.limitEnabled && budget.limitUsd > 0 ? (budget.spentUsd / budget.limitUsd) * 100 : 0;
		return theme.fg(percent > 75 ? "error" : percent > 50 ? "warning" : cfg.color, text);
	},
};

registerComponent(component);
