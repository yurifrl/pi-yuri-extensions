/**
 * pi-beads — run `bd prime` on session_start and session_before_compact and
 * inject its output into the conversation. Mirrors the Claude Code hook:
 *   { hooks: { SessionStart: [bd prime], PreCompact: [bd prime] } }
 *
 * Toggle:
 *   - Global: ~/.pi/agent/extensions/pi-extensions.json → "pi-beads": true|false
 *   - Project override: .pi/extensions/pi-extensions.json → same key
 *   (handled by the pi-extensions hub; this module just runs when loaded)
 *
 * Slash command:
 *   /beads off       disable globally (writes pi-extensions.json + in-memory)
 *   /beads on        enable globally
 *   /beads status    show current state
 *
 * Skips silently when:
 *   - `bd` is not on PATH
 *   - cwd has no `.beads/` directory walking up 8 parents (project not using beads)
 *   - in-memory disabled flag is set (set by `/beads off` for current session)
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const EXEC_TIMEOUT_MS = 8_000;
const GLOBAL_TOGGLE_PATH = join(homedir(), ".pi", "agent", "extensions", "pi-extensions.json");

// In-memory override so /beads off takes effect immediately, not just next session.
let disabled = false;

async function runBdPrime(cwd: string): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    let resolved = false;
    const finish = (v: string | null) => { if (!resolved) { resolved = true; resolve(v); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("bd", ["prime"], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish(null);
      return;
    }
    let stdout = "";
    const t = setTimeout(() => child.kill("SIGKILL"), EXEC_TIMEOUT_MS);
    t.unref?.();
    child.stdout?.on("data", (d) => { stdout += d.toString("utf8"); });
    child.on("error", () => { clearTimeout(t); finish(null); });
    child.on("close", (code) => {
      clearTimeout(t);
      finish(code === 0 ? stdout.trim() : null);
    });
  });
}

function isBeadsProject(cwd: string): boolean {
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".beads"))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

async function prime(pi: ExtensionAPI, ctx: any, reason: string): Promise<void> {
  if (disabled) return;
  const cwd = (typeof ctx?.cwd === "function" ? ctx.cwd() : ctx?.cwd) ?? process.cwd();
  if (!isBeadsProject(cwd)) return;
  const out = await runBdPrime(cwd);
  if (!out) return;
  const message = `<pi-beads trigger="${reason}">\n${out}\n</pi-beads>`;
  try {
    pi.sendUserMessage(message, { deliverAs: "followUp" });
  } catch {
    try { pi.sendUserMessage(message); } catch {}
  }
}

function readToggleConfig(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(GLOBAL_TOGGLE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeToggleConfig(cfg: Record<string, any>): void {
  writeFileSync(GLOBAL_TOGGLE_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function setGlobalEnabled(enabled: boolean): void {
  const cfg = readToggleConfig();
  cfg.extensions = cfg.extensions ?? {};
  cfg.extensions["pi-beads"] = enabled;
  writeToggleConfig(cfg);
}

function getGlobalEnabled(): boolean {
  const cfg = readToggleConfig();
  return cfg?.extensions?.["pi-beads"] !== false;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await prime(pi, ctx, "session_start");
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    await prime(pi, ctx, "session_before_compact");
  });

  pi.registerCommand?.("beads", {
    description: "Toggle beads (bd prime) globally. Usage: /beads [on|off|status]",
    getArgumentCompletions: () => [
      { value: "off",    label: "off",    description: "Disable beads globally" },
      { value: "on",     label: "on",     description: "Enable beads globally" },
      { value: "status", label: "status", description: "Show current state" },
    ],
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      const notify = (msg: string, kind: "success" | "info" | "warning" | "error" = "info") => {
        try { ctx?.ui?.notify?.(msg, kind); } catch {}
        console.log(msg);
      };

      if (sub === "" || sub === "status") {
        const onDisk = getGlobalEnabled();
        const effective = onDisk && !disabled;
        const msg =
          `beads: effective=${effective ? "ON" : "OFF"}  ` +
          `(config=${onDisk ? "on" : "off"}, session-override=${disabled ? "off" : "none"})\n` +
          `config: ${GLOBAL_TOGGLE_PATH}`;
        notify(msg, effective ? "info" : "warning");
        return;
      }

      if (sub === "off") {
        disabled = true;
        try {
          setGlobalEnabled(false);
          notify("🛑 beads: OFF (global config updated; current session disabled too)", "success");
        } catch (e) {
          notify(`beads: disabled in this session, but failed to update config: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        return;
      }

      if (sub === "on") {
        disabled = false;
        try {
          setGlobalEnabled(true);
          notify("✅ beads: ON (global). Reload session if you want bd prime to run now.", "success");
        } catch (e) {
          notify(`beads: enabled in this session, but failed to update config: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        return;
      }

      notify(`beads: unknown subcommand "${sub}". Try /beads, /beads off, /beads on, /beads status.`, "error");
    },
  });
}
