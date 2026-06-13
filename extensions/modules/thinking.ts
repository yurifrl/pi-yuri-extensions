import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type Level = (typeof LEVELS)[number];

export default function (pi: ExtensionAPI) {
  pi.registerCommand("thinking", {
    description: "Get or set the thinking level (off|minimal|low|medium|high|xhigh)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items = LEVELS.filter((l) => l.startsWith(prefix.trim().toLowerCase())).map((l) => ({
        value: l,
        label: l,
      }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();

      if (!arg) {
        ctx.ui.notify(`Thinking level: ${pi.getThinkingLevel()}`, "info");
        return;
      }

      if (!LEVELS.includes(arg as Level)) {
        ctx.ui.notify(`Invalid level "${arg}". Use: ${LEVELS.join(", ")}`, "error");
        return;
      }

      pi.setThinkingLevel(arg as Level);
      const actual = pi.getThinkingLevel();
      if (actual !== arg) {
        ctx.ui.notify(`Thinking level clamped to ${actual} (model limit)`, "warning");
      } else {
        ctx.ui.notify(`Thinking level: ${actual}`, "success");
      }
    },
  });
}
