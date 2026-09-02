/**
 * Statusline view — pure rendering for the status widget: segments in, colored row out.
 *
 * No I/O and no state — the caller passes config plus a snapshot (context tokens, budget, cost text, AWS, kube) and a
 * theme, and gets the joined segment string. Context and budget segments shift to warning/error past 50%/75% of their
 * limit unless a color is configured; empty segments drop out.
 */
import {
  STATUSLINE_DEFAULT_SEGMENTS,
  type StatuslineColor,
  type StatuslineSegmentName,
  type StatuslineSegment,
  type YuriExtensionsConfig,
} from "../config.ts";

export type StatuslineBudget = { spentUsd: number; limitUsd: number; limitEnabled: boolean };

export interface StatuslineSnapshot {
	contextTokens?: number;
	budget?: StatuslineBudget;
	cost?: string;
	aws?: string;
	kube?: string;
}

export interface StatuslineTheme {
	fg(color: StatuslineColor, text: string): string;
}

const DEFAULT_COLORS: Record<StatuslineSegmentName, StatuslineColor> = {
	contextLimit: "statusLineContext",
	budget: "statusLineSpend",
	sessionCost: "statusLineCost",
	aws: "warning",
	kube: "success",
};

function thresholdColor(percent: number): StatuslineColor {
	return percent > 75 ? "error" : percent > 50 ? "warning" : "success";
}

function formatContext(tokens: number | undefined, limit: number | undefined): string {
	if (tokens === undefined || !limit) return "";
	return `󰆧 ${((tokens / limit) * 100).toFixed(0)}% ${Math.round(tokens / 1_000)}k/${Math.round(limit / 1_000)}k`;
}

function formatBudget(budget: StatuslineBudget | undefined): string {
	if (!budget) return "";
	return `󰆼 $${budget.spentUsd.toFixed(0)}${budget.limitEnabled ? `/${budget.limitUsd.toFixed(0)}` : ""}`;
}

function resolveColor(
	segment: StatuslineSegmentName,
	configured: StatuslineColor | undefined,
	contextPercent: number,
	budgetPercent: number,
): StatuslineColor {
	if (segment === "contextLimit") return thresholdColor(contextPercent);
	if (configured) return configured;
	if (segment === "budget") return thresholdColor(budgetPercent);
	return DEFAULT_COLORS[segment];
}

export function renderStatusline(config: YuriExtensionsConfig, snapshot: StatuslineSnapshot, theme: StatuslineTheme): string {
	const contextPercent = config.ctxLimit && snapshot.contextTokens ? (snapshot.contextTokens / config.ctxLimit) * 100 : 0;
	const budgetPercent =
		snapshot.budget?.limitEnabled && snapshot.budget.limitUsd > 0 ? (snapshot.budget.spentUsd / snapshot.budget.limitUsd) * 100 : 0;
	const values: Record<StatuslineSegmentName, string> = {
		contextLimit: formatContext(snapshot.contextTokens, config.ctxLimit),
		budget: formatBudget(snapshot.budget),
		sessionCost: snapshot.cost ?? "",
		aws: snapshot.aws ? `☁ ${snapshot.aws}` : "",
		kube: snapshot.kube ? `⎈ ${snapshot.kube}` : "",
	};
	const segments = (config.statusline?.segments ?? STATUSLINE_DEFAULT_SEGMENTS).flatMap(({ name, color, enabled }) => {
		if (enabled === false) return [];
		const value = values[name];
		return value ? [theme.fg(resolveColor(name, color, contextPercent, budgetPercent), value)] : [];
	});
	return segments.join("  ");
}
