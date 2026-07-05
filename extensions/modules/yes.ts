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

export function disableYesMode(): void {
  yesOn = false;
}

export function isYesMode(): boolean {
  return yesOn;
}

function envYes(): boolean {
  const v = process.env.YES?.toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Saved original methods per shared ui object, so patching is reversible.
type UiMethods = { custom?: unknown; select?: unknown; confirm?: unknown };
const originalUi = new WeakMap<object, UiMethods>();

function setMethod(ui: Record<string, unknown>, name: string, fn: unknown): void {
  try {
    ui[name] = fn;
  } catch {
    // Property may be non-writable (e.g. a class accessor). Force it.
    Object.defineProperty(ui, name, { value: fn, configurable: true, writable: true });
  }
}

// Mutate the shared uiContext object IN PLACE so every extension that later
// calls ctx.ui.custom/select/confirm (including guardrails) gets auto-approve,
// regardless of tool_call handler ordering. Patching the per-ctx object inside
// a tool_call handler races guardrails' own handler; mutating the shared object
// at session_start does not.
export function patchCtxUiAllow(ctx: { ui: Record<string, unknown> }): void {
  const ui = ctx?.ui;
  if (!ui || typeof ui !== "object") return;
  if (!originalUi.has(ui)) {
    originalUi.set(ui, { custom: ui.custom, select: ui.select, confirm: ui.confirm });
  }
  setMethod(ui, "custom", async () => "allow");
  setMethod(ui, "select", async (_prompt: unknown, options?: readonly unknown[]) =>
    Array.isArray(options) && options.length > 0 ? options[0] : "allow",
  );
  setMethod(ui, "confirm", async () => true);
}

export function unpatchCtxUi(ctx: { ui: Record<string, unknown> }): void {
  const ui = ctx?.ui;
  if (!ui || typeof ui !== "object") return;
  const saved = originalUi.get(ui);
  if (!saved) return;
  setMethod(ui, "custom", saved.custom);
  setMethod(ui, "select", saved.select);
  setMethod(ui, "confirm", saved.confirm);
  originalUi.delete(ui);
}

export default function yes(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (pi.getFlag?.("yes") === true || envYes()) {
      yesOn = true;
    }
    if (yesOn) {
      // Patch the shared ui now, before any tool_call fires.
      patchCtxUiAllow(ctx as unknown as { ui: Record<string, unknown> });
      try {
        ctx.ui.notify("✅ YES mode: ON (all prompts auto-approved)", "warning");
      } catch {}
    }
  });

  pi.on("tool_call", (_event, ctx) => {
    // Backup: re-assert the patch in case the ui object was rebound mid-session.
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
      const uiCtx = ctx as unknown as { ui: Record<string, unknown> };
      if (target) patchCtxUiAllow(uiCtx);
      else unpatchCtxUi(uiCtx);
      const msg = yesOn ? "✅ YES: ON  (prompts auto-approved)" : "🛡  YES: OFF (prompts active)";
      console.log(msg);
      notify(msg, yesOn ? "warning" : "success");
    },
  });
}
