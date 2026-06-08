/**
 * git-wip — run `cly gc --yolo` to quickly commit all changes as WIP.
 *
 * Usage: /git wip
 *   Commits all uncommitted changes with a "wip" commit message using cly.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";

const TIMEOUT_MS = 30_000;

interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function runClyGcYolo(cwd: string): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let resolved = false;
    const finish = (v: RunResult) => {
      if (!resolved) {
        resolved = true;
        resolve(v);
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("cly", ["gc", "--yolo"], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      finish({
        ok: false,
        code: null,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    let stdout = "";
    let stderr = "";

    const t = setTimeout(() => {
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    t.unref?.();

    child.stdout?.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString("utf8");
    });

    child.on("error", (e) => {
      clearTimeout(t);
      finish({
        ok: false,
        code: null,
        stdout,
        stderr: stderr || e.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(t);
      finish({
        ok: code === 0,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function notify(ctx: any, msg: string, kind: "success" | "info" | "warning" | "error" = "info") {
  try {
    ctx?.ui?.notify?.(msg, kind);
  } catch {}
  try {
    console.log(msg);
  } catch {}
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("git", {
    description: "Git shortcuts. /git wip — commits all changes with `cly gc --yolo`",      getArgumentCompletions: () => [
      {
        value: "wip",
        label: "wip",
        description: "Run `cly gc --yolo` to commit all changes as a WIP commit",
      },
    ],
    handler: async (args, ctx) => {
      const cwd = typeof ctx.cwd === "function" ? ctx.cwd() : ctx.cwd ?? process.cwd();
      const rawArgs = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const subcommand = (rawArgs[0] ?? "").toLowerCase();

      if (subcommand !== "wip") {
        notify(ctx, "git: usage — /git wip", "info");
        return;
      }

      notify(ctx, "📝 Running `cly gc --yolo` ...", "info");

      const result = await runClyGcYolo(cwd);

      if (result.ok) {
        if (result.stdout) {
          notify(ctx, `✅ cly gc --yolo\n${result.stdout}`, "success");
        } else {
          notify(ctx, "✅ cly gc --yolo completed", "success");
        }
      } else {
        const errorMsg = result.stderr || result.stdout || `exit code ${result.code ?? "?"}`;
        notify(ctx, `❌ cly gc --yolo failed:\n${errorMsg}`, "error");
      }
    },
  });
}
