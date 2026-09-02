/**
 * AI Hub gateway data — one fetch shared by the budget and session-cost components.
 *
 * Fetches /v1/me/usage (daily budget) and /v1/models (per-token pricing) on the first consumer's start and on a
 * shared interval, retaining the last successful snapshot on failure. Consumers register through startGateway(),
 * which refcounts so both components share one timer and never duplicate the request; teardown when the last
 * consumer leaves. Requires AIHUB_API_KEY; without it the snapshot stays empty and segments hide themselves.
 */
import type { ComponentHost } from "./types.ts";
import { setIntervalScoped } from "./timers.ts";
import type { SessionPrice } from "../budget.ts";

const GATEWAY_URL = "https://ai-llm-gateway.fbr.land";
const TIMEOUT_MS = 5_000;

export type GatewayBudget = { spentUsd: number; limitUsd: number; limitEnabled: boolean };

let budget: GatewayBudget | undefined;
let prices: Record<string, SessionPrice> = {};
let inFlight = false;
let stopTimer: (() => void) | undefined;
let consumers = 0;
const listeners = new Set<() => void>();

export function gatewaySnapshot(): { budget?: GatewayBudget; prices: Record<string, SessionPrice> } {
	return { budget, prices };
}

export interface GatewayOptions {
	host: ComponentHost;
	refreshMs: number;
	/** Called after every completed refresh (success or retained-snapshot failure). */
	onRefresh?: () => void;
}

export function startGateway(options: GatewayOptions): () => void {
	consumers += 1;
	if (options.onRefresh) listeners.add(options.onRefresh);
	if (!stopTimer) {
		stopTimer = setIntervalScoped(options.host.ctx(), () => void refresh(options.host), options.refreshMs);
		void refresh(options.host);
	}
	return () => {
		consumers -= 1;
		if (options.onRefresh) listeners.delete(options.onRefresh);
		if (consumers <= 0) {
			consumers = 0;
			stopTimer?.();
			stopTimer = undefined;
		}
	};
}

async function refresh(host: ComponentHost): Promise<void> {
	if (inFlight) return;
	const apiKey = process.env.AIHUB_API_KEY;
	if (!apiKey) return;
	inFlight = true;
	host.setStatus("refreshing");
	try {
		const headers = { Authorization: `Bearer ${apiKey}` };
		const [usage, models] = await Promise.all([
			fetch(`${GATEWAY_URL}/v1/me/usage`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }),
			fetch(`${GATEWAY_URL}/v1/models`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }),
		]);
		if (usage.ok) {
			const data = (await usage.json()) as { daily_budget?: { spent_usd?: number; limit_usd?: number; limit_enabled?: boolean } };
			if (typeof data.daily_budget?.spent_usd === "number" && typeof data.daily_budget.limit_usd === "number") {
				budget = {
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
			const next: Record<string, SessionPrice> = {};
			for (const model of data.data ?? []) {
				if (!model.id || !model.pricing) continue;
				next[model.id] = {
					input: (model.pricing.prompt ?? 0) * 1_000_000,
					output: (model.pricing.completion ?? 0) * 1_000_000,
					cacheRead: (model.pricing.input_cache_read ?? 0) * 1_000_000,
					cacheWrite: (model.pricing.input_cache_write ?? 0) * 1_000_000,
				};
			}
			prices = next;
		}
	} catch {
		// Retain the last successful gateway snapshot.
	} finally {
		inFlight = false;
		host.setStatus("idle");
		for (const listener of listeners) listener();
		host.redraw();
	}
}
