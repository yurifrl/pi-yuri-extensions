/**
 * Handoff — carry the current session into a fresh one as a compact briefing.
 *
 * Serializes the full conversation branch (including all tool output) and sends it to the session model with a fixed
 * prompt: produce Context / Current state / Files & artifacts / Open questions, reference paths and SHAs instead of
 * duplicating content, redact secrets in the result. An optional focus argument narrows the summary. The raw transcript
 * is not redacted before sending, so the request is gated behind a confirm that states the payload scope.
 *
 * /handoff [focus] — confirm → edit the generated handoff → a new child session opens with it in the composer; submit
 * to continue. Requires an interactive session with a selected model. Disable: "modules": { "handoff": false }.
 */
import { complete } from "@oh-my-pi/pi-ai";
import { convertToLlm, type ExtensionAPI, type SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { serializeConversation } from "@oh-my-pi/pi-agent-core/compaction";

const HANDOFF_PROMPT = `Write a concise markdown handoff for a fresh coding-agent session. Output only: Context, Current state, Files & artifacts, Open questions / next steps. Reference paths, URLs, and commit SHAs instead of duplicating content. Redact secrets.`;

function responseText(content: { type: string; text?: string }[]): string {
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export default function handoff(pi: ExtensionAPI): void {
	pi.registerCommand("handoff", {
		description: "Generate, edit, and start a fresh session from a compact handoff",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || !ctx.model) {
				ctx.ui.notify("Handoff requires an interactive session with a selected model.", "error");
				return;
			}
			const messages = ctx.sessionManager
				.getBranch()
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);
			if (messages.length === 0) {
				ctx.ui.notify("No conversation to hand off.", "error");
				return;
			}
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok || !auth.apiKey) {
				ctx.ui.notify(auth.ok ? "No API key for the current model." : auth.error, "error");
				return;
			}
			const guidance =
				args.trim() || (await ctx.ui.input("Handoff focus (optional)", "Enter to summarize the full session"))?.trim() || "";
			const messageCount = messages.length;
			const firstTimestamp = messages[0]?.timestamp;
			const sessionAge = firstTimestamp ? Math.max(1, Math.round((Date.now() - firstTimestamp) / 3_600_000)) : 0;
			const scope = `${messageCount} messages${sessionAge > 0 ? ` spanning ~${sessionAge}h` : ""}`;
			// The payload is the full serialized conversation, including every tool
			// result: file dumps, command output, anything the session has touched.
			// Make sure the user knows what is about to leave the machine.
			const confirmed = await ctx.ui.confirm(
				"Send handoff request",
				`The full session transcript (${scope}, including all tool output) will be sent to ${ctx.model.provider}/${ctx.model.id} for summarization. Continue?`,
			);
			if (!confirmed) return;
			const response = await complete(
				ctx.model,
				{
					systemPrompt: [HANDOFF_PROMPT],
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: `${serializeConversation(convertToLlm(messages))}\n\nFocus: ${guidance || "all current work"}`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers },
			);
			const edited = await ctx.ui.editor("Edit handoff", responseText(response.content));
			if (edited === undefined || edited.trim() === "") return;
			const parentSession = ctx.sessionManager.getSessionFile();
			const next = await ctx.newSession({ parentSession });
			if (next.cancelled) return;
			ctx.ui.setEditorText(edited);
			ctx.ui.notify("Handoff loaded. Submit to continue.", "info");
		},
	});
}
