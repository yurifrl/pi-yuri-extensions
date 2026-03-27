/**
 * Guardrails Notify Module
 *
 * Listens to pi-guardrails events and surfaces them as cmux notifications.
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

export default function guardrailsNotifyExtension(pi: ExtensionAPI) {
  async function notify(title: string, body: string) {
    await pi.exec("cmux", ["notify", "--title", title, "--body", body], { timeout: 3000 });
  }

  pi.events.on(GUARDRAILS_DANGEROUS_EVENT, (event: GuardrailsDangerousEvent) => {
    notify("⚠️ Dangerous Command", `${event.description}: ${event.command}`);
  });

  pi.events.on(GUARDRAILS_BLOCKED_EVENT, (event: GuardrailsBlockedEvent) => {
    const who = event.userDenied ? "You denied" : "Blocked";
    notify("🚫 Command Blocked", `${who}: ${event.reason}`);
  });
}
