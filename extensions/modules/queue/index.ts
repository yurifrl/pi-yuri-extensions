/**
 * Queue — park prompts while the agent is busy; they fire one at a time once it goes idle.
 *
 * State persists per session under <agentDir>/queue/ and is re-keyed on session start, switch, and branch (the host
 * emits session_switch — not session_start — for /new, /resume, fork, and handoff). A generation counter guards the
 * delayed fire so a queued prompt is never injected into a session the user left. An above-editor widget shows the
 * pending count and head item.
 *
 * /queue [text] | /q — queue a prompt; bare opens the manager · /queue-manager on|off|pause|resume | /qm — capture
 * mode (queue every interactive prompt instead of sending), pause/resume, or the manager (edit/skip/remove).
 * Disable: "modules": { "queue": false }.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Item = { text: string; skipped: boolean };
type State = { items: Item[]; paused: boolean; capture: boolean };

const WIDGET_ID = "yuri-queue";
const MAX_LABEL = 60; // truncated task text length in widget/manager
const FIRE_DELAY_MS = 1_000; // let follow-ups/steers land before firing the next item

export default function queue(pi: ExtensionAPI): void {
	const state: State = { items: [], paused: false, capture: false };
	let sessionFile: string | undefined;
	// Bumped on every session re-key; scheduled fires compare against it so a
	// queued prompt is never injected into a session the user left.
	let generation = 0;

	// ---- persistence: per session, under <agentDir>/queue/<file>.json (omp) or
	// ~/.config/pi-yuri-extensions/queue/ (pi, which has no agent dir) ----
	const ompAgentDir = (pi as { pi?: { settings?: { getAgentDir?: () => string } } }).pi?.settings?.getAgentDir?.();
	const queueDir = ompAgentDir ? join(ompAgentDir, "queue") : join(homedir(), ".config", "pi-yuri-extensions", "queue");
	const stateFile = () => (sessionFile ? join(queueDir, `${sessionFile.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`) : undefined);

	const load = () => {
		const file = stateFile();
		if (!file || !existsSync(file)) return;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<State>;
			state.items = Array.isArray(parsed.items)
				? parsed.items
						.filter((i): i is Item => !!i && typeof i.text === "string")
						.map((i) => ({ text: i.text, skipped: !!i.skipped }))
				: [];
			state.paused = !!parsed.paused;
			state.capture = !!parsed.capture;
		} catch {
			// ignore corrupt state
		}
	};

	const save = () => {
		const file = stateFile();
		if (!file) return;
		try {
			mkdirSync(queueDir, { recursive: true });
			writeFileSync(file, JSON.stringify(state), "utf8");
		} catch {
			// best effort
		}
	};

	const truncate = (text: string) => truncateToWidth(text.replace(/\s+/g, " ").trim(), MAX_LABEL, "…");

	// ---- widget above editor ----
	const refreshWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (state.items.length === 0) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}
		const nextIdx = state.items.findIndex((i) => !i.skipped);
		ctx.ui.setWidget(WIDGET_ID, (_tui, theme: Theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const pending = state.items.filter((i) => !i.skipped).length;
				const head =
					`Queue ${pending}/${state.items.length}` + (state.capture ? " ● capture" : "") + (state.paused ? " ⏸ paused" : "");
				const lines: string[] = [truncateToWidth(theme.fg("accent", ` ${head} `), width)];
				state.items.forEach((item, i) => {
					const label = truncate(item.text);
					if (item.skipped) {
						lines.push(truncateToWidth(`   ${theme.fg("dim", "⊘ " + label)}`, width));
					} else if (i === nextIdx && !state.paused) {
						lines.push(truncateToWidth(` ${theme.fg("success", "▶")} ${theme.fg("success", label)}`, width));
					} else {
						lines.push(truncateToWidth(`   ${theme.fg("muted", label)}`, width));
					}
				});
				return lines;
			},
		}));
	};

	// ---- fire next pending item when the agent is fully idle ----
	const tryFire = (ctx: ExtensionContext, atGeneration: number) => {
		if (atGeneration !== generation) return; // session changed since scheduling
		if (!ctx.hasUI) return;
		if (state.paused) return;
		if (!ctx.isIdle()) return;
		const idx = state.items.findIndex((i) => !i.skipped);
		if (idx === -1) return;
		const [item] = state.items.splice(idx, 1);
		save();
		refreshWidget(ctx);
		pi.sendUserMessage(item.text);
	};

	const scheduleFire = (ctx: ExtensionContext) => {
		const atGeneration = generation;
		setTimeout(() => tryFire(ctx, atGeneration), FIRE_DELAY_MS);
	};

	// Re-key persisted state to the active session. Runs on session_start and on
	// session_switch/session_branch: the host emits session_switch (not
	// session_start) for /new, /resume, fork, and handoff, so keying only on
	// session_start would keep editing the previous session's file and could
	// fire a queued prompt into a session the user left.
	const rekeySession = (ctx: ExtensionContext) => {
		generation++;
		const file = ctx.sessionManager.getSessionFile();
		if (file === sessionFile) return;
		sessionFile = file;
		state.items = [];
		state.paused = false;
		state.capture = false;
		load();
	};

	pi.on("session_start", (_event, ctx) => {
		rekeySession(ctx);
		refreshWidget(ctx);
	});

	// omp-only events (session re-key for /new, /resume, fork, handoff); widened so
	// the registration typechecks against pi's narrower event map, where session_start
	// covers resume and no re-key signal exists mid-session.
	const ompEvents = pi as unknown as { on(event: string, handler: (event: never, ctx: ExtensionContext) => void): void };
	for (const event of ["session_switch", "session_branch"]) {
		ompEvents.on(event, (_event, ctx) => {
			rekeySession(ctx);
			refreshWidget(ctx);
		});
	}

	// No "agent_settled" on omp; agent_end + a short delay approximates it:
	// the run finished and queued steers/follow-ups have landed.
	pi.on("agent_end", (_event, ctx) => scheduleFire(ctx));

	// capture mode: queue every interactive prompt instead of sending it.
	// Widened signature: the {handled} result is omp-specific; pi absorbs the return.
	// pi uses { action: "handled" }; omp uses { handled: boolean }. The unified
	// handler satisfies both shapes; the registration is cast through unknown
	// because neither runtime's result type names the other's vocabulary.
	(pi as unknown as {
		on(
			event: "input",
			handler: (event: { text: string; source: string }, ctx: ExtensionContext) => Promise<unknown>,
		): void;
	}).on("input", async (event, ctx) => {
		const handled = (value: boolean): unknown => ({ handled: value, action: value ? "handled" : "continue" });
		if (!state.capture) return handled(false);
		if (event.source !== "interactive") return handled(false);
		const text = event.text.trim();
		if (!text || text.startsWith("/")) return handled(false);
		state.items.push({ text, skipped: false });
		save();
		refreshWidget(ctx);
		ctx.ui.notify(`Captured (${state.items.length} in queue)`, "info");
		scheduleFire(ctx);
		return handled(true);
	});

	const openManager = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("The queue manager requires interactive mode", "error");
			return;
		}
		await ctx.ui.custom<void>((_tui, theme, _kb, done) => new ManagerComponent(state, theme, done));
		save();
		refreshWidget(ctx);
		tryFire(ctx, generation);
	};

	const addToQueue = async (args: string, ctx: ExtensionContext) => {
		const text = args.trim();
		if (!text) {
			await openManager(ctx);
			return;
		}
		state.items.push({ text, skipped: false });
		save();
		refreshWidget(ctx);
		ctx.ui.notify(`Queued (${state.items.length} in queue)`, "info");
		tryFire(ctx, generation);
	};

	pi.registerCommand("queue", {
		description: "Add a prompt to the queue, or open the manager when called bare",
		handler: addToQueue,
	});

	pi.registerCommand("q", {
		description: "Alias for /queue",
		handler: addToQueue,
	});

	const managerHandler = async (args: string, ctx: ExtensionContext) => {
		const sub = args.trim().toLowerCase();
		if (sub === "pause") {
			state.paused = true;
			save();
			refreshWidget(ctx);
			ctx.ui.notify("Queue paused", "info");
			return;
		}
		if (sub === "resume") {
			state.paused = false;
			save();
			refreshWidget(ctx);
			ctx.ui.notify("Queue resumed", "info");
			tryFire(ctx, generation);
			return;
		}
		if (sub === "on" || sub === "off") {
			state.capture = sub === "on";
			save();
			refreshWidget(ctx);
			ctx.ui.notify(state.capture ? "Capture mode on: all messages queue" : "Capture mode off", "info");
			return;
		}
		await openManager(ctx);
	};

	const managerOptions = {
		getArgumentCompletions: (prefix: string) =>
			["on", "off", "pause", "resume"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v })),
		handler: managerHandler,
	};

	pi.registerCommand("queue-manager", {
		description: "Manage the queue: on/off capture, pause, resume, or open the manager",
		...managerOptions,
	});

	pi.registerCommand("qm", {
		description: "Alias for /queue-manager",
		...managerOptions,
	});
}

class ManagerComponent {
	private selected = 0;
	private editing = false;
	private buffer = "";
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private state: State,
		private theme: Theme,
		private onClose: () => void,
	) {}

	handleInput(data: string): void {
		const items = this.state.items;

		// ---- in-place edit mode ----
		if (this.editing) {
			const item = items[this.selected];
			if (matchesKey(data, "escape")) {
				this.editing = false;
			} else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
				if (item && this.buffer.trim()) item.text = this.buffer.trim();
				this.editing = false;
			} else if (matchesKey(data, "backspace")) {
				this.buffer = this.buffer.slice(0, -1);
			} else if (data >= " " && !data.startsWith("\x1b")) {
				this.buffer += data;
			}
			this.invalidate();
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.onClose();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.selected = items.length ? (this.selected === 0 ? items.length - 1 : this.selected - 1) : 0;
		} else if (matchesKey(data, "down") || data === "j") {
			this.selected = items.length ? (this.selected + 1) % items.length : 0;
		} else if (data === "s") {
			const item = items[this.selected];
			if (item) item.skipped = !item.skipped;
		} else if (data === "x" || data === "d") {
			if (items[this.selected]) {
				items.splice(this.selected, 1);
				if (this.selected >= items.length) this.selected = Math.max(0, items.length - 1);
			}
		} else if (data === "e") {
			const item = items[this.selected];
			if (item) {
				this.editing = true;
				this.buffer = item.text;
			}
		} else if (data === "p") {
			this.state.paused = !this.state.paused;
		} else if (data === "c") {
			this.state.capture = !this.state.capture;
		} else {
			return;
		}
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const items = this.state.items;
		const lines: string[] = [""];

		const pending = items.filter((i) => !i.skipped).length;
		const heading = ` Queue Manager  ${pending}/${items.length}${this.state.capture ? "  ● capture" : ""}${this.state.paused ? "  ⏸ paused" : ""} `;
		lines.push(
			truncateToWidth(
				th.fg("borderMuted", "─".repeat(3)) +
					th.fg("accent", heading) +
					th.fg("borderMuted", "─".repeat(Math.max(0, width - 3 - heading.length))),
				width,
			),
		);
		lines.push("");

		if (items.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "Queue is empty.")}`, width));
		} else {
			items.forEach((item, i) => {
				const sel = i === this.selected;
				if (sel && this.editing) {
					const buf = truncateToWidth(this.buffer, Math.max(10, width - 8), "…");
					lines.push(truncateToWidth(`${th.fg("accent", "→ ✎")} ${buf}${th.fg("accent", "▉")}`, width));
					return;
				}
				const arrow = sel ? th.fg("accent", "→ ") : "  ";
				const mark = item.skipped ? th.fg("dim", "⊘") : th.fg("success", "▶");
				const label = truncateToWidth(item.text.replace(/\s+/g, " ").trim(), Math.max(10, width - 8), "…");
				const styled = item.skipped ? th.fg("dim", label) : sel ? th.fg("accent", label) : th.fg("muted", label);
				lines.push(truncateToWidth(`${arrow}${mark} ${styled}`, width));
			});
		}

		lines.push("");
		const help = this.editing
			? "type to edit   enter save   esc cancel"
			: "↑/↓ move   e edit   s skip/unskip   x remove   c capture   p pause/resume   esc close";
		lines.push(truncateToWidth(`  ${th.fg("dim", help)}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
