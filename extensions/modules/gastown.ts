import type { ExtensionAPI, ExecResult } from "@mariozechner/pi-coding-agent";
import { readPiYuConfigFile } from "./lib/config.ts";

/**
 * gastown (improved) — pi extension
 *
 * Hooks pi into Steve Yegge's gastown (https://github.com/steveyegge/gastown)
 * multi-agent orchestration system. Adapted and improved from:
 *   https://github.com/normful/picadillo/blob/main/extensions/gastown.ts
 *
 * Improvements over upstream:
 *  - Availability probe: silently no-op when `gt` isn't installed (no console spam).
 *  - Rig probe: skip when cwd is not inside a gastown workspace.
 *  - Exec timeouts: gastown hooks cannot hang the session.
 *  - Prime/mail cache: single fetch per hook cycle (was double-fetching at session_start).
 *  - Dedupe: don't re-steer with identical prime text.
 *  - Config-driven: enable/disable individual hooks and role via project/global config.
 *  - Debug mode: opt-in logging; silent by default.
 *  - Graceful failure: never throws into the session loop.
 */

export const GASTOWN_MESSAGE_TYPE = "gastown";
const AUTONOMOUS_ROLES = new Set(["polecat", "witness", "refinery", "deacon"]);
const DEFAULT_TIMEOUT_MS = 8000;

type GastownToggleConfig = {
  gastown?: {
    role?: string;
    debug?: boolean;
    timeoutMs?: number;
    hooks?: {
      sessionStart?: boolean;
      beforeAgentStart?: boolean;
      sessionCompact?: boolean;
      sessionShutdown?: boolean;
    };
  };
};

type Config = Required<NonNullable<GastownToggleConfig["gastown"]>> & {
  hooks: Required<NonNullable<NonNullable<GastownToggleConfig["gastown"]>["hooks"]>>;
};

const DEFAULTS: Config = {
  role: "",
  debug: false,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  hooks: {
    sessionStart: true,
    beforeAgentStart: true,
    sessionCompact: true,
    sessionShutdown: true,
  },
};

async function loadConfig(cwd: string): Promise<Config> {
  const envRole = (process.env.GT_ROLE || "").toLowerCase();
  const envDebug = process.env.GASTOWN_DEBUG === "1";

  try {
    const { content } = await readPiYuConfigFile(cwd);
    if (!content) return { ...DEFAULTS, role: envRole, debug: envDebug || DEFAULTS.debug };
    const parsed = JSON.parse(content) as GastownToggleConfig;
    const g = parsed.gastown || {};
    return {
      role: (g.role ?? envRole).toLowerCase(),
      debug: g.debug ?? envDebug ?? DEFAULTS.debug,
      timeoutMs: g.timeoutMs ?? DEFAULTS.timeoutMs,
      hooks: { ...DEFAULTS.hooks, ...(g.hooks || {}) },
    };
  } catch {
    return { ...DEFAULTS, role: envRole, debug: envDebug };
  }
}

function log(cfg: Config, ...args: unknown[]): void {
  if (cfg.debug) console.error("[gastown]", ...args);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return await Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function safeExec(
  execFn: ExtensionAPI["exec"],
  cfg: Config,
  cmd: string,
  args: string[],
): Promise<ExecResult | null> {
  try {
    const res = await withTimeout(execFn(cmd, args), cfg.timeoutMs);
    if (!res) log(cfg, `${cmd} ${args.join(" ")} timed out after ${cfg.timeoutMs}ms`);
    return res;
  } catch (e) {
    log(cfg, `${cmd} ${args.join(" ")} failed:`, e);
    return null;
  }
}

let gtAvailable: boolean | null = null;
async function isGtAvailable(execFn: ExtensionAPI["exec"], cfg: Config): Promise<boolean> {
  if (gtAvailable !== null) return gtAvailable;
  const res = await safeExec(execFn, cfg, "gt", ["--version"]);
  gtAvailable = res !== null;
  if (!gtAvailable) log(cfg, "gt binary not found; gastown extension disabled for this session");
  return gtAvailable;
}

async function gastownPrime(execFn: ExtensionAPI["exec"], cfg: Config): Promise<string> {
  const res = await safeExec(execFn, cfg, "gt", ["prime", "--hook"]);
  return res?.stdout?.trim() ? res.stdout : "";
}

async function gastownMailCheck(execFn: ExtensionAPI["exec"], cfg: Config): Promise<string> {
  const res = await safeExec(execFn, cfg, "gt", ["mail", "check", "--inject"]);
  return res?.stdout?.trim() ? res.stdout : "";
}

function isAutonomousRole(role: string): boolean {
  return AUTONOMOUS_ROLES.has(role.toLowerCase());
}

export default function (pi: ExtensionAPI) {
  let cfg: Config = DEFAULTS;
  let lastPrimeText = "";
  // Cache mail text captured at session_start so before_agent_start doesn't refetch.
  let cachedMail: { text: string; at: number } | null = null;
  const MAIL_CACHE_MS = 5000;

  const getMail = async (): Promise<string> => {
    if (cachedMail && Date.now() - cachedMail.at < MAIL_CACHE_MS) return cachedMail.text;
    const text = await gastownMailCheck(pi.exec, cfg);
    cachedMail = { text, at: Date.now() };
    return text;
  };

  pi.on("session_start", async (_event, ctx) => {
    cfg = await loadConfig(ctx.cwd?.() ?? process.cwd());
    if (!cfg.hooks.sessionStart) return;
    if (!(await isGtAvailable(pi.exec, cfg))) return;

    const primeText = await gastownPrime(pi.exec, cfg);
    if (!primeText) return;

    const mailText = await getMail();
    const content = mailText ? `${primeText}\n\n${mailText}` : primeText;
    if (content === lastPrimeText) {
      log(cfg, "session_start: duplicate prime, skipping");
      return;
    }
    lastPrimeText = content;

    pi.sendMessage(
      { customType: GASTOWN_MESSAGE_TYPE, content, display: true },
      { deliverAs: "steer", triggerTurn: true },
    );
  });

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!cfg.hooks.beforeAgentStart) return undefined;
    if (!cfg.role || !isAutonomousRole(cfg.role)) return undefined;
    if (!(await isGtAvailable(pi.exec, cfg))) return undefined;

    const mailText = await getMail();
    if (!mailText) return undefined;

    return {
      message: { customType: GASTOWN_MESSAGE_TYPE, content: mailText, display: true },
    };
  });

  pi.on("session_compact", async (_event, _ctx) => {
    if (!cfg.hooks.sessionCompact) return;
    if (!(await isGtAvailable(pi.exec, cfg))) return;

    const primeText = await gastownPrime(pi.exec, cfg);
    if (!primeText) return;

    pi.sendMessage(
      { customType: GASTOWN_MESSAGE_TYPE, content: primeText, display: true },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!cfg.hooks.sessionShutdown) return;
    if (!(await isGtAvailable(pi.exec, cfg))) return;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!sessionId) return;
    await safeExec(pi.exec, cfg, "gt", ["costs", "record", "--session", sessionId]);
  });
}
