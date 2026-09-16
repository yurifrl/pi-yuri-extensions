/**
 * sessionMemory component — current session memory (process RSS).
 *
 * The extension runs inside the agent's process, so process.memoryUsage().rss is the session's memory
 * consumption. Samples on a session-scoped interval and renders as `󰍛 412M` / `󰍛 1.2G`; hidden until the
 * first sample.
 */
import type { ComponentHost, StatuslineComponent, StatuslineTheme } from "../types.ts";
import { color } from "../types.ts";
import { registerComponent } from "../registry.ts";
import { setIntervalScoped } from "../timers.ts";

export interface SessionMemoryConfig {
	enabled: boolean;
	color: Parameters<StatuslineTheme["fg"]>[0];
	refreshMs: number;
}

const DEFAULT_REFRESH_MS = 10_000;

function formatMemory(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.round(mb)}M`;
}

let rssBytes: number | undefined;
let host: ComponentHost | undefined;

function sample(): void {
	rssBytes = process.memoryUsage().rss;
	host?.redraw();
}

const component: StatuslineComponent<SessionMemoryConfig> = {
	name: "sessionMemory",
	parseConfig(raw) {
		const input = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<SessionMemoryConfig>;
		if (input.refreshMs !== undefined && (!Number.isFinite(input.refreshMs) || input.refreshMs < 1_000))
			throw new Error("statusline.components.sessionMemory.refreshMs must be a number >= 1000");
		return {
			enabled: input.enabled !== false,
			color: color(input.color, "accent"),
			refreshMs: input.refreshMs ?? DEFAULT_REFRESH_MS,
		};
	},
	start(componentHost, cfg) {
		host = componentHost;
		const stop = setIntervalScoped(componentHost.ctx(), sample, cfg.refreshMs);
		sample();
		return () => {
			stop();
			host = undefined;
		};
	},
	render(cfg, theme) {
		if (rssBytes === undefined) return "";
		return theme.fg(cfg.color, `󰍛 ${formatMemory(rssBytes)}`);
	},
};

registerComponent(component);
