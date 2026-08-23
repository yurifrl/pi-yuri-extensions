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

function configuredRun(cwd: string, overrides: Partial<ConfiguredRun> = {}): ConfiguredRun | undefined {
  try {
    const conductorRaw: unknown = JSON.parse(readFileSync(join(stateRoot(cwd), "config.json"), "utf8"));
    if (!isRecord(conductorRaw)) return undefined;
    const run = conductorRaw.run;
    const workers = conductorRaw.workers;
    if (!isRecord(run) || !isRecord(workers)) return undefined;
    const epicId = overrides.epicId ?? nonBlankString(run.epic);
    const model = overrides.model ?? nonBlankString(workers.model);
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

type HeartbeatJson = Readonly<{
  status?: { legalReady?: number; verifiedLive?: number; reserved?: number; deficit?: number };
  toLaunch?: readonly string[];
  recovery?: { state: string; reason?: string; graphRevision?: number };
}>;

function parseHeartbeat(stdout: string): HeartbeatJson | undefined {
  try { return JSON.parse(stdout) as HeartbeatJson; } catch { return undefined; }
}

function formatHeartbeat(run: ConfiguredRun, result: Execution): string {
  if (result.code !== 0) {
    const msg = result.stderr || result.stdout || "unknown error";
    return `conductor heartbeat failed: ${msg}`;
  }
  const data = parseHeartbeat(result.stdout);
  if (!data) return "conductor heartbeat: no JSON output";
  const parts: string[] = [];
  parts.push(`epic=${run.epicId}`);
  parts.push(`model=${run.model}`);
  if (data.recovery) {
    const rev = data.recovery.graphRevision !== undefined ? `@r${data.recovery.graphRevision}` : "";
    const reason = data.recovery.reason ? `(${data.recovery.reason})` : "";
    parts.push(`recovery=${data.recovery.state}${rev}${reason}`);
  }
  if (data.status) {
    const s = data.status;
    parts.push(`ready=${s.legalReady ?? 0}`);
    parts.push(`live=${s.verifiedLive ?? 0}`);
    parts.push(`reserved=${s.reserved ?? 0}`);
    if (s.deficit && s.deficit > 0) parts.push(`deficit=${s.deficit}`);
  }
  parts.push(`launch=${data.toLaunch?.length ?? 0}`);
  return `conductor: ${parts.join(" | ")}`;
}

function requestLaunchBridge(pi: ExtensionAPI, stdout: string, run: ConfiguredRun): void {
  const data = parseHeartbeat(stdout);
  if (!data) return;
  if (data.recovery?.state === "blocked") return;
  const intents = data.toLaunch?.filter((id): id is string => typeof id === "string") ?? [];
  if (intents.length === 0) return;
  const body = [
    "<conductor-launch-bridge>",
    `Configured run: ${run.epicId}.`,
    `Reserved intents: ${intents.join(", ")}.`,
    "For each intent: call conductor prepare-launch, invoke subagent with emitted fields verbatim, confirm-visible, then heartbeat. Do not use shadow-tick or raw Herdr.",
    "</conductor-launch-bridge>",
  ].join("\n");
  pi.sendUserMessage(body, { deliverAs: "followUp" });
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
    const run = configuredRun(cwd);
    if (running || !run) return undefined;
    running = true;
    try {
      const result = await heartbeat(cwd);
      if (announce) ctx.ui.notify(formatHeartbeat(run, result), result.code === 0 ? "info" : "warning");
      if (result.code === 0) requestLaunchBridge(pi, result.stdout, run);
      return result;
    } finally {
      running = false;
    }
  };

  const startSupervisor = (ctx: any, announce: boolean, run?: ConfiguredRun): boolean => {
    const cwd = cwdOf(ctx);
    if (timer || !(run ?? configuredRun(cwd))) return false;
    timer = setInterval(() => { void tick(ctx, false); }, 5 * 60_000);
    timer.unref?.();
    void tick(ctx, announce);
    return true;
  };

  pi.on("session_start", async (_event, ctx) => {
    currentCwd = cwdOf(ctx);
    // Explicit `/conductor start` owns first dispatch. Fresh Pi sessions must
    // never receive an unsolicited heartbeat or conductor follow-up message.
  });

  // Do not heartbeat from `agent_end`: extension follow-ups themselves create
  // agent turns, turning lifecycle observation into a self-prompt loop. Timer
  // ticks begin only after explicit `/conductor start`.
  pi.on("agent_end", async () => {});

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    currentCwd = undefined;
  });

  pi.registerCommand("conductor", {
    description: "Supervise Conductor. /conductor start [--epic <bead> --model <id>] | status | tick",
    handler: async (args, ctx) => {
      const cwd = cwdOf(ctx);
      const tokens = args.trim().split(/\s+/);
      const [verb] = tokens;
      const option = (name: string): string | undefined => {
        const index = tokens.indexOf(name);
        return index >= 0 ? tokens[index + 1] : undefined;
      };
      if (verb === "start") {
        const run = configuredRun(cwd);
        if (!run) {
          ctx.ui.notify("conductor not configured; set run.epic and workers.model in .agents/conductor/config.json", "error");
          return;
        }
        ctx.ui.notify(`conductor starting: ${run.epicId} / ${run.model}`, "success");
        if (!startSupervisor(ctx, true, run)) void tick(ctx, true);
        return;
      }
      if (verb === "status" || verb === "tick") {
        const run = configuredRun(cwd);
        if (!run) {
          ctx.ui.notify("conductor not configured; set run.epic and workers.model in .agents/conductor/config.json", "warning");
          return;
        }
        await tick(ctx, true);
        return;
      }
      ctx.ui.notify("Usage: /conductor start | status | tick", "warning");
    },
  });
}
