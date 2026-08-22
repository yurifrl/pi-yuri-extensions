import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RUNTIME_ROOT = join(process.env.HOME ?? "/Users/yuri", ".pi", "agent", "skills", "conductor");
const CLI = join(RUNTIME_ROOT, "src", "cli.ts");

type Execution = Readonly<{ code: number | null; stdout: string; stderr: string }>;
type ControllerRun = Readonly<{ epicId: string; model: string }>;

function cwdOf(ctx: any): string {
  return typeof ctx.cwd === "function" ? ctx.cwd() : ctx.cwd ?? process.cwd();
}

function stateRoot(cwd: string): string {
  return join(cwd, ".agents", "conductor");
}

function boundRun(cwd: string): ControllerRun | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(stateRoot(cwd), "run.json"), "utf8"));
    if (!raw || typeof raw !== "object") return undefined;
    const value = raw as Record<string, unknown>;
    return typeof value.epicId === "string" && typeof value.model === "string"
      ? Object.freeze({ epicId: value.epicId, model: value.model })
      : undefined;
  } catch {
    return undefined;
  }
}

function execute(args: readonly string[], cwd: string): Promise<Execution> {
  return new Promise((resolve) => {
    const child = spawn("bun", [CLI, ...args], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.on("error", (error) => resolve({ code: null, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function heartbeat(cwd: string): Promise<Execution> {
  return execute(["heartbeat", "--cwd", cwd, "--now", new Date().toISOString(), "--json"], cwd);
}

function oneLine(result: Execution): string {
  if (result.code === 0) {
    try {
      const value = JSON.parse(result.stdout) as { status?: { legalReady?: number }; toLaunch?: unknown[] };
      return `conductor heartbeat: ready=${value.status?.legalReady ?? 0}, launch=${value.toLaunch?.length ?? 0}`;
    } catch { return "conductor heartbeat completed"; }
  }
  return `conductor heartbeat refused: ${result.stderr || result.stdout}`;
}

function requestLaunchBridge(pi: ExtensionAPI, stdout: string): void {
  try {
    const value = JSON.parse(stdout) as { toLaunch?: unknown[]; run?: ControllerRun };
    const intents = value.toLaunch?.filter((id): id is string => typeof id === "string") ?? [];
    if (intents.length === 0 || !value.run) return;
    // Runtime, not stale skill prose, announces exact durable launch work. Pi owns
    // the subagent tool, so this bridge requests that capability without inventing
    // worker identity or retrying an already reserved intent.
    const body = [
      "<conductor-launch-bridge>",
      `Bound run: ${value.run.epicId} / ${value.run.model}.`,
      `Reserved intents: ${intents.join(", ")}.`,
      "For each intent: call conductor prepare-launch, invoke subagent with emitted fields verbatim, confirm-visible, then heartbeat. Do not use shadow-tick or raw Herdr.",
      "</conductor-launch-bridge>",
    ].join("\n");
    pi.sendUserMessage(body, { deliverAs: "followUp" });
  } catch { /* heartbeat envelope is authoritative only when valid JSON */ }
}
/**
 * Supervisor owns periodic active observation. It never takes an epic/model from
 * conversational context: bind creates durable identity, heartbeat derives it.
 * It emits only durable bridge instructions for Pi-owned subagent calls; every
 * worker identity/prompt still comes from `prepare-launch`, never session prose.
 */
export default function conductor(pi: ExtensionAPI): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let currentCwd: string | undefined;

  const tick = async (ctx: any, announce: boolean): Promise<Execution | undefined> => {
    const cwd = cwdOf(ctx);
    if (running || !existsSync(join(stateRoot(cwd), "run.json"))) return undefined;
    running = true;
    try {
      const result = await heartbeat(cwd);
      if (announce) ctx.ui.notify(oneLine(result), result.code === 0 ? "info" : "warning");
      if (result.code === 0) requestLaunchBridge(pi, result.stdout);
      return result;
    } finally {
      running = false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    currentCwd = cwdOf(ctx);
    if (!boundRun(currentCwd) || timer) return;
    timer = setInterval(() => { void tick(ctx, false); }, 5 * 60_000);
    timer.unref?.();
    void tick(ctx, false);
  });

  pi.on("agent_end", async (_event, ctx) => { void tick(ctx, false); });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    currentCwd = undefined;
  });

  pi.registerCommand("conductor", {
    description: "Bind and supervise Conductor. /conductor start <epic> <model> | status | tick",
    handler: async (args, ctx) => {
      const cwd = cwdOf(ctx);
      const [verb, epic, model] = args.trim().split(/\s+/);
      if (verb === "start") {
        if (!epic || !model) { ctx.ui.notify("Usage: /conductor start <epic> <model>", "warning"); return; }
        const result = await execute(["bind", "--epic", epic, "--model", model, "--cwd", cwd, "--json"], cwd);
        ctx.ui.notify(result.code === 0 ? `conductor bound: ${epic}` : `conductor bind refused: ${result.stderr || result.stdout}`, result.code === 0 ? "success" : "error");
        if (result.code === 0) void tick(ctx, true);
        return;
      }
      if (verb === "status") {
        const run = boundRun(cwd);
        ctx.ui.notify(run ? `conductor bound: ${run.epicId} / ${run.model}` : "conductor not bound; use /conductor start <epic> <model>", run ? "info" : "warning");
        return;
      }
      if (verb === "tick") { await tick(ctx, true); return; }
      ctx.ui.notify("Usage: /conductor start <epic> <model> | status | tick", "warning");
    },
  });
}
