/**
 * Supplemental Notifications Module
 *
 * Surfaces agent events as cmux notifications so you know when Pi needs
 * attention even if the terminal isn't focused. Currently covers:
 *   - guardrails:dangerous  → ⚠️ Dangerous Command
 *   - guardrails:blocked    → 🚫 Command Blocked
 *   - AskUserQuestion tool  → ❓ Question
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
  pi.on("tool_call", (event) => {
    if (event.toolName !== "AskUserQuestion") return;

    const question = typeof event.input?.question === "string"
      ? event.input.question
      : "Agent is asking a question";

    const trimmed = question.length > 140 ? `${question.slice(0, 137)}…` : question;
    notify("❓ Question", trimmed);
  });
}
