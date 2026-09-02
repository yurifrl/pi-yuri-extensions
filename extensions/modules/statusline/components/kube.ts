/**
 * kube component — current Kubernetes context via `kubectl config current-context`.
 *
 * Refreshes on its own session-scoped interval through the host's live ctx; failure or absence hides the
 * segment. refreshMs/timeoutMs configurable; both validated at session start.
 */
import type { StatuslineComponent, StatuslineTheme, ComponentHost } from "../types.ts";
import { color } from "../types.ts";
import { registerComponent } from "../registry.ts";
import { setIntervalScoped } from "../timers.ts";

export interface KubeConfig {
	enabled: boolean;
	color: StatuslineColor;
	refreshMs: number;
	timeoutMs: number;
}

type StatuslineColor = Parameters<StatuslineTheme["fg"]>[0];

const DEFAULT_REFRESH_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 5_000;

let value: string | undefined;
let host: ComponentHost | undefined;

async function refresh(timeoutMs: number): Promise<void> {
	const ctx = host?.ctx();
	const pi = host?.pi;
	if (!ctx || !pi) return;
	host?.setStatus("refreshing");
	try {
		const result = await pi.exec("kubectl", ["config", "current-context"], { cwd: ctx.cwd, timeout: timeoutMs });
		value = result.code === 0 ? result.stdout.trim() || undefined : undefined;
	} catch {
		value = undefined;
	} finally {
		host?.setStatus("idle");
		host?.redraw();
	}
}

const component: StatuslineComponent<KubeConfig> = {
	name: "kube",
	parseConfig(raw) {
		const input = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<KubeConfig>;
		for (const key of ["refreshMs", "timeoutMs"] as const) {
			const number = input[key];
			if (number !== undefined && (!Number.isFinite(number) || number < 100))
				throw new Error(`statusline.components.kube.${key} must be a number >= 100`);
		}
		return {
			enabled: input.enabled !== false,
			color: color(input.color, "success"),
			refreshMs: input.refreshMs ?? DEFAULT_REFRESH_MS,
			timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		};
	},
	start(componentHost, cfg) {
		host = componentHost;
		const stop = setIntervalScoped(componentHost.ctx(), () => void refresh(cfg.timeoutMs), cfg.refreshMs);
		void refresh(cfg.timeoutMs);
		return () => {
			stop();
			host = undefined;
		};
	},
	render(cfg, theme) {
		if (!value) return "";
		return theme.fg(cfg.color, `⎈ ${value}`);
	},
};

registerComponent(component);
