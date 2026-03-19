import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readPiYuConfigFile } from "../config.ts";

type PresetConfig = {
  title: string;
  body: string;
};

type NotifyBackend = "notifier" | "osc" | "auto";
type OscProtocol = "auto" | "777" | "9" | "99";

type NotifyConfig = {
  backend: NotifyBackend;
  oscProtocol: OscProtocol;
  agent: string;
  presets: Record<string, PresetConfig>;
};

const DEFAULT_PRESETS: Record<string, PresetConfig> = {
  stop: {
    title: "✅ {agent}",
    body: "{session} › {tab}",
  },
  waiting: {
    title: "⏳ {agent}",
    body: "{session} › {tab}",
  },
  "subagent-stop": {
    title: "🔴 {agent}",
    body: "{session} › {tab}",
  },
};

const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  backend: "notifier",
  oscProtocol: "auto",
  agent: "Pi",
  presets: { ...DEFAULT_PRESETS },
};

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseBackend(value: unknown): NotifyBackend | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "notifier" || normalized === "osc" || normalized === "auto") {
    return normalized;
  }
  return undefined;
}

function parseOscProtocol(value: unknown): OscProtocol | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "777" || normalized === "9" || normalized === "99") {
    return normalized;
  }
  return undefined;
}

async function loadNotifyConfig(cwd: string): Promise<NotifyConfig> {
  const envBackend = parseBackend(process.env.ZNOTIFY_BACKEND);
  const envOscProtocol = parseOscProtocol(process.env.ZNOTIFY_OSC_PROTOCOL);

  let configBackend: NotifyBackend | undefined;
  let configOscProtocol: OscProtocol | undefined;
  let configAgent: string | undefined;
  let configPresets: Record<string, Partial<PresetConfig>> | undefined;

  try {
    const { content } = await readPiYuConfigFile(cwd);
    if (content) {
      const parsed = JSON.parse(content) as {
        notify?: {
          backend?: unknown;
          oscProtocol?: unknown;
          agent?: unknown;
          presets?: Record<string, { title?: string; body?: string }>;
        };
      };

      configBackend = parseBackend(parsed.notify?.backend);
      configOscProtocol = parseOscProtocol(parsed.notify?.oscProtocol);

      if (typeof parsed.notify?.agent === "string") {
        configAgent = parsed.notify.agent.trim();
      }

      if (parsed.notify?.presets && typeof parsed.notify.presets === "object") {
        configPresets = parsed.notify.presets;
      }
    }
  } catch {
    // ignore missing/invalid config file
  }

  // Merge presets: per-field override on top of defaults
  const mergedPresets: Record<string, PresetConfig> = {};
  for (const [key, defaultPreset] of Object.entries(DEFAULT_PRESETS)) {
    const override = configPresets?.[key];
    mergedPresets[key] = {
      title: override?.title ?? defaultPreset.title,
      body: override?.body ?? defaultPreset.body,
    };
  }
  // Add any extra presets from config that aren't in defaults
  if (configPresets) {
    for (const [key, override] of Object.entries(configPresets)) {
      if (!mergedPresets[key]) {
        mergedPresets[key] = {
          title: override.title ?? "",
          body: override.body ?? "",
        };
      }
    }
  }

  return {
    backend: envBackend ?? configBackend ?? DEFAULT_NOTIFY_CONFIG.backend,
    oscProtocol: envOscProtocol ?? configOscProtocol ?? DEFAULT_NOTIFY_CONFIG.oscProtocol,
    agent: configAgent || DEFAULT_NOTIFY_CONFIG.agent,
    presets: mergedPresets,
  };
}

function sanitizeOsc(value: string): string {
  return value
    .replace(/[\x07\x1b]/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/;/g, ",")
    .trim();
}

function wrapForTmux(sequence: string): string {
  if (!process.env.TMUX) return sequence;
  const escaped = sequence.replace(/\x1b/g, "\x1b\x1b");
  return `\x1bPtmux;${escaped}\x1b\\`;
}

function notifyOSC777(title: string, body: string): void {
  const t = sanitizeOsc(title);
  const b = sanitizeOsc(body);
  const sequence = `\x1b]777;notify;${t};${b}\x07`;
  process.stdout.write(wrapForTmux(sequence));
}

function notifyOSC9(message: string): void {
  const sequence = `\x1b]9;${sanitizeOsc(message)}\x07`;
  process.stdout.write(wrapForTmux(sequence));
}

function notifyOSC99(title: string, body: string): void {
  const t = sanitizeOsc(title);
  const b = sanitizeOsc(body);
  const titleSequence = `\x1b]99;i=1:d=0;${t}\x1b\\`;
  const bodySequence = `\x1b]99;i=1:p=body;${b}\x1b\\`;
  process.stdout.write(wrapForTmux(titleSequence));
  process.stdout.write(wrapForTmux(bodySequence));
}

function resolveOscProtocol(config: NotifyConfig): Exclude<OscProtocol, "auto"> {
  if (config.oscProtocol !== "auto") return config.oscProtocol;

  const isIterm2 = process.env.TERM_PROGRAM === "iTerm.app" || Boolean(process.env.ITERM_SESSION_ID);

  if (process.env.KITTY_WINDOW_ID) return "99";
  if (isIterm2) return "9";
  return "777";
}

function sendOscNotification(title: string, body: string, config: NotifyConfig): void {
  const protocol = resolveOscProtocol(config);

  if (protocol === "99") {
    notifyOSC99(title, body);
    return;
  }

  if (protocol === "9") {
    notifyOSC9(`${title}: ${body}`);
    return;
  }

  notifyOSC777(title, body);
}

function sendMacNotification(_pi: ExtensionAPI, title: string, body: string): boolean {
  if (process.platform !== "darwin") return false;

  try {
    const { execFileSync } = require("node:child_process");
    execFileSync("terminal-notifier", ["-title", title, "-message", body, "-group", "znotify"], {
      timeout: 3000,
      stdio: "ignore",
    });
    return true;
  } catch (err) {
    if (boolEnv("ZNOTIFY_DEBUG", false)) {
      console.error(`[znotify] terminal-notifier failed:`, err);
    }
    return false;
  }
}

async function sendDesktopNotification(
  pi: ExtensionAPI,
  title: string,
  body: string,
  config: NotifyConfig,
): Promise<void> {
  if (config.backend === "osc") {
    sendOscNotification(title, body, config);
    return;
  }

  if (config.backend === "auto") {
    const sent = sendMacNotification(pi, title, body);
    if (!sent) sendOscNotification(title, body, config);
    return;
  }

  sendMacNotification(pi, title, body);
}

function currentSessionName(): string {
  return process.env.ZELLIJ_SESSION_NAME?.trim() || "session";
}

function currentTaskName(): string {
  return process.env.CLAUDE_SESSION_NAME?.trim() || process.env.ZELLIJ_TAB_NAME?.trim() || "";
}

async function resolveTaskName(_pi: ExtensionAPI): Promise<string> {
  const fromEnv = currentTaskName();
  if (fromEnv) return fromEnv;

  if (!process.env.ZELLIJ) return "";

  try {
    const { execFileSync } = require("node:child_process");
    const stdout = execFileSync("zellij", ["action", "dump-layout"], { timeout: 2000, encoding: "utf8" });
    const match = stdout.match(/tab name="([^"]+)" focus=true/);
    return match?.[1]?.trim() || "";
  } catch {
    return "";
  }
}

function pipeToZellij(eventName: string): boolean {
  const paneId = process.env.ZELLIJ_PANE_ID;
  if (!paneId || !process.env.ZELLIJ) return false;

  // Map yu-notify events to emoji for zellij-notify tab icons
  const emoji = eventName === "stop" ? "✅" : eventName === "subagent-stop" ? "🔴" : "⏳";
  const pipeName = `notify::${emoji}::${paneId}`;

  try {
    const { execFileSync } = require("node:child_process");
    execFileSync("zellij", ["pipe", "--name", pipeName], { timeout: 4000, stdio: "ignore" });
    return true;
  } catch (err) {
    if (boolEnv("ZNOTIFY_DEBUG", false)) {
      console.error(`[znotify] zellij pipe failed:`, err);
    }
    return false;
  }
}

async function trigger(pi: ExtensionAPI, eventName: string, notifyConfig: NotifyConfig): Promise<void> {
  const preset = notifyConfig.presets[eventName] ?? DEFAULT_PRESETS[eventName];
  if (!preset) return;

  const vars: Record<string, string> = {
    agent: notifyConfig.agent,
    session: process.env.ZELLIJ_SESSION_NAME?.trim() || "session",
    tab: await resolveTaskName(pi),
  };

  const title = renderTemplate(preset.title, vars);
  const body = renderTemplate(preset.body, vars);

  await sendDesktopNotification(pi, title, body, notifyConfig);

  pipeToZellij(eventName);
}

function classifyAgentEndEvent(event: any): "stop" | "waiting" | "subagent-stop" {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const lastAssistant = [...messages].reverse().find((m: any) => m?.role === "assistant");
  const reason = lastAssistant?.stopReason;

  if (reason === "error" || reason === "aborted") return "subagent-stop";
  if (reason === "length") return "waiting";
  return "stop";
}

export default function zellijNotifyExtension(pi: ExtensionAPI) {
  let notifyConfig: NotifyConfig = { ...DEFAULT_NOTIFY_CONFIG };

  pi.on("session_start", async (_event, ctx) => {
    notifyConfig = await loadNotifyConfig(ctx.cwd);

    if (boolEnv("ZNOTIFY_DEBUG", false)) {
      console.error(
        `[znotify] config backend=${notifyConfig.backend} oscProtocol=${notifyConfig.oscProtocol} agent=${notifyConfig.agent}`,
      );
    }
  });

  pi.on("agent_end", async (event) => {
    if (!boolEnv("ZNOTIFY_AUTO_ON_IDLE", true)) return;
    await trigger(pi, classifyAgentEndEvent(event), notifyConfig);
  });
}
