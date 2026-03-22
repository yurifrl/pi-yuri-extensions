import type { AssistantMessage } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, matchesKey, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { applyExtensionDefaults } from "./themeMap.ts";

type TaskStatus = "idle" | "inprogress" | "done";

interface Task {
	id: number;
	text: string;
	status: TaskStatus;
}

interface TillDoneDetails {
	action: string;
	tasks: Task[];
	nextId: number;
	listTitle?: string;
	listDescription?: string;
	error?: string;
}

const TillDoneParams = Type.Object({
	action: StringEnum(["new-list", "add", "toggle", "remove", "update", "list", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Task text (for add/update), or list title (for new-list)" })),
	texts: Type.Optional(Type.Array(Type.String(), { description: "Multiple task texts (for add). Use this to batch-add several tasks at once." })),
	description: Type.Optional(Type.String({ description: "List description (for new-list)" })),
	id: Type.Optional(Type.Number({ description: "Task ID (for toggle/remove/update)" })),
});

const STATUS_ICON: Record<TaskStatus, string> = { idle: "○", inprogress: "●", done: "✓" };
const NEXT_STATUS: Record<TaskStatus, TaskStatus> = { idle: "inprogress", inprogress: "done", done: "idle" };
const STATUS_LABEL: Record<TaskStatus, string> = { idle: "idle", inprogress: "in progress", done: "done" };

class TillDoneListComponent {
	private tasks: Task[];
	private title: string | undefined;
	private desc: string | undefined;
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(tasks: Task[], title: string | undefined, desc: string | undefined, theme: Theme, onClose: () => void) {
		this.tasks = tasks;
		this.title = title;
		this.desc = desc;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const heading = this.title
			? th.fg("accent", ` ${this.title} `)
			: th.fg("accent", " TillDone ");
		const headingLen = this.title ? this.title.length + 2 : 10;
		lines.push(truncateToWidth(
			th.fg("borderMuted", "─".repeat(3)) + heading +
			th.fg("borderMuted", "─".repeat(Math.max(0, width - 3 - headingLen))),
			width,
		));

		if (this.desc) {
			lines.push(truncateToWidth(`  ${th.fg("muted", this.desc)}`, width));
		}
		lines.push("");

		if (this.tasks.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No tasks yet. Ask the agent to add some!")}`, width));
		} else {
			const done = this.tasks.filter((t) => t.status === "done").length;
			const active = this.tasks.filter((t) => t.status === "inprogress").length;
			const idle = this.tasks.filter((t) => t.status === "idle").length;

			lines.push(truncateToWidth(
				"  " +
				th.fg("success", `${done} done`) + th.fg("dim", "  ") +
				th.fg("accent", `${active} active`) + th.fg("dim", "  ") +
				th.fg("muted", `${idle} idle`),
				width,
			));
			lines.push("");

			for (const task of this.tasks) {
				const icon = task.status === "done"
					? th.fg("success", STATUS_ICON.done)
					: task.status === "inprogress"
						? th.fg("accent", STATUS_ICON.inprogress)
						: th.fg("dim", STATUS_ICON.idle);
				const id = th.fg("accent", `#${task.id}`);
				const text = task.status === "done"
					? th.fg("dim", task.text)
					: task.status === "inprogress"
						? th.fg("success", task.text)
						: th.fg("muted", task.text);
				lines.push(truncateToWidth(`  ${icon} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	let tasks: Task[] = [];
	let nextId = 1;
	let listTitle: string | undefined;
	let listDescription: string | undefined;
	let nudgedThisCycle = false;

	const makeDetails = (action: string, error?: string): TillDoneDetails => ({
		action,
		tasks: [...tasks],
		nextId,
		listTitle,
		listDescription,
		...(error ? { error } : {}),
	});

	const refreshWidget = (ctx: ExtensionContext) => {
		const current = tasks.find((t) => t.status === "inprogress");

		if (!current) {
			ctx.ui.setWidget("tilldone-current", undefined);
			return;
		}

		ctx.ui.setWidget("tilldone-current", (_tui, theme) => {
			const container = new Container();
			const borderFn = (s: string) => theme.fg("dim", s);

			container.addChild(new Text("", 0, 0));
			container.addChild(new DynamicBorder(borderFn));
			const content = new Text("", 1, 0);
			container.addChild(content);
			container.addChild(new DynamicBorder(borderFn));

			return {
				render(width: number): string[] {
					const cur = tasks.find((t) => t.status === "inprogress");
					if (!cur) return [];

					const line =
						theme.fg("accent", "● ") +
						theme.fg("dim", "WORKING ON  ") +
						theme.fg("accent", `#${cur.id}`) +
						theme.fg("dim", "  ") +
						theme.fg("success", cur.text);

					content.setText(truncateToWidth(line, width - 4));
					return container.render(width);
				},
				invalidate() { container.invalidate(); },
			};
		}, { placement: "belowEditor" });
	};

	const refreshFooter = (ctx: ExtensionContext) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() { unsub(); },
				invalidate() {},
				render(width: number): string[] {
					const done = tasks.filter((t) => t.status === "done").length;
					const active = tasks.filter((t) => t.status === "inprogress").length;
					const idle = tasks.filter((t) => t.status === "idle").length;
					const total = tasks.length;

					const titleDisplay = listTitle
						? theme.fg("accent", ` ${listTitle} `)
						: theme.fg("dim", " TillDone ");

					const taskSummary = total === 0
						? titleDisplay + theme.fg("muted", "no tasks")
						: titleDisplay +
							theme.fg("warning", "[") +
							theme.fg("success", `${done}`) +
							theme.fg("dim", "/") +
							theme.fg("success", `${total}`) +
							theme.fg("warning", "]") +
							theme.fg("dim", "  ") +
							theme.fg("dim", STATUS_ICON.idle + " ") + theme.fg("muted", `${idle}`) +
							theme.fg("dim", "  ") +
							theme.fg("accent", STATUS_ICON.inprogress + " ") + theme.fg("accent", `${active}`) +
							theme.fg("dim", "  ") +
							theme.fg("success", STATUS_ICON.done + " ") + theme.fg("success", `${done}`);

					let input = 0, output = 0, cost = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							input += m.usage.input;
							output += m.usage.output;
							cost += m.usage.cost.total;
						}
					}

					const usage = ctx.getContextUsage();
					const pct = usage?.percent ?? 0;
					const pctColor = pct > 75 ? "error" : pct > 50 ? "warning" : "success";

					function fmt(n: number): string {
						if (n < 1000) return `${n}`;
						return `${(n / 1000).toFixed(1)}k`;
					}

					const tokenStats = [
						theme.fg("accent", `${fmt(input)}/${fmt(output)}`),
						theme.fg("warning", `$${cost.toFixed(2)}`),
						theme.fg(pctColor, `${pct.toFixed(0)}%`),
					].join(" ");

					const parts = process.cwd().split("/");
					const short = parts.length > 2 ? parts.slice(-2).join("/") : process.cwd();
					const cwdStr = theme.fg("muted", `⌂ ${short}`);

					const branch = footerData.getGitBranch();
					const branchStr = branch ? theme.fg("accent", `⎇ ${branch}`) : "";

					const thinking = pi.getThinkingLevel();
					const thinkColor = thinking === "high" ? "warning" : thinking === "medium" ? "accent" : thinking === "low" ? "dim" : "muted";
					const modelId = ctx.model?.id || "no-model";
					const modelStr = theme.fg(thinkColor, "◆") + " " + theme.fg("accent", modelId);

					const sep = theme.fg("dim", " | ");
					const metaParts = [modelStr, tokenStats, cwdStr];
					if (branchStr) metaParts.push(branchStr);
					const metaSummary = metaParts.join(sep);

					const minGap = 3;
					const leftWidth = visibleWidth(taskSummary);
					const rightWidth = visibleWidth(metaSummary);
					const combined = leftWidth + minGap + rightWidth;

					const line1 = combined <= width
						? taskSummary + " ".repeat(Math.max(minGap, width - leftWidth - rightWidth)) + metaSummary
						: truncateToWidth(taskSummary + sep + metaSummary, width, "");

					if (total === 0) return [line1];

					const activeTasks = tasks.filter((t) => t.status === "inprogress");
					const doneTasks = tasks.filter((t) => t.status === "done").reverse();
					const visible = [...activeTasks, ...doneTasks].slice(0, 5);
					const remaining = total - visible.length;

					const rows = visible.map((t) => {
						const icon = t.status === "done"
							? theme.fg("success", STATUS_ICON.done)
							: theme.fg("accent", STATUS_ICON.inprogress);
						const text = t.status === "done"
							? theme.fg("dim", t.text)
							: theme.fg("success", t.text);
						return truncateToWidth(` ${icon} ${text}`, width, "");
					});

					if (remaining > 0) {
						rows.push(truncateToWidth(` ${theme.fg("dim", `  +${remaining} more`)}`, width, ""));
					}

					return [line1, ...rows];
				},
			};
		});
	};

	const refreshUI = (ctx: ExtensionContext) => {
		if (tasks.length === 0) {
			ctx.ui.setStatus("📋 TillDone: no tasks", "tilldone");
		} else {
			const remaining = tasks.filter((t) => t.status !== "done").length;
			const label = listTitle ? `📋 ${listTitle}` : "📋 TillDone";
			ctx.ui.setStatus(`${label}: ${tasks.length} tasks (${remaining} remaining)`, "tilldone");
		}

		refreshWidget(ctx);
		refreshFooter(ctx);
	};

	const reconstructState = (ctx: ExtensionContext) => {
		tasks = [];
		nextId = 1;
		listTitle = undefined;
		listDescription = undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "tilldone") continue;

			const details = msg.details as TillDoneDetails | undefined;
			if (details) {
				tasks = details.tasks;
				nextId = details.nextId;
				listTitle = details.listTitle;
				listDescription = details.listDescription;
			}
		}

		refreshUI(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		reconstructState(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_fork", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	pi.on("tool_call", async (event, _ctx) => {
		if (event.toolName === "tilldone") return { block: false };

		const pending = tasks.filter((t) => t.status !== "done");
		const active = tasks.filter((t) => t.status === "inprogress");

		if (tasks.length === 0) {
			return {
				block: true,
				reason: "🚫 No TillDone tasks defined. You MUST use `tilldone new-list` or `tilldone add` to define your tasks before using any other tools. Plan your work first!",
			};
		}
		if (pending.length === 0) {
			return {
				block: true,
				reason: "🚫 All TillDone tasks are done. You MUST use `tilldone add` for new tasks or `tilldone new-list` to start a fresh list before using any other tools.",
			};
		}
		if (active.length === 0) {
			return {
				block: true,
				reason: "🚫 No task is in progress. You MUST use `tilldone toggle` to mark a task as inprogress before doing any work.",
			};
		}

		return { block: false };
	});

	pi.on("agent_end", async (_event, _ctx) => {
		const incomplete = tasks.filter((t) => t.status !== "done");
		if (incomplete.length === 0 || nudgedThisCycle) return;

		nudgedThisCycle = true;

		const taskList = incomplete
			.map((t) => `  ${STATUS_ICON[t.status]} #${t.id} [${STATUS_LABEL[t.status]}]: ${t.text}`)
			.join("\n");

		pi.sendMessage(
			{
				customType: "tilldone-nudge",
				content: `⚠️ You still have ${incomplete.length} incomplete task(s):\n\n${taskList}\n\nEither continue working on them or mark them done with \`tilldone toggle\`. Don't stop until it's done!`,
				display: true,
			},
			{ triggerTurn: true },
		);
	});

	pi.on("input", async () => {
		nudgedThisCycle = false;
		return { action: "continue" as const };
	});

	pi.registerTool({
		name: "tilldone",
		label: "TillDone",
		description:
			"Manage your task list. You MUST add tasks before using any other tools. " +
			"Actions: new-list (text=title, description), add (text or texts[] for batch), toggle (id) — cycles idle→inprogress→done, remove (id), update (id + text), list, clear. " +
			"Always toggle a task to inprogress before starting work on it, and to done when finished. " +
			"Use new-list to start a themed list with a title and description. " +
			"IMPORTANT: If the user's new request does not fit the current list's theme, use clear to wipe the slate and new-list to start fresh.",
		parameters: TillDoneParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "new-list": {
					if (!params.text) {
						return {
							content: [{ type: "text" as const, text: "Error: text (title) required for new-list" }],
							details: makeDetails("new-list", "text required"),
						};
					}

					if (tasks.length > 0 || listTitle) {
						const confirmed = await ctx.ui.confirm(
							"Start a new list?",
							`This will replace${listTitle ? ` \"${listTitle}\"` : " the current list"} (${tasks.length} task(s)). Continue?`,
							{ timeout: 30000 },
						);
						if (!confirmed) {
							return {
								content: [{ type: "text" as const, text: "New list cancelled by user." }],
								details: makeDetails("new-list", "cancelled"),
							};
						}
					}

					tasks = [];
					nextId = 1;
					listTitle = params.text;
					listDescription = params.description || undefined;

					const result = {
						content: [{
							type: "text" as const,
							text: `New list: \"${listTitle}\"${listDescription ? ` — ${listDescription}` : ""}`,
						}],
						details: makeDetails("new-list"),
					};
					refreshUI(ctx);
					return result;
				}

				case "add": {
					const rawTexts = params.texts?.length ? params.texts : (params.text ? [params.text] : []);
					const normalized = rawTexts.map((t) => t.trim()).filter(Boolean);
					if (normalized.length === 0) {
						return {
							content: [{ type: "text" as const, text: "Error: text or texts[] required for add" }],
							details: makeDetails("add", "text or texts[] required"),
						};
					}

					const added = normalized.map((text) => {
						const task: Task = { id: nextId++, text, status: "idle" };
						tasks.push(task);
						return task;
					});

					const msg = added.length === 1
						? `Added task #${added[0].id}: ${added[0].text}`
						: `Added ${added.length} tasks: ${added.map((t) => `#${t.id}`).join(", ")}`;
					const result = {
						content: [{ type: "text" as const, text: msg }],
						details: makeDetails("add"),
					};
					refreshUI(ctx);
					return result;
				}

				case "list":
					return {
						content: [{ type: "text" as const, text: `${tasks.length} task(s)` }],
						details: makeDetails("list"),
					};

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for toggle" }],
							details: makeDetails("toggle", "id required"),
						};
					}
					const task = tasks.find((t) => t.id === params.id);
					if (!task) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("toggle", `#${params.id} not found`),
						};
					}

					if (task.status !== "done") {
						for (const t of tasks) {
							if (t.id !== task.id && t.status === "inprogress") {
								t.status = "idle";
							}
						}
					}

					const from = task.status;
					task.status = NEXT_STATUS[task.status];
					const msg = `Task #${task.id}: ${STATUS_LABEL[from]} → ${STATUS_LABEL[task.status]}`;
					const result = {
						content: [{ type: "text" as const, text: msg }],
						details: makeDetails("toggle"),
					};
					refreshUI(ctx);
					return result;
				}

				case "remove": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for remove" }],
							details: makeDetails("remove", "id required"),
						};
					}
					const idx = tasks.findIndex((t) => t.id === params.id);
					if (idx === -1) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("remove", `#${params.id} not found`),
						};
					}
					const removed = tasks.splice(idx, 1)[0];
					const result = {
						content: [{ type: "text" as const, text: `Removed task #${removed.id}: ${removed.text}` }],
						details: makeDetails("remove"),
					};
					refreshUI(ctx);
					return result;
				}

				case "update": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for update" }],
							details: makeDetails("update", "id required"),
						};
					}
					if (!params.text) {
						return {
							content: [{ type: "text" as const, text: "Error: text required for update" }],
							details: makeDetails("update", "text required"),
						};
					}
					const toUpdate = tasks.find((t) => t.id === params.id);
					if (!toUpdate) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("update", `#${params.id} not found`),
						};
					}
					const oldText = toUpdate.text;
					toUpdate.text = params.text;
					const result = {
						content: [{ type: "text" as const, text: `Updated #${toUpdate.id}: \"${oldText}\" → \"${toUpdate.text}\"` }],
						details: makeDetails("update"),
					};
					refreshUI(ctx);
					return result;
				}

				case "clear": {
					if (tasks.length > 0) {
						const confirmed = await ctx.ui.confirm(
							"Clear TillDone list?",
							`This will remove all ${tasks.length} task(s)${listTitle ? ` from \"${listTitle}\"` : ""}. Continue?`,
							{ timeout: 30000 },
						);
						if (!confirmed) {
							return {
								content: [{ type: "text" as const, text: "Clear cancelled by user." }],
								details: makeDetails("clear", "cancelled"),
							};
						}
					}

					const count = tasks.length;
					tasks = [];
					nextId = 1;
					listTitle = undefined;
					listDescription = undefined;

					const result = {
						content: [{ type: "text" as const, text: `Cleared ${count} task(s)` }],
						details: makeDetails("clear"),
					};
					refreshUI(ctx);
					return result;
				}

				default:
					return {
						content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
						details: makeDetails("list", `unknown action: ${params.action}`),
					};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("tilldone ")) + theme.fg("muted", args.action);
			if (args.texts?.length) text += ` ${theme.fg("dim", `${args.texts.length} tasks`)}`;
			else if (args.text) text += ` ${theme.fg("dim", `\"${args.text}\"`)}`;
			if (args.description) text += ` ${theme.fg("dim", `— ${args.description}`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TillDoneDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const taskList = details.tasks;

			switch (details.action) {
				case "new-list": {
					let msg = theme.fg("success", "✓ New list ") + theme.fg("accent", `\"${details.listTitle}\"`);
					if (details.listDescription) {
						msg += theme.fg("dim", ` — ${details.listDescription}`);
					}
					return new Text(msg, 0, 0);
				}

				case "list": {
					if (taskList.length === 0) return new Text(theme.fg("dim", "No tasks"), 0, 0);

					let listText = "";
					if (details.listTitle) {
						listText += theme.fg("accent", details.listTitle) + theme.fg("dim", "  ");
					}
					listText += theme.fg("muted", `${taskList.length} task(s):`);
					const display = expanded ? taskList : taskList.slice(0, 5);
					for (const t of display) {
						const icon = t.status === "done"
							? theme.fg("success", STATUS_ICON.done)
							: t.status === "inprogress"
								? theme.fg("accent", STATUS_ICON.inprogress)
								: theme.fg("dim", STATUS_ICON.idle);
						const itemText = t.status === "done"
							? theme.fg("dim", t.text)
							: t.status === "inprogress"
								? theme.fg("success", t.text)
								: theme.fg("muted", t.text);
						listText += `\n${icon} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && taskList.length > 5) {
						listText += `\n${theme.fg("dim", `... ${taskList.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "toggle": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("accent", "⟳ ") + theme.fg("muted", msg), 0, 0);
				}

				case "remove": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("warning", "✕ ") + theme.fg("muted", msg), 0, 0);
				}

				case "update": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all tasks"), 0, 0);

				default:
					return new Text(theme.fg("dim", "done"), 0, 0);
			}
		},
	});

	pi.registerCommand("tilldone", {
		description: "Show all TillDone tasks on the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/tilldone requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TillDoneListComponent(tasks, listTitle, listDescription, theme, () => done());
			});
		},
	});
}
