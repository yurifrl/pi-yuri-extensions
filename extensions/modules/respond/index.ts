/**
 * Respond — answer a past assistant message by editing it.
 *
 * Walks the active branch backwards, collects assistant text, and opens the Nth latest (1 = most recent) in omp's
 * editor. The edited text goes to the composer, not the transcript — submit it to send your reply.
 *
 * /respond [N] — N defaults to 1; errors list how many assistant messages exist. Disable: "modules": { "respond": false }.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Entry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

function assistantText(entry: Entry): string | undefined {
	if (entry.type !== "message" || entry.message?.role !== "assistant") return undefined;
	const { content } = entry.message;
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text || undefined;
}

export default function respond(pi: ExtensionAPI): void {
	pi.registerCommand("respond", {
		description: "Edit a previous assistant message and place it in the composer: /respond [N]",
		handler: async (args, ctx) => {
			const count = Number.parseInt(args.trim() || "1", 10);
			if (!Number.isInteger(count) || count < 1) {
				ctx.ui.notify("Usage: /respond [positive message number]", "error");
				return;
			}
			const messages = ctx.sessionManager
				.getBranch()
				.slice()
				.reverse()
				.map((entry) => assistantText(entry as Entry))
				.filter((text): text is string => text !== undefined);
			const source = messages[count - 1];
			if (!source) {
				ctx.ui.notify(`Only found ${messages.length} assistant message${messages.length === 1 ? "" : "s"}.`, "error");
				return;
			}
			const edited = await ctx.ui.editor(`Respond to assistant message #${count}`, source);
			if (edited === undefined || edited.trim() === "") return;
			ctx.ui.setEditorText(edited.trim());
			ctx.ui.notify("Edited assistant message loaded into the composer.", "info");
		},
	});
}
