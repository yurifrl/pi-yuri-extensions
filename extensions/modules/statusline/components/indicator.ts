/**
 * indicator component — event-driven state glyph; "state" prefix renders through it.
 *
 * Priority: attention > pressure (context >50% warning, >75% error) > working > refreshing > ready.
 * State sources: host aggregate (working/refreshing/attention) recomputed per frame; pressure derived from
 * live context usage vs ctxLimit. Disabled when prefix is not "state"; config accepts replacement icons.
 */
import type { StatuslineComponent, StatuslineTheme, ComponentHost } from "../types.ts";
import { registerComponent } from "../registry.ts";

export interface IndicatorConfig {
	enabled: boolean;
	color: "auto";
	icons: Record<"ready" | "working" | "refreshing" | "pressure" | "attention", string>;
}

const DEFAULT_ICONS: IndicatorConfig["icons"] = {
	ready: "󰄾",
	working: "󰙨",
	refreshing: "󰔟",
	pressure: "󰆍",
	attention: "󰅐",
};

const indicator: StatuslineComponent<IndicatorConfig> = {
	name: "indicator",
	parseConfig(raw) {
		const input = (typeof raw === "object" && raw !== null ? raw : {}) as {
			enabled?: boolean;
			color?: unknown;
			icons?: Record<string, unknown>;
		};
		const icons = { ...DEFAULT_ICONS };
		for (const key of Object.keys(DEFAULT_ICONS) as (keyof IndicatorConfig["icons"])[]) {
			const value = input.icons?.[key];
			if (typeof value === "string" && value.length > 0) icons[key] = value;
		}
		return { enabled: input.enabled !== false, color: "auto", icons };
	},
	start(_host, _cfg) {
		return () => {};
	},
	render(cfg, theme) {
		const host: ComponentHost | undefined = currentHost;
		const aggregate = host?.aggregate();
		if (!aggregate) return cfg.icons.ready;
		const pressurePercent = aggregate.pressurePercent;
		const pressure = pressurePercent !== undefined && pressurePercent > 50;
		if (aggregate.attention) return theme.fg("warning", cfg.icons.attention);
		if (pressure) return theme.fg(pressurePercent > 75 ? "error" : "warning", cfg.icons.pressure);
		if (aggregate.working) return cfg.icons.working;
		if (aggregate.refreshing) return cfg.icons.refreshing;
		return cfg.icons.ready;
	},
};

// The indicator renders host state, which only exists while the widget is live; index.ts publishes the
// current host here so the pure render() can read it without carrying it through config.
let currentHost: ComponentHost | undefined;

export function publishIndicatorHost(host: ComponentHost | undefined): void {
	currentHost = host;
}

registerComponent(indicator);
