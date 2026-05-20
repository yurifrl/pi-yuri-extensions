/**
 * Supplemental Notifications Module
 *
 * Surfaces agent events as cmux notifications so you know when Pi needs
 * attention even if the terminal isn't focused. Currently covers:
 *   - guardrails:dangerous  → ⚠️ Dangerous Command
 *   - guardrails:blocked    → 🚫 Command Blocked
 *   - AskUserQuestion tool  → ❓ Question
 *   - agent_end (error)     → 💥 Pi Error (e.g. EADDRNOTAVAIL, provider failure)
 *   - tool_result (isError) → 🛠️ Tool Error
 *
 * Toggles (pi-extensions.json):
 *   "supplementalNotifications": {
 *     "dangerousCommand": true,   // ⚠️ Dangerous Command
 *     "blockedCommand": true,     // 🚫 Command Blocked
 *     "question": true,           // ❓ Question
 *     "agentError": true,         // 💥 Pi Error / ⏹️ Pi Aborted
 *     "toolError": true           // 🛠️ Tool Error
 *   }
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readPiYuConfigFile } from "../lib/config.ts";

const GUARDRAILS_DANGEROUS_EVENT = "guardrails:dangerous";
const GUARDRAILS_BLOCKED_EVENT = "guardrails:blocked";

interface GuardrailsDangerousEvent {
  command: string;
  description: string;
  pattern: string;
}

interface GuardrailsBlockedEvent {
  feature: "policies" | "permissionGate";
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
  userDenied?: boolean;
}

type NotifConfig = {
  dangerousCommand?: boolean;
  blockedCommand?: boolean;
  question?: boolean;
  agentError?: boolean;
  toolError?: boolean;
};

const DEFAULTS: Required<NotifConfig> = {
  dangerousCommand: true,
  blockedCommand: true,
  question: true,
  agentError: true,
  toolError: true,
};

async function loadConfig(cwd: string): Promise<Required<NotifConfig>> {
  try {
    const { content } = await readPiYuConfigFile(cwd);
    if (!content) return DEFAULTS;
    const parsed = JSON.parse(content);
    return { ...DEFAULTS, ...(parsed.supplementalNotifications ?? {}) };
  } catch {
    return DEFAULTS;
  }
}

export default function supplementalNotificationsExtension(pi: ExtensionAPI) {
  let cfg: Required<NotifConfig> = DEFAULTS;

  pi.on("session_start", async (_event, ctx) => {
    cfg = await loadConfig(typeof ctx.cwd === "function" ? ctx.cwd() : ctx.cwd);
  });

  async function notify(title: string, body: string) {
    try {
      await pi.exec("cmux", ["notify", "--title", title, "--body", body], { timeout: 3000 });
    } catch {
      // cmux not available — silent fallback
    }
  }

  // Guardrails: dangerous command detected
  pi.events.on(GUARDRAILS_DANGEROUS_EVENT, (event: GuardrailsDangerousEvent) => {
    if (!cfg.dangerousCommand) return;
    notify("⚠️ Dangerous Command", `${event.description}: ${event.command}`);
  });

  // Guardrails: command blocked
  pi.events.on(GUARDRAILS_BLOCKED_EVENT, (event: GuardrailsBlockedEvent) => {
    if (!cfg.blockedCommand) return;
    const who = event.userDenied ? "You denied" : "Blocked";
    notify("🚫 Command Blocked", `${who}: ${event.reason}`);
  });

  // AskUserQuestion: agent needs input
  pi.on("tool_call", (event: any) => {
    if (!cfg.question) return;
    if (event.toolName !== "AskUserQuestion") return;
    const question = typeof event.input?.question === "string"
      ? event.input.question
      : "Agent is asking a question";
    const trimmed = question.length > 140 ? `${question.slice(0, 137)}…` : question;
    notify("❓ Question", trimmed);
  });

  // Agent end: surface provider/stream errors
  pi.on("agent_end", (event: any) => {
    if (!cfg.agentError) return;
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const lastAssistant = [...messages].reverse().find((m: any) => m?.role === "assistant");
    if (!lastAssistant) return;
    const reason = lastAssistant.stopReason;
    if (reason !== "error" && reason !== "aborted") return;
    const raw = typeof lastAssistant.errorMessage === "string" && lastAssistant.errorMessage.trim()
      ? lastAssistant.errorMessage
      : reason === "aborted" ? "Agent aborted" : "Agent ended with an error";
    const body = raw.length > 200 ? `${raw.slice(0, 197)}…` : raw;
    notify(reason === "aborted" ? "⏹️ Pi Aborted" : "💥 Pi Error", body);
  });

  // Tool failures
  pi.on("tool_result", (event: any) => {
    if (!cfg.toolError) return;
    if (!event?.isError) return;
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    const details = event.details;
    const content = event.content;
    let message = "";
    if (details && typeof details === "object" && typeof details.error === "string") {
      message = details.error;
    } else if (typeof content === "string") {
      message = content;
    } else if (Array.isArray(content)) {
      const first = content.find((c: any) => typeof c?.text === "string");
      if (first) message = first.text;
    }
    message = (message || "Tool execution failed").trim();
    const body = message.length > 200 ? `${message.slice(0, 197)}…` : message;
    notify("🛠️ Tool Error", `${toolName}: ${body}`);
  });
}
