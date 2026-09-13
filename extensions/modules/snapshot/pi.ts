import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareSnapshot, renderSnapshotMarkdown, upsertChangelogEntry, writeSnapshotFile, type ChangelogCategory } from "./core.ts";

const skillPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "skills");
const touchedFiles = new Set<string>();

function cwdOf(ctx: unknown): string {
  if (typeof ctx !== "object" || ctx === null || !("cwd" in ctx)) throw new Error("Pi context has no working directory");
  return typeof ctx.cwd === "function" ? ctx.cwd() : ctx.cwd;
}

function sessionOf(ctx: unknown): { id: string; file: string } {
  if (typeof ctx !== "object" || ctx === null || !("sessionManager" in ctx)) return { id: "ephemeral", file: "" };
  const manager = ctx.sessionManager;
  if (typeof manager !== "object" || manager === null) return { id: "ephemeral", file: "" };
  const file = "getSessionFile" in manager && typeof manager.getSessionFile === "function" ? manager.getSessionFile() : "";
  const id = "getSessionId" in manager && typeof manager.getSessionId === "function" ? manager.getSessionId() : file ? path.basename(file, ".jsonl") : "ephemeral";
  return { id, file };
}

export default function snapshot(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "checkpoint" || event.toolName === "rewind") {
      return {
        block: true,
        reason: "The built-in checkpoint/rewind context tools are disabled by the snapshot module — they only park conversation context and write nothing to disk. For a session snapshot call `snapshot_write` (writes the session snapshot file) and `changelog_update` (updates the root CHANGELOG.md), or run /snapshot.",
      };
    }
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const file = event.input.path;
    if (typeof file === "string") touchedFiles.add(path.isAbsolute(file) ? file : path.resolve(cwdOf(ctx), file));
  });
  pi.on("resources_discover", async () => ({ skillPaths: [skillPath] }));
  pi.registerTool({
    name: "snapshot_write",
    label: "Write Snapshot",
    description: "Create or update this session's snapshot file: YAML frontmatter plus Context/Decisions/Current State/Lessons/Next Steps. Writes to disk.",
    parameters: Type.Object({
      name: Type.String({ description: "Kebab-case snapshot name." }),
      description: Type.String({ description: "One-sentence session description." }),
      context: Type.String({ description: "Paragraph: what this session was about and where it stands." }),
      decisions: Type.Array(Type.String({ description: "Decision bullet." }), { description: "Decisions made, one bullet each." }),
      currentState: Type.Array(Type.String({ description: "Current-state bullet." }), { description: "Verifiable current-state facts, one bullet each." }),
      lessons: Type.Array(Type.String({ description: "Lesson bullet." }), { description: "Reusable lessons, one bullet each." }),
      nextSteps: Type.Array(Type.String({ description: "Next-step bullet." }), { description: "Open next steps, one bullet each." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const session = sessionOf(ctx);
      const prepared = prepareSnapshot({
        cwd: cwdOf(ctx),
        session,
        name: params.name,
        touchedFiles: [...touchedFiles],
        resume: `pi --resume ${session.id}`,
      });
      const markdown = renderSnapshotMarkdown(prepared, params, new Date().toISOString().slice(0, 10));
      writeSnapshotFile(prepared.snapshotFile, markdown);
      return { content: [{ type: "text", text: JSON.stringify({ snapshotFile: prepared.snapshotFile, updated: prepared.existing }, null, 2) }], details: { snapshotFile: prepared.snapshotFile, updated: prepared.existing } };
    },
  });
  pi.registerTool({
    name: "changelog_update",
    label: "Update Changelog",
    description: "Insert or update the repo-root CHANGELOG.md entry for delivered work. Bullets lead with intention (outcome for the reader), minimal code mentions.",
    parameters: Type.Object({
      title: Type.String({ description: "Outcome title, a few words, Title Case." }),
      category: Type.Union([
        Type.Literal("Added"),
        Type.Literal("Changed"),
        Type.Literal("Fixed"),
        Type.Literal("Deprecated"),
        Type.Literal("Removed"),
        Type.Literal("Notes"),
      ], { description: "Entry category." }),
      bullets: Type.Array(Type.String({ description: "Intention-first bullet." }), { description: "What the reader gains or what stopped breaking; at most one path/command mention per bullet." }),
      date: Type.Optional(Type.String({ description: "Entry date YYYY-MM-DD; defaults to today." })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = upsertChangelogEntry(path.join(cwdOf(ctx), "CHANGELOG.md"), {
        title: params.title,
        category: params.category as ChangelogCategory,
        bullets: params.bullets,
        date: params.date,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
  pi.registerCommand("snapshot", {
    description: "Save an AI-readable session snapshot and changelog entry.",
    handler: async (args, ctx) => {
      await pi.sendUserMessage(`/skill:snapshot${args.trim() ? ` ${args.trim()}` : ""}`, {
        deliverAs: ctx.isIdle() ? undefined : "followUp",
        expandPromptTemplates: true,
      });
    },
  });
}
