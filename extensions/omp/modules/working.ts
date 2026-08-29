import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Working indicator — placeholder.
 *
 * Deliberately does nothing. We rebuild this step by step, one
 * verified behavior at a time, on top of this baseline.
 *
 * Baseline note: the stock omp 18.0.10 row is one static frame icon
 * (b.icon.esc) plus the setWorkingMessage text, defaulting to
 * "Working…". setWorkingIndicator does not exist in this build —
 * any call to it is a no-op.
 *
 * Config (~/.omp/agent/extensions/pi-yuri-extensions.json):
 *   "working": { "enabled": true, "graceSeconds": 10, "stillAfterSeconds": 45, "debug": false }
 */

export default function working(_pi: ExtensionAPI): void {
	// Placeholder: no handlers, no timers.
}
