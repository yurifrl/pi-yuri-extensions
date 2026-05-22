/**
 * Supplemental Notifications Module
 *
 * Surfaces agent events as cmux notifications so you know when Pi needs
 * attention even if the terminal isn't focused. Currently covers:
 *   - guardrails:risk:detected   → ⚠️ Dangerous Command
 *   - guardrails:action:blocked  → 🚫 Command Blocked
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

// Event names emitted by @aliou/pi-guardrails (see src/shared/events.ts).
const GUARDRAILS_RISK_DETECTED_EVENT = "guardrails:risk:detected";
const GUARDRAILS_ACTION_BLOCKED_EVENT = "guardrails:action:blocked";

type GuardrailsAction =
  | { kind: "file"; path: string; origin?: string }
  | { kind: "command"; command: string; origin?: string };

interface GuardrailsRiskDetectedEvent {
  source: "guardrails";
  feature: "policies" | "permissionGate" | "pathAccess";
  timestamp: string;
  risk: {
    kind: "dangerous";
    action: GuardrailsAction;
    key: string;
    reason: string;
    metadata?: unknown;
  };
  context?: { toolName?: string; input?: Record<string, unknown> };
}

interface GuardrailsActionBlockedEvent {
  source: "guardrails";
  feature: "policies" | "permissionGate" | "pathAccess";
  timestamp: string;
  action: GuardrailsAction;
  reason: string;
  block: {
    source: "policy" | "permission" | "user" | "nonInteractive";
    metadata?: unknown;
  };
  context?: { toolName?: string; input?: Record<string, unknown> };
}

function describeAction(action: GuardrailsAction | undefined): string {
  if (!action) return "";
  return action.kind === "command" ? action.command : action.path;
}

function trim(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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

  // Guardrails: dangerous action detected (pre-prompt risk).
  pi.events.on(GUARDRAILS_RISK_DETECTED_EVENT, (event: GuardrailsRiskDetectedEvent) => {
    if (!cfg.dangerousCommand) return;
    const target = describeAction(event?.risk?.action);
    const reason = event?.risk?.reason || "Dangerous action";
    const body = target ? `${reason}: ${target}` : reason;
    notify("⚠️ Dangerous Command", trim(body));
  });

  // Guardrails: action blocked (policy / permission / user / non-interactive).
  pi.events.on(GUARDRAILS_ACTION_BLOCKED_EVENT, (event: GuardrailsActionBlockedEvent) => {
    if (!cfg.blockedCommand) return;
    const src = event?.block?.source;
    const who =
      src === "user"
        ? "You denied"
        : src === "policy"
          ? "Policy blocked"
          : src === "permission"
            ? "Permission denied"
            : src === "nonInteractive"
              ? "Blocked (non-interactive)"
              : "Blocked";
    const target = describeAction(event?.action);
    const reason = event?.reason || "Action blocked";
    const body = target ? `${who}: ${reason} — ${target}` : `${who}: ${reason}`;
    notify("🚫 Command Blocked", trim(body));
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
