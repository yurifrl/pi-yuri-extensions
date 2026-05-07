import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { push as cmuxPush, dismiss as cmuxDismiss, dismissSync as cmuxDismissSync } from "./lib/cmuxNotify.ts";
import { readPiYuConfigFile } from "./lib/config.ts";

/**
 * memwatch — periodic per-session pi memory check, surfaced via cmux notifications.
 *
 * Watches THIS pi process's RSS (not system free). Two tiers:
 *   - warn  (⚠️ orange)  when RSS ≥ warnMB
 *   - critical (🚨 red)  when RSS ≥ criticalMB
 *
 * Every N minutes (default 15):
 *   - If RSS under warnMB → dismiss our own notification if we have one.
 *   - If RSS ≥ warnMB   → post cmux notification titled `memwatch:<pid>`.
 *   - On escalation warn→critical, replace the existing notification.
 *   - Per-id clear via `cmux rpc notification.clear {"id":"..."}` — no cross-session bleed.
 *   - Best-effort dismiss on `session_shutdown` and process exit.
 *
 * Config (pi-extensions.json):
 *   {
 *     "memwatch": {
 *       "intervalMinutes": 15,
 *       "warnMB": 1500,
 *       "criticalMB": 3000
 *     }
 *   }
 */

type MemwatchConfig = {
  intervalMinutes?: number;
  warnMB?: number;
  criticalMB?: number;
};

const DEFAULTS = {
  intervalMinutes: 15,
  warnMB: 1500,
  criticalMB: 3000,
};

const NOTIF_TITLE = `memwatch:${process.pid}`;

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

async function loadConfig(cwd: string): Promise<Required<MemwatchConfig>> {
  try {
    const { content } = await readPiYuConfigFile(cwd);
    if (!content) return { ...DEFAULTS };
    const cfg = (JSON.parse(content) as { memwatch?: MemwatchConfig }).memwatch ?? {};
    return {
      intervalMinutes: cfg.intervalMinutes ?? DEFAULTS.intervalMinutes,
      warnMB: cfg.warnMB ?? DEFAULTS.warnMB,
      criticalMB: cfg.criticalMB ?? DEFAULTS.criticalMB,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export default function memwatch(pi: ExtensionAPI): void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let currentNotifId: string | null = null;
  let lastLevel: "none" | "warn" | "critical" = "none";
  let ctxRef: any = null;

  const tick = async (): Promise<void> => {
    if (!ctxRef) return;
    const cfg = loadConfig(ctxRef);

    const ownRss = await readOwnRssKB(process.pid);
    const ownMB = ownRss > 0 ? Math.round(ownRss / 1024) : -1;

    let level: "none" | "warn" | "critical" = "none";
    if (ownMB >= 0 && ownMB >= cfg.criticalMB) level = "critical";
    else if (ownMB >= 0 && ownMB >= cfg.warnMB) level = "warn";

    if (level === "none") {
      // AUTO-DISMISS DISABLED (investigating vanishing notifications)
      // if (currentNotifId) {
      //   await cmuxDismiss(currentNotifId);
      //   currentNotifId = null;
      // }
      lastLevel = "none";
      return;
    }

    // Build message.
    const emoji = level === "critical" ? "🚨" : "⚠️";
    const subtitle = `${emoji} pi RAM ${fmtMB(ownRss)}`;
    const body =
      level === "critical"
        ? `pi process using ${fmtMB(ownRss)} (≥ ${cfg.criticalMB} MB critical)`
        : `pi process using ${fmtMB(ownRss)} (≥ ${cfg.warnMB} MB warn)`;

    // Replace on escalation, or if we don't currently have one.
    const escalated =
      (lastLevel === "none" && level !== "none") ||
      (lastLevel === "warn" && level === "critical");

    if (escalated || !currentNotifId) {
      // AUTO-DISMISS DISABLED (investigating vanishing notifications)
      // if (currentNotifId) {
      //   await cmuxDismiss(currentNotifId);
      //   currentNotifId = null;
      // }
      currentNotifId = await cmuxPush({ title: NOTIF_TITLE, subtitle, body });
    }
    lastLevel = level;
  };

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    if (timer) return;
    const cwd = typeof ctx.cwd === "function" ? (ctx.cwd as () => string)() : (ctx.cwd as unknown as string) ?? process.cwd();
    const cfg = await loadConfig(cwd);
    const ms = Math.max(1, cfg.intervalMinutes) * 60 * 1000;
    timer = setInterval(() => {
      void tick().catch(() => {});
    }, ms);
    try {
      (timer as any)?.unref?.();
    } catch {}
    // Fire one check ~5s after startup (don't block session_start).
    const kickoff = setTimeout(() => void tick().catch(() => {}), 5000);
    try {
      (kickoff as any)?.unref?.();
    } catch {}
  });

  pi.on("session_shutdown", async () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // AUTO-DISMISS DISABLED (investigating vanishing notifications)
    // if (currentNotifId) {
    //   cmuxDismissSync(currentNotifId);
    //   currentNotifId = null;
    // }
  });

  // AUTO-DISMISS DISABLED (investigating vanishing notifications)
  // process.on("exit", () => {
  //   if (currentNotifId) cmuxDismissSync(currentNotifId);
  // });

  pi.registerCommand?.("memwatch:clear", {
    description: "Dismiss this pi's memwatch notification immediately",
    handler: async (_args: string, ctx: any) => {
      // AUTO-DISMISS DISABLED (investigating vanishing notifications)
      // if (currentNotifId) {
      //   await cmuxDismiss(currentNotifId);
      //   currentNotifId = null;
      // }
      lastLevel = "none";
      try { ctx?.ui?.notify?.("memwatch cleared", "info"); } catch {}
    },
  });

  pi.registerCommand?.("memwatch:check", {
    description: "Run a memwatch tick now",
    handler: async () => { await tick(); },
  });
}
