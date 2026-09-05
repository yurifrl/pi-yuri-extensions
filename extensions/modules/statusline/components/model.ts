/**
 * model component — active LLM provider (and optionally model id).
 *
 * Data comes from ctx.model each frame (live getter, session-owned); no timers, no I/O. showModel
 * appends the model id after the provider. Absent model hides the segment.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { StatuslineComponent, StatuslineTheme } from "../types.ts";
import { color } from "../types.ts";
import { registerComponent } from "../registry.ts";

export interface ModelConfig {
	enabled: boolean;
	color: Parameters<StatuslineTheme["fg"]>[0];
	/** Append the model id after the provider (e.g. "aihub/glm-5.3-flash"). */
	showModel: boolean;
}

type ContextSource = (() => ExtensionContext | undefined) | undefined;

const component: StatuslineComponent<ModelConfig> = {
	name: "model",
	parseConfig(raw) {
		const input = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<ModelConfig>;
		return {
			enabled: input.enabled !== false,
			color: color(input.color, "accent"),
			showModel: input.showModel ?? false,
		};
	},
	start(_host, _cfg) {
		return () => {};
	},
	render(cfg, theme) {
		const model = currentCtx?.()?.model;
		if (!model) return "";
		const text = cfg.showModel ? `${model.provider}/${model.id}` : model.provider;
		return theme.fg(cfg.color, text);
	},
};

// Live-context slot; index.ts republishes on session_start/switch.
let currentCtx: ContextSource;

export function publishModelContext(ctx: ContextSource): void {
	currentCtx = ctx;
}

registerComponent(component);
