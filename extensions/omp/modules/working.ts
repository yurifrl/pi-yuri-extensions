import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Working indicator: "Working… M:SS" with elapsed time since the last
 * assistant message. Timer resets whenever omp streams a message; after
 * STILL_AFTER_MS of silence the label flips to "Still working…". Cleared
 * (restored to default) when the agent run ends.
 */

const TICK_MS = 1_000;
const STILL_AFTER_MS = 15_000;

const RESET = "\x1b[0m";
const DIM = "\x1b[90m";
const GREEN = "\x1b[32m";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface WorkingUI {
	setWorkingMessage?(message?: string): void;
	setWorkingIndicator?(options?: { frames?: string[] }): void;
}

function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function working(pi: ExtensionAPI): void {
	let active = false;
	let lastMessageAt = Date.now();

	function render(ui: WorkingUI): void {
		if (!active) return;
		const since = Date.now() - lastMessageAt;
		const label = since >= STILL_AFTER_MS ? "Still working…" : "Working…";
		ui.setWorkingMessage?.(`${DIM}${label} ${GREEN}${formatDuration(since)}${RESET}`);
	}

	function markActive(): void {
		active = true;
		lastMessageAt = Date.now();
	}

	function markMessage(): void {
		lastMessageAt = Date.now();
	}

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWorkingIndicator?.({ frames: SPINNER_FRAMES.map((f) => `${GREEN}${f}${RESET}`) });
		ctx.setInterval(() => render(ctx.ui), TICK_MS);
	});

	// A run is active from agent start until agent end (steers keep the same run).
	pi.on("agent_start", markActive);
	pi.on("turn_start", markActive);

	// Every streamed message resets the timer.
	pi.on("message_start", markMessage);
	pi.on("message_update", markMessage);
	pi.on("message_end", markMessage);

	pi.on("agent_end", async (_event, ctx) => {
		active = false;
		ctx.ui.setWorkingMessage?.();
	});
}
