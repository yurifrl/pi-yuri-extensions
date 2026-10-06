/**
 * Respond — answer a past assistant message by editing it in the composer.
 *
 * /respond opens a /copy-style picker of assistant messages (latest first); the picked text lands
 * directly in the composer — edit inline and submit to send your reply. /respond [N] skips the
 * picker and loads the Nth latest (1 = most recent). Disable: "modules": { "respond": false }.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type TextPart = { type: "text"; text: string };

function isTextPart(part: unknown): part is TextPart {
	return (
		typeof part === "object" &&
		part !== null &&
		"type" in part &&
		part.type === "text" &&
		"text" in part &&
		typeof part.text === "string"
	);
}

function assistantText(entry: unknown): string | undefined {
	if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "message") {
		return undefined;
	}
	const message = "message" in entry ? entry.message : undefined;
	if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "assistant") {
		return undefined;
	}
	const content = "content" in message ? message.content : undefined;
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter(isTextPart)
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text || undefined;
}

/** First non-empty line, whitespace-collapsed — the /copy selector's label style. */
function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed.replace(/\s+/g, " ");
	}
	return "(empty)";
}

/** How many messages the picker lists; older ones stay reachable via /respond <N>. */
const PICKER_LIMIT = 15;

export default function respond(pi: ExtensionAPI): void {
	pi.registerCommand("respond", {
		description: "Respond to a previous assistant message: pick one, edit in the composer, submit",
		handler: async (args, ctx) => {
			const messages = ctx.sessionManager
				.getBranch()
				.slice()
				.reverse()
				.map((entry) => assistantText(entry))
				.filter((text): text is string => text !== undefined);
			if (messages.length === 0) {
				ctx.ui.notify("No assistant messages to respond to.", "error");
				return;
			}

			const arg = args.trim();
			let index: number;
			if (arg === "") {
				const options = messages.slice(0, PICKER_LIMIT).map((text, i) => {
					const lines = text.split("\n").length;
					return `#${i + 1}  ${firstLine(text)}  ·  ${lines} line${lines === 1 ? "" : "s"}`;
				});
				const picked = await ctx.ui.select("Respond to assistant message", options);
				if (picked === undefined) return;
				const match = /^#(\d+)/.exec(picked);
				const pickedIndex = match === null ? Number.NaN : Number.parseInt(match[1]!, 10) - 1;
				if (!Number.isInteger(pickedIndex) || pickedIndex < 0 || pickedIndex >= messages.length) {
					ctx.ui.notify("Could not resolve the selected message.", "error");
					return;
				}
				index = pickedIndex;
			} else {
				const count = Number.parseInt(arg, 10);
				if (!Number.isInteger(count) || count < 1) {
					ctx.ui.notify("Usage: /respond [N]", "error");
					return;
				}
				if (count > messages.length) {
					ctx.ui.notify(
						`Only found ${messages.length} assistant message${messages.length === 1 ? "" : "s"}.`,
						"error",
					);
					return;
				}
				index = count - 1;
			}

			ctx.ui.setEditorText(messages[index]!.trim());
			ctx.ui.notify(`Assistant message #${index + 1} loaded into the composer — submit to send.`, "info");
		},
	});
}
