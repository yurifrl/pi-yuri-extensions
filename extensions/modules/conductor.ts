import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUNTIME_ROOT = join(process.env.HOME ?? "/Users/yuri", ".pi", "agent", "skills", "conductor");
const CLI = join(RUNTIME_ROOT, "src", "cli.ts");

type Execution = Readonly<{ code: number | null; stdout: string; stderr: string }>;
type ConfiguredRun = Readonly<{ epicId: string; model: string }>;

function cwdOf(ctx: any): string {
  return typeof ctx.cwd === "function" ? ctx.cwd() : ctx.cwd ?? process.cwd();
}

function stateRoot(cwd: string): string {
  return join(cwd, ".agents", "conductor");
}

function configuredRun(cwd: string): ConfiguredRun | undefined {
  try {
    const agentRaw: unknown = JSON.parse(readFileSync(join(cwd, ".agents", "config.json"), "utf8"));
    const conductorRaw: unknown = JSON.parse(readFileSync(join(stateRoot(cwd), "config.json"), "utf8"));
    if (!isRecord(agentRaw) || !isRecord(conductorRaw) || conductorRaw.workers !== undefined) return undefined;

    const models = agentRaw.models;
    const localConductor = agentRaw.conductor;
    const configuredRun = conductorRaw.run;
    if (!isRecord(models) || (localConductor !== undefined && !isRecord(localConductor)) || (configuredRun !== undefined && !isRecord(configuredRun))) return undefined;

    const model = nonBlankString(models.default);
    const localEpic = localConductor ? nonBlankString(localConductor.epic) : undefined;
    const fallbackEpic = configuredRun ? nonBlankString(configuredRun.epic) : undefined;
    const epicId = localEpic ?? fallbackEpic;
    return epicId && model ? Object.freeze({ epicId, model }) : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    const value = JSON.parse(stdout) as { toLaunch?: unknown[]; configuration?: ConfiguredRun };
    const intents = value.toLaunch?.filter((id): id is string => typeof id === "string") ?? [];
    if (intents.length === 0 || !value.configuration) return;
    // Runtime, not stale skill prose, announces exact durable launch work. Pi owns
    // the subagent tool, so this bridge requests that capability without inventing
    // worker identity or retrying an already reserved intent.
    const body = [
      "<conductor-launch-bridge>",
      `Configured run: ${value.configuration.epicId}.`,
      `Reserved intents: ${intents.join(", ")}.`,
      "For each intent: call conductor prepare-launch, invoke subagent with emitted fields verbatim, confirm-visible, then heartbeat. Do not use shadow-tick or raw Herdr.",
      "</conductor-launch-bridge>",
    ].join("\n");
    pi.sendUserMessage(body, { deliverAs: "followUp" });
  } catch { /* heartbeat envelope is authoritative only when valid JSON */ }
}
/**
 * Supervisor reads consumer config for identity on every tick. It emits only
 * config-derived bridge instructions for Pi-owned subagent calls; every worker
 * identity/prompt still comes from `prepare-launch`, never session prose.
 */
export default function conductor(pi: ExtensionAPI): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let currentCwd: string | undefined;

  const tick = async (ctx: any, announce: boolean): Promise<Execution | undefined> => {
    const cwd = cwdOf(ctx);
    if (running || !configuredRun(cwd)) return undefined;
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

  const startSupervisor = (ctx: any, announce: boolean): boolean => {
    const cwd = cwdOf(ctx);
    if (timer || !configuredRun(cwd)) return false;
    timer = setInterval(() => { void tick(ctx, false); }, 5 * 60_000);
    timer.unref?.();
    void tick(ctx, announce);
    return true;
  };

  pi.on("session_start", async (_event, ctx) => {
    currentCwd = cwdOf(ctx);
    startSupervisor(ctx, false);
  });

  pi.on("agent_end", async (_event, ctx) => { void tick(ctx, false); });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    currentCwd = undefined;
  });

  pi.registerCommand("conductor", {
    description: "Supervise Conductor. /conductor start | status | tick",
    handler: async (args, ctx) => {
      const cwd = cwdOf(ctx);
      const [verb] = args.trim().split(/\s+/);
      if (verb === "start") {
        const run = configuredRun(cwd);
        if (!run) {
          ctx.ui.notify("conductor configuration missing models.default in .agents/config.json or conductor epic", "error");
          return;
        }
        ctx.ui.notify(`conductor started: ${run.epicId}`, "success");
        if (!startSupervisor(ctx, true)) void tick(ctx, true);
        return;
      }
      if (verb === "status") {
        const run = configuredRun(cwd);
        ctx.ui.notify(run ? `conductor configured: ${run.epicId} / ${run.model}` : "conductor not configured; set models.default and conductor.epic in .agents/config.json", run ? "info" : "warning");
        return;
      }
      if (verb === "tick") { await tick(ctx, true); return; }
      ctx.ui.notify("Usage: /conductor start | status | tick", "warning");
    },
  });
}
