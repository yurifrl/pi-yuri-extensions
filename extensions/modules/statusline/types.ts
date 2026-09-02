/**
 * Statusline component contracts.
 *
 * A component is a self-registering segment of the status row: it parses its own config block, owns its data
 * acquisition (timers, exec, fetch) through the host, and renders one colored string per frame ("" hides it).
 * The module entry (index.ts) builds one host per component, fans session lifecycle, and renders components in
 * configured order; view.ts joins the row. See .agents/plan/statusline-modular-refactor.md.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { STATUSLINE_COLORS, type StatuslineColor, type YuriExtensionsConfig } from "../config.ts";

/** Terminal theme subset components use to color their segment. */
export interface StatuslineTheme {
	fg(color: StatuslineColor, text: string): string;
}

/** Transient state a component reports through the host; the indicator aggregates them. */
export type ComponentRuntimeState = "idle" | "refreshing" | "attention";

/** Live host snapshot state-driven components (indicator) render from; recomputed per call. */
export interface HostAggregate {
	/** A turn is currently streaming (turn_start..turn_end). */
	working: boolean;
	/** Any component reported "refreshing" and has not cleared it. */
	refreshing: boolean;
	/** Any component reported "attention" (e.g. daily budget reached its limit). */
	attention: boolean;
	/** Live context usage vs ctxLimit in percent, when both are known. */
	pressurePercent?: number;
}

export interface ComponentHost {
	pi: ExtensionAPI;
	/** Always the live session (survives session_switch). */
	ctx(): ExtensionContext | undefined;
	/** Request a TUI re-render after async data changes. */
	redraw(): void;
	/** Report this component's transient state ("idle" clears it). */
	setStatus(state: ComponentRuntimeState): void;
	/** Live host snapshot for state-driven components. */
	aggregate(): HostAggregate;
}

export interface StatuslineComponent<C = unknown> {
	name: string;
	/** Merge the user's config block onto defaults and validate; throw with a reason on invalid values. */
	parseConfig(raw: unknown, shared: YuriExtensionsConfig): C & { enabled: boolean };
	/** Start data acquisition. Return a teardown fn; invoked on session start/switch. */
	start(host: ComponentHost, cfg: C & { enabled: boolean }): () => void;
	/** Current frame value. Must be pure (no I/O, no writes); "" hides the segment this frame. */
	render(cfg: C, theme: StatuslineTheme): string;
}

/**
 * Narrow an unvalidated config value to a statusline color at a component boundary. Returns `fallback`
 * for undefined and unknown values (configs are user JSON; a bad color hides nothing, it just falls back).
 */
export function color(value: unknown, fallback: StatuslineColor): StatuslineColor {
	return STATUSLINE_COLORS.includes(value as StatuslineColor) ? (value as StatuslineColor) : fallback;
}
