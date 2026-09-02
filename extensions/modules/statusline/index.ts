/**
 * Statusline — one-row status widget above the editor (omp's footer is untouched).
 *
 * Architecture: self-registering components (components.ts barrel) render in configured order; index.ts is
 * only lifecycle plumbing — parse each component's config block once per session, start them under per-
 * component hosts, fan session events, join prefix + row. Render never touches the fs. Config comes from
 * pi-yuri-extensions.json `statusline`; see .agents/plan/statusline-modular-refactor.md.
 *
 * prefix: "state" renders the event-driven indicator glyph, "none" no prefix, any other string verbatim.
 * Disable the whole widget: "modules": { "statusline": false }.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readSharedConfig, STATUSLINE_DEFAULT_ORDER, type StatuslineComponentName, type StatuslineConfig } from "../config.ts";
import "./components.ts";
import { getComponent, registeredComponentNames } from "./registry.ts";
import { renderStatusRow } from "./view.ts";
import type { ComponentHost, HostAggregate, StatuslineTheme } from "./types.ts";
import { publishIndicatorHost } from "./components/indicator.ts";
import { publishContextSource } from "./components/context-limit.ts";
import { publishSessionCostContext } from "./components/session-cost.ts";

type ParsedConfig = { enabled: boolean } & Record<string, unknown>;

const parsedConfigs = new Map<string, ParsedConfig>();

export default function statusline(pi: ExtensionAPI): void {
	let redrawing: (() => void) | undefined;
	let teardowns: (() => void)[] = [];
	let latestCtx: ExtensionContext | undefined;
	let ctxLimit: number | undefined;
	let order: StatuslineComponentName[] = STATUSLINE_DEFAULT_ORDER;
	let prefixCfg: NonNullable<StatuslineConfig["prefix"]> = "state";
	let theme: StatuslineTheme | undefined;
	let working = false;
	let refreshingCount = 0;
	let attentionCount = 0;

	const ctxSlot = (): ExtensionContext | undefined => latestCtx;

	const aggregate = (): HostAggregate => {
		const tokens = latestCtx?.getContextUsage()?.tokens ?? undefined;
		return {
			working,
			refreshing: refreshingCount > 0,
			attention: attentionCount > 0,
			pressurePercent: tokens !== undefined && ctxLimit ? (tokens / ctxLimit) * 100 : undefined,
		};
	};

	const hostFor = (name: string): ComponentHost => ({
		pi,
		ctx: ctxSlot,
		redraw: () => redrawing?.(),
		setStatus(state) {
			if (state === "refreshing") refreshingCount += 1;
			else refreshingCount = Math.max(0, refreshingCount - 1);
			if (state === "attention") attentionCount += 1;
			else attentionCount = Math.max(0, attentionCount - 1);
			redrawing?.();
		},
		aggregate,
	});

	function parseAllConfigs(): void {
		const shared = readSharedConfig();
		const statuslineConfig = shared.statusline ?? {};
		ctxLimit = shared.ctxLimit;
		prefixCfg = statuslineConfig.prefix ?? "state";
		order = statuslineConfig.order ?? STATUSLINE_DEFAULT_ORDER;
		const names = new Set<string>(order);
		names.add("indicator"); // prefix always has config even if order omits it
		for (const name of names) {
			const component = getComponent(name);
			if (!component) {
				throw new Error(`statusline.order references unknown component '${name}' (registered: ${registeredComponentNames().join(", ")})`);
			}
			parsedConfigs.set(name, component.parseConfig(statuslineConfig.components?.[name as StatuslineComponentName], shared));
		}
	}

	function startComponents(): void {
		publishIndicatorHost(hostFor("indicator"));
		for (const name of order) {
			const component = getComponent(name);
			const cfg = parsedConfigs.get(name);
			if (!component || !cfg?.enabled) continue;
			teardowns.push(component.start(hostFor(name), cfg));
		}
	}

	function stopComponents(): void {
		for (const teardown of teardowns) teardown();
		teardowns = [];
		working = false;
		refreshingCount = 0;
		attentionCount = 0;
	}

	function renderSegments(): string[] {
		if (!theme) return [];
		const segments: string[] = [];
		for (const name of order) {
			if (name === "indicator") continue; // Prefix-only; renderPrefix renders it.
			const component = getComponent(name);
			const cfg = parsedConfigs.get(name);
			if (!component || !cfg?.enabled) continue;
			const rendered = component.render(cfg, theme);
			if (rendered) segments.push(rendered);
		}
		return segments;
	}

	function renderPrefix(): string {
		if (prefixCfg === "none") return "";
		if (prefixCfg !== "state") return `${prefixCfg} `;
		if (!theme) return "";
		const component = getComponent("indicator");
		const cfg = parsedConfigs.get("indicator");
		if (!component || !cfg?.enabled) return "";
		const rendered = component.render(cfg, theme);
		return rendered ? `${rendered} ` : "";
	}


	pi.on("session_start", (_event, ctx) => {
		parseAllConfigs();
		latestCtx = ctx;
		// Publish live-context slots the pure component render() fns read; republished on every session event.
		publishContextSource(ctxSlot, ctxLimit);
		publishSessionCostContext(ctxSlot);
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(
			"yuri-statusline",
			(tui, widgetTheme) => {
				theme = widgetTheme as unknown as StatuslineTheme;
				redrawing = () => tui.requestRender();
				return {
					invalidate() {},
					render(width: number): string[] {
						const prefix = renderPrefix();
						const prefixWidth = prefix ? [...prefix].length : 0;
						const inner = renderStatusRow(renderSegments(), Math.max(0, width - prefixWidth));
						if (inner.length === 0) return [];
						return [`${prefix}${inner[0]}`];
					},
				};
			},
			{ placement: "aboveEditor" },
		);
		startComponents();
	});
	// omp-only event: lifecycle restarts follow the switched-to session. Widened so the registration
	// typechecks against pi's narrower event map (same pattern as modules/budget.ts).
	const widenedPi = pi as unknown as { on(event: string, handler: (event: never, ctx: ExtensionContext) => void): void };
	widenedPi.on("session_switch", (_event, ctx) => {
		latestCtx = ctx;
		publishContextSource(ctxSlot, ctxLimit);
		publishSessionCostContext(ctxSlot);
		stopComponents();
		if (ctx.hasUI) startComponents();
	});
	pi.on("turn_start", () => {
		if (!working) {
			working = true;
			redrawing?.();
		}
	});
	pi.on("turn_end", (_event, ctx) => {
		latestCtx = ctx;
		working = false;
		redrawing?.();
	});
}
