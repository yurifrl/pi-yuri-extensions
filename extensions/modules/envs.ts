import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readPiYuConfig } from "./lib/config.ts";

// ── Envs module ─────────────────────────────────────────────────────────────
//
// Reads prefixed vars from process.env (already set by shell/cly envs).
// Based on active profile (work|personal|all), composes final env vars:
//   1. GENERAL_FOO → FOO (base layer)
//   2. Profile overlay:
//      - "all": ALL_FOO → FOO
//      - "work": WORK_FOO → FOO
//      - "personal": PERSONAL_FOO → FOO
//
// Command: /envs work | /envs personal | /envs all | /envs status

export type EnvsProfile = "work" | "personal" | "all";

const DEFAULT_PROFILE: EnvsProfile = "all";

function applyProfile(profile: EnvsProfile): number {
  let count = 0;

  // General as base
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith("GENERAL_") && val !== undefined) {
      process.env[key.slice("GENERAL_".length)] = val;
      count++;
    }
  }

  // Profile overlay wins
  const prefix = profile === "all" ? "ALL_" : profile === "work" ? "WORK_" : "PERSONAL_";
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith(prefix) && val !== undefined) {
      process.env[key.slice(prefix.length)] = val;
      count++;
    }
  }

  return count;
}

let activeProfile: EnvsProfile | undefined;
let lastCount = 0;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const cwd = typeof ctx.cwd === "function" ? ctx.cwd() : ctx.cwd ?? process.cwd();
    const { config } = await readPiYuConfig(cwd);
    const ecfg = config.envs ?? {};
    if (ecfg.enabled === false) return;

    const profile = (ecfg.defaultProfile ?? DEFAULT_PROFILE) as EnvsProfile;
    lastCount = applyProfile(profile);
    activeProfile = profile;
  });

  pi.registerCommand("envs", {
    description: "envs: /envs work | /envs personal | /envs all | /envs status",
    getArgumentCompletions: () => [
      { value: "work", label: "work", description: "Switch to work environment" },
      { value: "personal", label: "personal", description: "Switch to personal environment" },
      { value: "all", label: "all", description: "Switch to all environment (ALL_ prefix)" },
      { value: "status", label: "status", description: "Show active profile and loaded vars" },
    ],
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim().toLowerCase();

      if (!raw) {
        ctx.ui.notify?.("envs: /envs work | /envs personal | /envs all | /envs status", "info");
        return;
      }

      if (raw === "status") {
        const msg = activeProfile
          ? `envs: profile=${activeProfile}, ${lastCount} vars applied`
          : `envs: no profile active`;
        ctx.ui.notify?.(msg, "info");
        return;
      }

      if (raw !== "work" && raw !== "personal" && raw !== "all") {
        ctx.ui.notify?.(`envs: unknown profile '${raw}'. Use: work | personal | all | status`, "error");
        return;
      }

      lastCount = applyProfile(raw as EnvsProfile);
      activeProfile = raw as EnvsProfile;
      ctx.ui.notify?.(`envs: switched to ${raw} (${lastCount} vars)`, "success");
    },
  });
}
