/**
 * Thinking — set the session's reasoning effort level.
 *
 * /thinking [level] applies off|minimal|low|medium|high|xhigh|max immediately and reports the value the model actually
 * accepted, warning when it was clamped to the model's limit. Bare /thinking opens a picker (or prints the current
 * level non-interactively); argument completion suggests the levels. Disable: "modules": { "thinking": false }.
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";

const LEVELS: readonly ThinkingLevel[] = Object.values(ThinkingLevel).filter((v): v is ThinkingLevel => v !== "inherit");

function applyLevel(pi: ExtensionAPI, level: ThinkingLevel, ctx: ExtensionCommandContext): void {
	pi.setThinkingLevel(level);
	const actual = pi.getThinkingLevel();
	if (actual !== level) {
		ctx.ui.notify(`Thinking level clamped to ${actual} (model limit)`, "warning");
	} else {
		ctx.ui.notify(`Thinking level: ${actual}`, "info");
	}
}

export default function thinking(pi: ExtensionAPI): void {
	pi.registerCommand("thinking", {
		description: "Pick or set the thinking level (off|minimal|low|medium|high|xhigh|max)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const prefixValue = prefix.trim().toLowerCase();
			const items = LEVELS.filter((l) => l.startsWith(prefixValue)).map((l) => ({
				value: l,
				label: l,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();

			if (!arg) {
				if (ctx.model && !ctx.model.reasoning) {
					ctx.ui.notify("Thinking is unavailable for this model", "info");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify(`Thinking level: ${pi.getThinkingLevel()}`, "info");
					return;
				}
				const current = pi.getThinkingLevel();
				const items = LEVELS.map((l) => (l === current ? `${l} (current)` : l));
				const choice = await ctx.ui.select(`Thinking level (current: ${current}):`, items);
				if (!choice) return;
				applyLevel(pi, choice.replace(" (current)", "") as ThinkingLevel, ctx);
				return;
			}

			if (!LEVELS.includes(arg as ThinkingLevel)) {
				ctx.ui.notify(`Invalid level "${arg}". Use: ${LEVELS.join(", ")}`, "error");
				return;
			}

			applyLevel(pi, arg as ThinkingLevel, ctx);
		},
	});
}
