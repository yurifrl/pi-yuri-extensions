import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Box, Container, type SelectItem, SelectList, Spacer, Text } from "@mariozechner/pi-tui";

type PromptRecord = {
	index: number;
	text: string;
};

type WhatCommandContext = {
	sessionManager: {
		getBranch(): Array<any>;
	};
	ui: any;
	hasUI: boolean;
};

function extractUserText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";

	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			if (!("type" in block)) return "";
			if (block.type === "text" && "text" in block && typeof block.text === "string") {
				return block.text;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

function getPromptRecords(ctx: WhatCommandContext): PromptRecord[] {
	return ctx.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message" && entry.message?.role === "user")
		.map((entry, index) => ({ index: index + 1, text: extractUserText(entry.message.content) }))
		.filter((entry) => entry.text.length > 0);
}

function promptPreview(text: string, max = 72): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= max) return singleLine;
	return `${singleLine.slice(0, max - 1)}…`;
}

function promptStats(text: string): string {
	const lines = text.split("\n").length;
	const chars = text.length;
	return `${lines} line${lines === 1 ? "" : "s"} • ${chars} char${chars === 1 ? "" : "s"}`;
}

async function showPromptPicker(
	ctx: WhatCommandContext,
	prompts: PromptRecord[],
): Promise<number | null> {
	const items: SelectItem[] = prompts.map((prompt) => ({
		value: String(prompt.index),
		label: `${prompt.index}. ${promptPreview(prompt.text)}`,
		description: promptStats(prompt.text),
	}));

	return ctx.ui.custom<number | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Browse Prompts")), 1, 0));
		container.addChild(new Text(theme.fg("dim", "Pick a prompt to open. Use /what <number> to jump directly."), 1, 0));
		container.addChild(new Spacer(1));

		const selectList = new SelectList(items, Math.min(Math.max(items.length, 3), 12), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		selectList.onSelect = (item) => done(Number(item.value));
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter open • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	}, {
		overlay: true,
		overlayOptions: { width: "70%", maxHeight: "80%", anchor: "center", margin: 1 },
	});
}

function emitPrompt(pi: ExtensionAPI, prompt: PromptRecord, total: number): void {
	pi.sendMessage({
		customType: "what-prompt",
		content: prompt.text,
		display: true,
		details: {
			index: prompt.index,
			total,
			stats: promptStats(prompt.text),
			title: promptPreview(prompt.text, 48),
		},
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer("what-prompt", (message, _options, theme) => {
		const details = (message.details || {}) as { index?: number; total?: number; stats?: string; title?: string };
		const header = `Prompt ${details.index ?? "?"}/${details.total ?? "?"}`;
		const subtitle = details.stats ? `${details.stats}` : details.title || "";

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", theme.bold(header)), 0, 0));
		if (subtitle) {
			box.addChild(new Text(theme.fg("dim", subtitle), 0, 0));
			box.addChild(new Spacer(1));
		}
		box.addChild(new Text(String(message.content || ""), 0, 0));
		return box;
	});

	pi.registerCommand("what", {
		description: "Browse previous user prompts from the current session, or open one by number",
		handler: async (args, ctx) => {
			const prompts = getPromptRecords(ctx);
			if (prompts.length === 0) {
				ctx.ui.notify("No previous user prompts found in this session.", "warning");
				return;
			}

			const trimmed = args.trim();
			if (trimmed.length > 0) {
				if (!/^\d+$/.test(trimmed)) {
					ctx.ui.notify("Usage: /what or /what <number>", "warning");
					return;
				}

				const promptNumber = Number(trimmed);
				const selected = prompts.find((prompt) => prompt.index === promptNumber);
				if (!selected) {
					ctx.ui.notify(`Prompt ${promptNumber} not found. Available: 1-${prompts.length}.`, "warning");
					return;
				}

				emitPrompt(pi, selected, prompts.length);
				return;
			}

			if (!ctx.hasUI) {
				emitPrompt(pi, prompts[prompts.length - 1]!, prompts.length);
				return;
			}

			const selectedIndex = await showPromptPicker(ctx, prompts);
			if (selectedIndex == null) return;

			const selected = prompts.find((prompt) => prompt.index === selectedIndex);
			if (!selected) return;
			emitPrompt(pi, selected, prompts.length);
		},
	});
}
