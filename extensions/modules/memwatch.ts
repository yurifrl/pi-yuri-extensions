import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";

/**
 * memwatch — periodic per-session memory check.
 *
 * Runs every N minutes (default 15). Queries macOS `memory_pressure` and
 * this pi process's own RSS via `ps`. If free RAM drops below the threshold,
 * surfaces a notification inside the pi session via ctx.ui.notify().
 *
 * Light: no timers are created until session_start fires, and both child
 * processes (memory_pressure, ps) have hard timeouts + are detached so they
 * never block the event loop.
 *
 * Config (optional, under `memwatch` in pi-extensions.json):
 *   {
 *     "memwatch": {
 *       "intervalMinutes": 15,
 *       "thresholdPercent": 20,
 *       "criticalPercent": 10,
 *       "ownRssWarnMB": 1500
 *     }
 *   }
 */

type MemwatchConfig = {
  intervalMinutes?: number;
  thresholdPercent?: number;
  criticalPercent?: number;
  ownRssWarnMB?: number;
};

const DEFAULTS = {
  intervalMinutes: 15,
  thresholdPercent: 20,
  criticalPercent: 10,
  ownRssWarnMB: 1500,
};

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve(out);
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

async function readFreePercent(): Promise<number> {
  const out = await run("memory_pressure", []);
  const m = out.match(/System-wide memory free percentage:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

async function readOwnRssKB(pid: number): Promise<number> {
  const out = await run("ps", ["-o", "rss=", "-p", String(pid)]);
  const n = parseInt(out.trim(), 10);
  return isNaN(n) ? -1 : n;
}

function fmtMB(kb: number): string {
  if (kb < 0) return "?";
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  return `${Math.round(kb / 1024)} MB`;
}

function loadConfig(ctx: any): Required<MemwatchConfig> {
  try {
    const cfg = (ctx?.config?.extensions?.memwatch ?? ctx?.config?.memwatch ?? {}) as MemwatchConfig;
    return {
      intervalMinutes: cfg.intervalMinutes ?? DEFAULTS.intervalMinutes,
      thresholdPercent: cfg.thresholdPercent ?? DEFAULTS.thresholdPercent,
      criticalPercent: cfg.criticalPercent ?? DEFAULTS.criticalPercent,
      ownRssWarnMB: cfg.ownRssWarnMB ?? DEFAULTS.ownRssWarnMB,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function notify(ctx: any, msg: string, level: "info" | "success" | "error"): void {
  try {
    ctx?.ui?.notify?.(msg, level);
  } catch {}
}

export default function memwatch(pi: ExtensionAPI): void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastAlertLevel: "none" | "warn" | "critical" = "none";
  let ctxRef: any = null;

  const tick = async (): Promise<void> => {
    if (!ctxRef) return;
    const cfg = loadConfig(ctxRef);

    const [freePct, ownRss] = await Promise.all([
      readFreePercent(),
      readOwnRssKB(process.pid),
    ]);

    const ownMB = ownRss > 0 ? Math.round(ownRss / 1024) : -1;
    let level: "none" | "warn" | "critical" = "none";
    if (freePct >= 0 && freePct <= cfg.criticalPercent) level = "critical";
    else if (freePct >= 0 && freePct <= cfg.thresholdPercent) level = "warn";
    else if (ownMB >= cfg.ownRssWarnMB) level = "warn";

    // De-dupe: only notify on escalation, or once per level transition.
    const escalated =
      (lastAlertLevel === "none" && level !== "none") ||
      (lastAlertLevel === "warn" && level === "critical");
    if (!escalated) {
      // allow clearing state on recovery
      if (level === "none") lastAlertLevel = "none";
      return;
    }

    const emoji = level === "critical" ? "🚨" : "⚠️";
    const parts: string[] = [];
    if (freePct >= 0) parts.push(`system free: ${freePct}%`);
    if (ownRss > 0) parts.push(`this pi: ${fmtMB(ownRss)}`);
    const msg = `${emoji} memwatch — ${parts.join(" | ")}`;

    notify(ctxRef, msg, level === "critical" ? "error" : "info");
    lastAlertLevel = level;
  };

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    if (timer) return;
    const cfg = loadConfig(ctx);
    const ms = Math.max(1, cfg.intervalMinutes) * 60 * 1000;
    timer = setInterval(() => {
      void tick().catch(() => {});
    }, ms);
    try {
      (timer as any)?.unref?.();
    } catch {}
    // Fire one check shortly after startup (don't block session_start).
    const kickoff = setTimeout(() => void tick().catch(() => {}), 5000);
    try {
      (kickoff as any)?.unref?.();
    } catch {}
  });

  pi.on("session_end", async () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });
}
