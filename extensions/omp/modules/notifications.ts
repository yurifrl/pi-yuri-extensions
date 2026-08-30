import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { push } from "../../../modules/lib/cmuxNotify.ts";
import { DEFAULT_CONFIG, type YuriExtensionsConfig } from "../../../modules/config.ts";
import { CONFIG_PATH, readOmpConfig, writeOmpConfig } from "../config.ts";

/**
 * notifications — cmux banner control + the event-driven banner sources.
 *
 * Owns the toggle surface (`/notifications`) AND the guardrails/tool/agent
 * event handlers that fire banners. Per-event on/off state persists in the
 * yuri omp config under `modules.notifications.events`.
 *
 *   promptedInput     ✋ Input Needed      guardrails prompt opened
 *   dangerousCommand  ⚠️ Dangerous Command guardrails:risk:detected (yolo only)
 *   blockedCommand    🚫 Command Blocked   guardrails:action:blocked
 *   question          ❓ Question          AskUserQuestion tool
 *   agentError        💥 Run Error         agent_end error/aborted
 *   toolError         🛠️ Tool Error        tool_result isError
 */

type EventId = "promptedInput" | "dangerousCommand" | "blockedCommand" | "question" | "agentError" | "toolError";

interface EventDef {
	id: EventId;
	label: string;
	defaultOn: boolean;
}

const EVENT_DEFS: EventDef[] = [
	{ id: "promptedInput", label: "✋ input needed (guardrails)", defaultOn: true },
	{ id: "dangerousCommand", label: "⚠️ dangerous action auto-approved", defaultOn: false },
	{ id: "blockedCommand", label: "🚫 action blocked", defaultOn: false },
	{ id: "question", label: "❓ agent asks a question", defaultOn: false },
	{ id: "agentError", label: "💥 run errored / aborted", defaultOn: false },
	{ id: "toolError", label: "🛠️ a tool call failed", defaultOn: false },
];

const GUARDRAILS_YOLO_KEY = "__PI_GUARDRAILS_YOLO_SESSION__";
const GUARDRAILS_RISK_DETECTED_EVENT = "guardrails:risk:detected";
const GUARDRAILS_ACTION_BLOCKED_EVENT = "guardrails:action:blocked";
const GUARDRAILS_PROMPT_OPENED_EVENT = "guardrails:prompt:opened";

function isYolo(): boolean {
	const state = (globalThis as Record<string, unknown>)[GUARDRAILS_YOLO_KEY];
	return typeof state === "object" && state !== null && (state as { enabled?: boolean }).enabled === true;
}

function describeAction(action: unknown): string {
	if (typeof action !== "object" || action === null) return "";
	const a = action as { kind?: string; command?: unknown; path?: unknown };
	return a.kind === "command" && typeof a.command === "string" ? a.command : typeof a.path === "string" ? a.path : "";
}

function trim(text: string, max = 200): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function readEventToggles(): Record<string, boolean> {
	const module = readOmpConfig().modules?.notifications;
	const events = (module as { events?: Record<string, boolean> } | undefined)?.events;
	return typeof events === "object" && events !== null ? events : {};
}

function isEnabled(id: EventId): boolean {
	const explicit = readEventToggles()[id];
	if (typeof explicit === "boolean") return explicit;
	return EVENT_DEFS.find((d) => d.id === id)?.defaultOn ?? false;
}

async function setEnabled(id: EventId, on: boolean): Promise<void> {
	const config = readOmpConfig();
	const merged: YuriExtensionsConfig = {
		modules: {
			...DEFAULT_CONFIG.modules,
			...config.modules,
			notifications: {
				...config.modules?.notifications,
				events: {
					...readEventToggles(),
					[id]: on,
				},
			},
		},
	};
	writeOmpConfig(CONFIG_PATH, merged);
}

async function fire(pi: ExtensionAPI, id: EventId, title: string, body: string): Promise<void> {
	if (!isEnabled(id)) return;
	try {
		await push({ title, body });
	} catch {
		// cmux unavailable — silent
	}
	void pi;
}

export default function notifications(pi: ExtensionAPI): void {
	// ── event-driven banners ────────────────────────────────────────────
	pi.events.on(GUARDRAILS_RISK_DETECTED_EVENT, (data: unknown) => {
		if (!isYolo()) return;
		const event = data as { risk?: { action?: unknown; reason?: string } } | undefined;
		const target = describeAction(event?.risk?.action);
		const reason = event?.risk?.reason || "Dangerous action";
		void fire(pi, "dangerousCommand", "⚠️ Dangerous Command", trim(target ? `${reason}: ${target}` : reason));
	});

	pi.events.on(GUARDRAILS_PROMPT_OPENED_EVENT, (data: unknown) => {
		const event = data as { action?: unknown; reason?: string } | undefined;
		const target = describeAction(event?.action);
		const reason = event?.reason || "Input needed";
		void fire(pi, "promptedInput", "✋ Input Needed", trim(target ? `${reason}: ${target}` : reason));
	});

	pi.events.on(GUARDRAILS_ACTION_BLOCKED_EVENT, (data: unknown) => {
		const event = data as { action?: unknown; reason?: string; block?: { source?: string } } | undefined;
		const src = event?.block?.source;
		const who =
			src === "user" ? "You denied"
			: src === "policy" ? "Policy blocked"
			: src === "permission" ? "Permission denied"
			: src === "nonInteractive" ? "Blocked (non-interactive)"
			: "Blocked";
		const target = describeAction(event?.action);
		const reason = event?.reason || "Action blocked";
		void fire(pi, "blockedCommand", "🚫 Command Blocked", trim(target ? `${who}: ${reason} — ${target}` : `${who}: ${reason}`));
	});

	pi.on("tool_call", (event) => {
		if (event.toolName !== "AskUserQuestion") return;
		const question = typeof event.input === "object" && event.input !== null && "question" in event.input && typeof (event.input as { question: unknown }).question === "string" ? (event.input as { question: string }).question : "Agent is asking a question";
		void fire(pi, "question", "❓ Question", trim(question, 140));
	});

	pi.on("agent_end", (event) => {
		const messages = Array.isArray(event.messages) ? event.messages : [];
		const last = [...messages].reverse().find((m) => m?.role === "assistant");
		if (!last) return;
		const reason = (last as { stopReason?: string }).stopReason;
		if (reason !== "error" && reason !== "aborted") return;
		const raw = typeof (last as { errorMessage?: unknown }).errorMessage === "string" && (last as { errorMessage: string }).errorMessage.trim()
			? (last as { errorMessage: string }).errorMessage
			: reason === "aborted" ? "Agent aborted" : "Agent ended with an error";
		void fire(pi, "agentError", reason === "aborted" ? "⏹️ Run Aborted" : "💥 Run Error", trim(raw));
	});

	pi.on("tool_result", (event) => {
		if (!event.isError) return;
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		const details = (event as { details?: unknown }).details;
		const content = (event as { content?: unknown }).content;
		let message = "";
		if (typeof details === "object" && details !== null && typeof (details as { error?: unknown }).error === "string") message = (details as { error: string }).error;
		else if (typeof content === "string") message = content;
		else if (Array.isArray(content)) {
			const first = content.find((c) => typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string");
			if (first) message = (first as { text: string }).text;
		}
		void fire(pi, "toolError", "🛠️ Tool Error", `${toolName}: ${trim((message || "Tool execution failed").trim())}`);
	});

	// ── toggle surface ──────────────────────────────────────────────────
	pi.registerCommand("notifications", {
		description: "Toggle cmux notifications. Usage: /notifications [<id> on|off | all on|off | test <id>]",
		getArgumentCompletions: () => EVENT_DEFS.map((d) => ({ value: d.id, label: d.id, description: d.label })),
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const [a, b] = parts;

			if (a === "all" && (b === "on" || b === "off")) {
				for (const d of EVENT_DEFS) await setEnabled(d.id, b === "on");
				ctx.ui.notify(`notifications: all ${b}`, "info");
				return;
			}
			if (a === "test" && b) {
				await fire(pi, b as EventId, "🔔 Test", `test notification: ${b}`);
				ctx.ui.notify(`fired test "${b}" (if enabled)`, "info");
				return;
			}
			if (a && (b === "on" || b === "off")) {
				await setEnabled(a as EventId, b === "on");
				ctx.ui.notify(`${a}: ${b}`, "info");
				return;
			}

			if (!ctx.hasUI) return;
			for (;;) {
				const toggles = readEventToggles();
				const labels = EVENT_DEFS.map((d) => `${(typeof toggles[d.id] === "boolean" ? toggles[d.id] : d.defaultOn) ? "[x]" : "[ ]"} ${d.label}`);
				labels.push("Done");
				const choice = await ctx.ui.select("Toggle notifications:", labels);
				if (!choice || choice === "Done") break;
				const idx = labels.indexOf(choice);
				const d = EVENT_DEFS[idx];
				if (!d) break;
				const current = typeof toggles[d.id] === "boolean" ? toggles[d.id] : d.defaultOn;
				await setEnabled(d.id, !current);
			}
		},
	});
}

