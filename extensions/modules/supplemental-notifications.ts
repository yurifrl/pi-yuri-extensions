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
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

export default function supplementalNotificationsExtension(pi: ExtensionAPI) {
  async function notify(title: string, body: string) {
    try {
      await pi.exec("cmux", ["notify", "--title", title, "--body", body], { timeout: 3000 });
    } catch {
      // cmux not available — silent fallback
    }
  }

  // Guardrails: dangerous command detected
  pi.events.on(GUARDRAILS_DANGEROUS_EVENT, (event: GuardrailsDangerousEvent) => {
    notify("⚠️ Dangerous Command", `${event.description}: ${event.command}`);
  });

  // Guardrails: command blocked
  pi.events.on(GUARDRAILS_BLOCKED_EVENT, (event: GuardrailsBlockedEvent) => {
    const who = event.userDenied ? "You denied" : "Blocked";
    notify("🚫 Command Blocked", `${who}: ${event.reason}`);
  });

  // AskUserQuestion: agent needs input
  pi.on("tool_call", (event: any) => {
    if (event.toolName !== "AskUserQuestion") return;

    const question = typeof event.input?.question === "string"
      ? event.input.question
      : "Agent is asking a question";

    const trimmed = question.length > 140 ? `${question.slice(0, 137)}…` : question;
    notify("❓ Question", trimmed);
  });

  // Agent end: surface provider/stream errors (e.g. EADDRNOTAVAIL, network,
  // rate limits, context overflow). pi-ai encodes these as the final
  // assistant message with stopReason "error" + errorMessage.
  pi.on("agent_end", (event: any) => {
    const messages = Array.isArray((event as any)?.messages) ? (event as any).messages : [];
    const lastAssistant = [...messages].reverse().find((m: any) => m?.role === "assistant");
    if (!lastAssistant) return;

    const reason = lastAssistant.stopReason;
    if (reason !== "error" && reason !== "aborted") return;

    const raw = typeof lastAssistant.errorMessage === "string" && lastAssistant.errorMessage.trim()
      ? lastAssistant.errorMessage
      : reason === "aborted"
        ? "Agent aborted"
        : "Agent ended with an error";
    const body = raw.length > 200 ? `${raw.slice(0, 197)}…` : raw;
    const title = reason === "aborted" ? "⏹️ Pi Aborted" : "💥 Pi Error";
    notify(title, body);
  });

  // Tool failures: surface any tool execution that returns isError.
  pi.on("tool_result", (event: any) => {
    if (!(event as any)?.isError) return;

    const toolName = typeof (event as any).toolName === "string" ? (event as any).toolName : "tool";
    const details = (event as any).details;
    const content = (event as any).content;

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
