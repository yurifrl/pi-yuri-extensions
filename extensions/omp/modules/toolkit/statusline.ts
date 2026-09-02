/**
 * Statusline — one-row status widget above the editor (omp's footer is untouched).
 *
 * Segments: context usage against the /ctx cap, AI Hub daily budget vs limit, session cost with per-message average,
 * AWS profile (env), Kubernetes context (kubectl). Gateway budget/pricing refresh every 2 min via a live-context slot
 * so refreshes follow the current session; turn ends redraw immediately. Config is cached for the whole session —
 * render never touches the fs. All collection is best-effort: missing env, CLI, or key just hides the segment.
 *
 * Rendering lives in statusline-view.ts; segments/order/colors configure via pi-yuri-extensions.json. Requires AIHUB_API_KEY for
 * the budget segment. Disable: "modules": { "statusline": false }.
 */
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, type ToolkitConfig } from "./config.ts";
import { renderStatusline, type StatuslineBudget } from "./statusline-view.ts";
import { sessionSpend, type SessionPrice } from "./budget.ts";

const GATEWAY_URL = "https://ai-llm-gateway.fbr.land";
const REFRESH_MS = 120_000;

type Price = SessionPrice;

type State = {
	budget?: StatuslineBudget;
	prices: Record<string, Price>;
	aws?: string;
	kube?: string;
};

async function refresh(state: State, pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	state.aws = process.env.AWS_VAULT || process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE || undefined;
	try {
		const result = await pi.exec("kubectl", ["config", "current-context"], { cwd: ctx.cwd, timeout: 5_000 });
		state.kube = result.code === 0 ? result.stdout.trim() || undefined : undefined;
	} catch {
		state.kube = undefined;
	}

	const apiKey = process.env.AIHUB_API_KEY;
	if (!apiKey) return;
	try {
		const [usage, models] = await Promise.all([
			fetch(`${GATEWAY_URL}/v1/me/usage`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5_000) }),
			fetch(`${GATEWAY_URL}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5_000) }),
		]);
		if (usage.ok) {
			const data = (await usage.json()) as { daily_budget?: { spent_usd?: number; limit_usd?: number; limit_enabled?: boolean } };
			if (typeof data.daily_budget?.spent_usd === "number" && typeof data.daily_budget.limit_usd === "number") {
				state.budget = {
					spentUsd: data.daily_budget.spent_usd,
					limitUsd: data.daily_budget.limit_usd,
					limitEnabled: data.daily_budget.limit_enabled === true,
				};
			}
		}
		if (models.ok) {
			const data = (await models.json()) as {
				data?: {
					id?: string;
					pricing?: { prompt?: number; completion?: number; input_cache_read?: number; input_cache_write?: number };
				}[];
			};
			state.prices = {};
			for (const model of data.data ?? []) {
				if (!model.id || !model.pricing) continue;
				state.prices[model.id] = {
					input: (model.pricing.prompt ?? 0) * 1_000_000,
					output: (model.pricing.completion ?? 0) * 1_000_000,
					cacheRead: (model.pricing.input_cache_read ?? 0) * 1_000_000,
					cacheWrite: (model.pricing.input_cache_write ?? 0) * 1_000_000,
				};
			}
		}
	} catch {
		// Retain the last successful gateway snapshot.
	}
}

export default function statusline(pi: ExtensionAPI): void {
	const state: State = { prices: {} };
	let redraw: (() => void) | undefined;
	// C22: config reads (fs + JSON.parse + validation) must not run per TUI frame.
	// Cache for the whole session; invalidated on session_start (the only place this
	// module's config-affecting fields can change through the plugin's own commands).
	let cachedConfig: ToolkitConfig | undefined;
	const configCache = (): ToolkitConfig => (cachedConfig ??= loadConfig(pi.pi.settings.getAgentDir()));

	function sessionCostText(ctx: ExtensionContext): string {
		const spend = sessionSpend(ctx, state.prices);
		const average = spend.messages > 0 ? spend.total / spend.messages : 0;
		return `󰔛 $${spend.total < 0.01 ? spend.total.toFixed(4) : spend.total.toFixed(2)} · ~$${average < 0.01 ? average.toFixed(4) : average.toFixed(2)}/msg`;
	}

	let latestCtx: ExtensionContext | undefined;
	// The 120s interval reads this slot instead of a captured ctx, so refreshes always
	// target the current session (a session_start capture would survive session_switch).
	const setLatestCtx = (ctx: ExtensionContext) => {
		latestCtx = ctx;
	};

	function update(): void {
		const ctx = latestCtx;
		if (!ctx) return;
		void refresh(state, pi, ctx).then(() => redraw?.());
	}

	pi.on("session_start", (_event, ctx) => {
		// Fresh config per session; cached for the whole session so render() never touches the fs.
		cachedConfig = undefined;
		if (!ctx.hasUI) return;
		setLatestCtx(ctx);
		ctx.ui.setWidget(
			"toolkit-statusline",
			(tui, theme) => {
				redraw = () => tui.requestRender();
				return {
					invalidate() {},
					render(width: number): string[] {
						const active = latestCtx;
						if (!active) return [];
						const line = truncateToWidth(
							renderStatusline(
								configCache(),
								{
									contextTokens: active.getContextUsage()?.tokens,
									budget: state.budget,
									cost: sessionCostText(active),
									aws: state.aws,
									kube: state.kube,
								},
								theme,
							),
							width,
						);
						return [" ".repeat(Math.max(0, width - visibleWidth(line))) + line];
					},
				};
			},
			{ placement: "aboveEditor" },
		);
		update();
		ctx.setInterval(update, REFRESH_MS);
	});
	pi.on("session_switch", (_event, ctx) => {
		setLatestCtx(ctx);
		update();
	});
	pi.on("turn_end", (_event, ctx) => {
		setLatestCtx(ctx);
		redraw?.();
	});
}
