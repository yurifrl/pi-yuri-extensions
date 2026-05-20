/**
 * yes — auto-approve all interactive prompts.
 *
 * The --yes flag is registered by pi-extensions.ts at preboot (the only
 * place registerFlag works). This module reads the flag at session_start.
 *
 * Activation:
 *   pi --yes           CLI flag (registered in pi-extensions.ts)
 *   YES=1 pi           env var
 *   /yes on            slash command (runtime toggle)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Module-scope state — shared with yolo.ts via Node module cache.
let yesOn = false;

export function enableYesMode(): void {
  yesOn = true;
}

export function isYesMode(): boolean {
  return yesOn;
}

function envYes(): boolean {
  const v = process.env.YES?.toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function buildPermissiveUi(realUi: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(realUi, {
    get(target, prop, receiver) {
      if (prop === "custom") return async () => "allow";
      if (prop === "select") {
        return async (_prompt: unknown, options?: readonly unknown[]) => {
          if (Array.isArray(options) && options.length > 0) return options[0];
          return "allow";
        };
      }
      if (prop === "confirm") return async () => true;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });
}

export function patchCtxUiAllow(ctx: { ui: Record<string, unknown> }): void {
  Object.defineProperty(ctx, "ui", {
    value: buildPermissiveUi(ctx.ui),
    configurable: true,
    enumerable: true,
    writable: false,
  });
}

export default function yes(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (pi.getFlag?.("yes") === true || envYes()) {
      yesOn = true;
      try {
        ctx.ui.notify("✅ YES mode: ON (all prompts auto-approved)", "warning");
      } catch {}
    }
  });

  pi.on("tool_call", (_event, ctx) => {
    if (!yesOn) return;
    patchCtxUiAllow(ctx as unknown as { ui: Record<string, unknown> });
  });

  pi.registerCommand?.("yes", {
    description: "Toggle auto-approve mode. Usage: /yes [on|off|status]",
    getArgumentCompletions: () => [
      { value: "on",     label: "on",     description: "Auto-approve all prompts" },
      { value: "off",    label: "off",    description: "Restore normal prompts" },
      { value: "status", label: "status", description: "Show current state" },
    ],
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      const notify = (msg: string, kind: "success" | "info" | "warning" | "error" = "info") => {
        try { ctx?.ui?.notify?.(msg, kind); } catch {}
      };

      if (sub === "status") {
        const text = yesOn ? "✅ YES: ON  (prompts auto-approved)" : "🛡  YES: OFF (prompts active)";
        console.log(text);
        notify(text, yesOn ? "warning" : "info");
        return;
      }

      let target: boolean;
      if (sub === "on")                        target = true;
      else if (sub === "off")                  target = false;
      else if (sub === "" || sub === "toggle") target = !yesOn;
      else {
        const msg = `yes: unknown subcommand "${sub}". Try /yes, /yes on, /yes off, /yes status.`;
        console.log(msg);
        notify(msg, "error");
        return;
      }

      yesOn = target;
      const msg = yesOn ? "✅ YES: ON  (prompts auto-approved)" : "🛡  YES: OFF (prompts active)";
      console.log(msg);
      notify(msg, yesOn ? "warning" : "success");
    },
  });
}
