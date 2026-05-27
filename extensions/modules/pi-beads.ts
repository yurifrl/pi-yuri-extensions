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
 * Skips silently when:
 *   - `bd` is not on PATH
 *   - cwd has no `.beads/` directory walking up 8 parents (project not using beads)
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

const EXEC_TIMEOUT_MS = 8_000;

async function runBdPrime(cwd: string): Promise<string | null> {
  // Run `bd prime` and capture stdout.
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

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await prime(pi, ctx, "session_start");
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    await prime(pi, ctx, "session_before_compact");
  });
}
