/**
 * timeout — cap bash commands so a hung command is interrupted and the
 * session continues, instead of stalling forever.
 *
 * The bash tool already accepts a per-call `timeout` (seconds); pi kills the
 * command when it fires and returns control to the agent. This module just
 * injects a default when the agent didn't set one.
 *
 *   /timeout            show status
 *   /timeout on|off     enable/disable enforcement
 *   /timeout 1m         set duration (30s, 90, 2m, 1h ...). Default 2m.
 *
 * Config (`"timeout"` block in pi-extensions.json):
 *   { "enabled": false, "duration": "2m" }
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { readPiYuConfigFile } from "./lib/config.ts";

let on = false;
let seconds = 120; // 2m default

// "90" | "30s" | "2m" | "1h" -> seconds. null if unparseable.
function parseDuration(s: string): number | null {
  const m = s.trim().match(/^(\d+)\s*(s|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { s: 1, m: 60, h: 3600 }[(m[2] ?? "s").toLowerCase()] ?? 1;
  return n > 0 ? n * mult : null;
}

function fmt(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

async function loadConfig(cwd: string): Promise<void> {
  try {
    const { content } = await readPiYuConfigFile(cwd);
    if (!content) return;
    const cfg = (JSON.parse(content) as { timeout?: { enabled?: boolean; duration?: string } }).timeout;
    if (!cfg) return;
    if (typeof cfg.enabled === "boolean") on = cfg.enabled;
    if (typeof cfg.duration === "string") {
      const sec = parseDuration(cfg.duration);
      if (sec != null) seconds = sec;
    }
  } catch {}
}

export default function timeout(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const c = (ctx as { cwd?: unknown }).cwd;
    const cwd = typeof c === "function" ? (c as () => string)() : (c as string) ?? process.cwd();
    return loadConfig(cwd);
  });

  pi.on("tool_call", (event) => {
    if (!on) return;
    if (isToolCallEventType("bash", event) && event.input.timeout == null) {
      event.input.timeout = seconds;
    }
  });

  pi.registerCommand?.("timeout", {
    description: "Cap bash command duration. Usage: /timeout [on|off|status|<dur>]",
    getArgumentCompletions: () => [
      { value: "on", label: "on", description: "Enforce default timeout on bash" },
      { value: "off", label: "off", description: "Disable enforcement" },
      { value: "status", label: "status", description: "Show current state" },
      { value: "2m", label: "2m", description: "Set duration (e.g. 30s, 90, 2m, 1h)" },
    ],
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      const notify = (msg: string, kind: "info" | "error" = "info") => {
        try { ctx?.ui?.notify?.(msg, kind); } catch {}
      };
      const status = () =>
        on ? `⏱  timeout: ON (${fmt(seconds)})` : "⏱  timeout: OFF";

      if (sub === "" || sub === "status") {
        notify(status());
        return;
      }
      if (sub === "on" || sub === "off") {
        on = sub === "on";
        notify(status());
        return;
      }

      const sec = parseDuration(sub);
      if (sec == null) {
        notify(`timeout: bad arg "${sub}". Try on, off, status, or a duration like 30s/90/2m/1h.`, "error");
        return;
      }
      seconds = sec;
      on = true;
      notify(status());
    },
  });
}

// self-check: bun home/.pi/agent/pi-extensions/extensions/modules/timeout.ts
if (import.meta.main) {
  const eq = (a: unknown, b: unknown, m: string) => { if (a !== b) throw new Error(`${m}: ${a} !== ${b}`); };
  eq(parseDuration("90"), 90, "bare");
  eq(parseDuration("30s"), 30, "s");
  eq(parseDuration("2m"), 120, "m");
  eq(parseDuration("1h"), 3600, "h");
  eq(parseDuration("0"), null, "zero");
  eq(parseDuration("x"), null, "junk");
  eq(fmt(120), "2m", "fmt m");
  eq(fmt(3600), "1h", "fmt h");
  eq(fmt(90), "90s", "fmt s");
  console.log("ok");
}
