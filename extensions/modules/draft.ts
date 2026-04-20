import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";

const STATUS_KEY = "pi-draft";
const WRITE_LIKE_TOOLS = new Set(["edit", "write", "ast_rewrite"]);

const DRAFT_TOOL_CANDIDATES = [
	"read", "bash", "grep", "find", "ls", "lsp", "ast_search",
	"web_search", "fetch_content", "get_search_content", "draft_write",
] as const;

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i,
	/\btouch\b/i, /\bchmod\b/i, /\bchown\b/i, /\bln\b/i, /\btee\b/i,
	/\btruncate\b/i, /\bdd\b/i, /\bshred\b/i,
	/(^|[^<])>(?!>)/, />>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)\b/i,
	/\byarn\s+(add|remove|install|publish)\b/i,
	/\bpnpm\s+(add|remove|install|publish)\b/i,
	/\bpip\s+(install|uninstall)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)\b/i,
	/\bsudo\b/i, /\bkill\b/i, /\bpkill\b/i, /\bkillall\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*less\b/, /^\s*more\b/,
	/^\s*grep\b/, /^\s*find\b/, /^\s*ls\b/, /^\s*pwd\b/, /^\s*echo\b/,
	/^\s*wc\b/, /^\s*sort\b/, /^\s*uniq\b/, /^\s*diff\b/, /^\s*file\b/,
	/^\s*stat\b/, /^\s*du\b/, /^\s*df\b/, /^\s*tree\b/, /^\s*which\b/,
	/^\s*type\b/, /^\s*env\b/, /^\s*printenv\b/, /^\s*uname\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)\b/i,
	/^\s*git\s+ls-/i,
	/^\s*jq\b/, /^\s*sed\s+-n\b/i, /^\s*awk\b/, /^\s*rg\b/, /^\s*fd\b/,
];

function isSafeReadOnlyCommand(command: string): boolean {
	if (DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) return false;
	return SAFE_PATTERNS.some((p) => p.test(command));
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60) || "draft";
}

function timestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

const DraftWriteParams = Type.Object({
	action: StringEnum(["create", "update", "append", "list", "read"] as const),
	name: Type.Optional(
		Type.String({
			description:
				"Short slug or title for the draft (used for create/update/append/read). Ex: 'recorder-architecture'. Ignored for list.",
		}),
	),
	content: Type.Optional(
		Type.String({ description: "Full draft body (markdown). Required for create/update/append." }),
	),
});

const DRAFT_SYSTEM_PROMPT = `
[DRAFT MODE ACTIVE - READ ONLY]
You are in draft mode — a thinking and organizing space, NOT an implementation or research session.

Your job is to take the user's raw ideas and organize them. That's it.

## Your role
- Organize the user's ideas into a clear, structured draft
- Scope the idea — what's in, what's out
- Set a clear goal from the user's words
- Correct grammar, refactor sentences for clarity
- Group related ideas, remove disconnects
- Be ruthlessly concise — every word must earn its place
- Don't expand — organize what's there, don't add new ideas unless asked

## The Stance
- You are a thinking partner, not a researcher or implementer
- Listen first — the user's words are the material, not the codebase
- Curious, not prescriptive — ask questions that emerge naturally
- Patient — don't rush to conclusions, let the shape of the problem emerge
- Visual — use ASCII diagrams when they help clarify thinking

## Research Policy — MINIMAL
- Do NOT proactively research, explore the codebase, or gather context
- Do NOT read files, search code, or investigate unless you genuinely don't understand something the user said
- The ONLY reason to use a tool is: "I don't know what the user means by X, I need to look it up to organize their idea correctly"
- If the user's idea is clear enough to organize, organize it — don't go looking for more
- Never research to validate, expand, or enrich the draft — that's not your job here

## What a Draft IS
- The user's ideas, organized and clarified
- A goal statement — what are we trying to achieve
- Key components — what pieces exist and how they connect
- Key decisions and constraints
- Open questions — things still TBD
- Scoping — what's in, what's out

## What a Draft is NOT
- ❌ Implementation plans or code
- ❌ Research reports
- ❌ Codebase exploration results
- ❌ Step-by-step tutorials
- ❌ Expanded ideas the user didn't ask for

## Saving drafts
Use the \`draft_write\` tool to save drafts. It handles paths automatically — you do NOT pick file paths, names, or directories.
- \`draft_write(action='create', name='short-slug', content='<markdown>')\` — new draft file
- \`draft_write(action='update', name='short-slug', content='<markdown>')\` — replace existing
- \`draft_write(action='append', name='short-slug', content='<markdown>')\` — append to existing
- \`draft_write(action='list')\` — list existing drafts
- \`draft_write(action='read', name='short-slug')\` — read a draft

Do NOT use edit/write/bash to save the draft. Only use \`draft_write\`.

## Output format — IMPORTANT
ALWAYS print the FULL draft as your assistant reply FIRST (as rendered markdown), THEN call \`draft_write\` to save it.
Tool outputs are shown as a compact block in the UI; only assistant replies render with full markdown (headings, tables, code blocks, lists).
So the user sees the nice rendered version via your reply, and the saved file is a persistence artifact.

Flow per turn when producing/updating a draft:
1. Write the full draft content as your assistant message (markdown, fully formatted).
2. Call \`draft_write\` with the same content to persist.
3. End with a one-line confirmation of what was saved and where.

## Hard rules
- Never perform any write/change action on code files
- Never use edit/write or mutating shell commands
- The ONLY file you may write to is the draft file itself (in .agents/drafts/)
- Do NOT use tools unless you genuinely need to understand something the user said

## Draft structure
When writing a draft file, use this format:

\`\`\`markdown
# [Name]
[1-2 sentence overview of what this solves]

> Note: This is a draft to organize ideas and scope before implementation.

## Goal
[What we're trying to achieve]

## Architecture
[2-3 sentences on approach]

## Components
- Component A: [one line]
- Component B: [one line]

## Key Decisions
- Why X not Y
- Critical constraint

## Open Questions
- Things still TBD

## Implementation Notes
- Relevant tech/library notes
\`\`\`

## Location
Write drafts to \`.agents/drafts/\`
`.trim();

function notify(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	pi.sendMessage({ customType: "draft-mode-status", content: message, display: true });
}

export default function draftExtension(pi: ExtensionAPI): void {
	let draftModeEnabled = false;
	let restoreTools: string[] | null = null;

	const getAllToolNames = (): string[] => pi.getAllTools().map((t) => t.name);

	const getDraftTools = (): string[] => {
		const available = new Set(getAllToolNames());
		const tools = DRAFT_TOOL_CANDIDATES.filter((t) => available.has(t));
		if (tools.length > 0) return [...tools];
		return pi.getActiveTools().filter((t) => !WRITE_LIKE_TOOLS.has(t));
	};

	const restoreNormalTools = (): void => {
		const tools = restoreTools?.length ? [...restoreTools] : [...getAllToolNames()];
		if (tools.length > 0) pi.setActiveTools(tools);
		restoreTools = null;
	};

	const setStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			STATUS_KEY,
			draftModeEnabled ? ctx.ui.theme.fg("warning", "✏️  draft") : undefined,
		);
	};

	const enterDraftMode = (ctx: ExtensionContext): void => {
		if (draftModeEnabled) return; // already on, no-op

		const currentTools = pi.getActiveTools();
		restoreTools = currentTools.length > 0 ? [...currentTools] : null;

		const draftTools = getDraftTools();
		if (draftTools.length === 0) {
			notify(pi, ctx, "No read-only tool set could be resolved.", "error");
			return;
		}

		pi.setActiveTools(draftTools);
		draftModeEnabled = true;
		setStatus(ctx);
		notify(pi, ctx, "Draft mode enabled — thinking space, read-only");
	};

	const exitDraftMode = (ctx: ExtensionContext): void => {
		if (!draftModeEnabled) return;
		draftModeEnabled = false;
		restoreNormalTools();
		setStatus(ctx);
		notify(pi, ctx, "Draft mode off");
	};

	pi.registerTool({
		name: "draft_write",
		label: "DraftWrite",
		description:
			"Save, read, or list drafts. This is the ONLY way to persist drafts in draft mode. " +
			"File paths are handled for you — drafts live in `<cwd>/.agents/drafts/<slug>.md`. " +
			"Actions: create (new draft), update (replace), append (add to end), list, read.",
		parameters: DraftWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
			const draftsDir = path.join(cwd, ".agents", "drafts");

			try {
				await fs.mkdir(draftsDir, { recursive: true });

				if (params.action === "list") {
					let entries: string[] = [];
					try {
						entries = (await fs.readdir(draftsDir))
							.filter((f) => f.endsWith(".md"))
							.sort();
					} catch {
						entries = [];
					}
					const body =
						entries.length === 0
							? "No drafts yet."
							: `Drafts in ${draftsDir}:\n${entries.map((e) => `- ${e}`).join("\n")}`;
					return {
						content: [{ type: "text" as const, text: body }],
						details: { action: "list", dir: draftsDir, entries },
					};
				}

				const name = (params.name ?? "").trim();
				if (!name) {
					return {
						content: [
							{ type: "text" as const, text: "Error: `name` required for this action." },
						],
						details: { action: params.action, error: "name required" },
					};
				}
				const slug = slugify(name);
				const filename = `${slug}.md`;
				const filepath = path.join(draftsDir, filename);

				if (params.action === "read") {
					try {
						const text = await fs.readFile(filepath, "utf8");
						return {
							content: [{ type: "text" as const, text }],
							details: { action: "read", path: filepath },
						};
					} catch {
						return {
							content: [
								{ type: "text" as const, text: `Draft not found: ${filepath}` },
							],
							details: { action: "read", path: filepath, error: "not found" },
						};
					}
				}

				const content = params.content ?? "";
				if (!content) {
					return {
						content: [
							{ type: "text" as const, text: "Error: `content` required for this action." },
							],
						details: { action: params.action, error: "content required" },
					};
				}

				if (params.action === "create") {
					let finalPath = filepath;
					try {
						await fs.access(finalPath);
						// exists — suffix with timestamp to avoid overwrite
						finalPath = path.join(draftsDir, `${slug}-${timestamp()}.md`);
					} catch {
						// does not exist, good
					}
					await fs.writeFile(finalPath, content, "utf8");
					return {
						content: [
							{ type: "text" as const, text: `Draft saved: ${finalPath} (${content.length} chars)` },
						],
						details: { action: "create", path: finalPath },
					};
				}

				if (params.action === "update") {
					await fs.writeFile(filepath, content, "utf8");
					return {
						content: [
							{ type: "text" as const, text: `Draft updated: ${filepath} (${content.length} chars)` },
						],
						details: { action: "update", path: filepath },
					};
				}

				if (params.action === "append") {
					const appended = (content.startsWith("\n") ? "" : "\n") + content;
					await fs.appendFile(filepath, appended, "utf8");
					return {
						content: [
							{ type: "text" as const, text: `Appended to draft: ${filepath} (+${content.length} chars)` },
						],
						details: { action: "append", path: filepath },
					};
				}

				return {
					content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
					details: { action: params.action, error: "unknown action" },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `draft_write failed: ${message}` }],
					details: { action: params.action, error: message },
				};
			}
		},
	});

	pi.registerCommand("draft", {
		description: "Enter draft mode to scope and organize ideas. /draft to toggle, /draft <text> to start drafting",
		handler: async (args, ctx) => {
			const raw = args.trim();

			// No args: toggle
			if (raw.length === 0) {
				if (draftModeEnabled) {
					exitDraftMode(ctx);
				} else {
					enterDraftMode(ctx);
				}
				return;
			}

			// /draft <text>: enter draft mode (if not already) and send text
			enterDraftMode(ctx);
			pi.sendUserMessage(raw);
		},
	});

	// Block write tools in draft mode
	pi.on("tool_call", async (event) => {
		if (!draftModeEnabled) return;

		// All general write tools are blocked. Saving goes through draft_write.
		if (WRITE_LIKE_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason:
					"Draft mode is read-only. Use the `draft_write` tool to save drafts (handles path + naming automatically). Exit draft mode (/draft) for code changes.",
			};
		}

		if (event.toolName === "bash") {
			const input = event.input as { command?: unknown };
			const command = typeof input.command === "string" ? input.command : "";
			if (isSafeReadOnlyCommand(command)) return;
			return {
				block: true,
				reason:
					"Draft mode blocks mutating bash. Use the `draft_write` tool to save drafts.",
			};
		}
	});

	// Inject system prompt
	pi.on("before_agent_start", async (event) => {
		if (draftModeEnabled) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${DRAFT_SYSTEM_PROMPT}`,
			};
		}
	});

	// Restore on session end
	pi.on("session_end", async (_event, ctx) => {
		if (draftModeEnabled) {
			exitDraftMode(ctx);
		}
	});
}
