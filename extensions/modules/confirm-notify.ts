/**
 * Confirm Notify Module
 *
 * Sends a macOS desktop notification via terminal-notifier when Pi
 * hits a protected path confirmation prompt (write, edit).
 * Uses the same backend as yu-notify.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";
import { execFileSync } from "node:child_process";

const DEBOUNCE_MS = 3000;

let lastNotificationAt = 0;
let notifierUnavailable = false;

function sendNotification(title: string, body: string): void {
	if (notifierUnavailable) return;

	const now = Date.now();
	if (now - lastNotificationAt < DEBOUNCE_MS) return;

	try {
		execFileSync("terminal-notifier", ["-title", title, "-message", body, "-group", "confirm-notify"], {
			timeout: 3000,
			stdio: "ignore",
		});
		lastNotificationAt = Date.now();
	} catch {
		notifierUnavailable = true;
	}
}

export default function confirmNotifyExtension(pi: ExtensionAPI) {
	const agent = process.env.PI_CMUX_NOTIFY_TITLE || "Pi";

	pi.on("tool_call", async (event) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			const path = event.input.path as string;
			if (path) {
				sendNotification(`⚠️ ${agent}`, `Allow ${event.toolName} → ${basename(path)}?`);
			}
		}
	});
}
