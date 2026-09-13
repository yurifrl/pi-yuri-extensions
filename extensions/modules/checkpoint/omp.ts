import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { prepareCheckpoint, renderCheckpointMarkdown, upsertChangelogEntry, writeCheckpointFile, type CheckpointContent, type ChangelogInput } from "./core.ts";

const touchedFiles = new Set<string>();

export default function checkpoint(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const file = event.input.path;
    if (typeof file === "string") touchedFiles.add(file);
  });

  pi.registerTool({
    name: "checkpoint_prepare",
    label: "Prepare Checkpoint",
    description: "Prepare deterministic session metadata and paths (checkpoint file, changelog file). Prefer checkpoint_save and changelog_update, which write the files.",
    parameters: pi.zod.object({
      name: pi.zod.string().describe("Kebab-case checkpoint name."),
      description: pi.zod.string().describe("One-sentence session description for cly."),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId() ?? "ephemeral";
      const details = prepareCheckpoint({
        cwd: ctx.cwd,
        session: {
          id: sessionId,
          file: ctx.sessionManager.getSessionFile() ?? "",
        },
        name: params.name,
        touchedFiles: [...touchedFiles],
        resume: `omp --resume ${sessionId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "checkpoint_save",
    label: "Save Checkpoint",
    description: "Create or update this session's checkpoint file: YAML frontmatter plus Context/Decisions/Current State/Lessons/Next Steps. Writes to disk.",
    parameters: pi.zod.object({
      name: pi.zod.string().describe("Kebab-case checkpoint name."),
      description: pi.zod.string().describe("One-sentence session description."),
      context: pi.zod.string().describe("Paragraph: what this session was about and where it stands."),
      decisions: pi.zod.array(pi.zod.string()).describe("Decisions made, one bullet each."),
      currentState: pi.zod.array(pi.zod.string()).describe("Verifiable current-state facts, one bullet each."),
      lessons: pi.zod.array(pi.zod.string()).describe("Reusable lessons, one bullet each."),
      nextSteps: pi.zod.array(pi.zod.string()).describe("Open next steps, one bullet each."),
    }),
    async execute(_id, params: CheckpointContent & { name: string }, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId() ?? "ephemeral";
      const prepared = prepareCheckpoint({
        cwd: ctx.cwd,
        session: { id: sessionId, file: ctx.sessionManager.getSessionFile() ?? "" },
        name: params.name,
        touchedFiles: [...touchedFiles],
        resume: `omp --resume ${sessionId}`,
      });
      const markdown = renderCheckpointMarkdown(prepared, params, new Date().toISOString().slice(0, 10));
      writeCheckpointFile(prepared.checkpointFile, markdown);
      return { content: [{ type: "text", text: JSON.stringify({ checkpointFile: prepared.checkpointFile, updated: prepared.existing }, null, 2) }], details: { checkpointFile: prepared.checkpointFile, updated: prepared.existing } };
    },
  });

  pi.registerTool({
    name: "changelog_update",
    label: "Update Changelog",
    description: "Insert or update the repo-root CHANGELOG.md entry for delivered work. Bullets lead with intention (outcome for the reader), minimal code mentions.",
    parameters: pi.zod.object({
      title: pi.zod.string().describe("Outcome title, a few words, Title Case."),
      category: pi.zod.enum(["Added", "Changed", "Fixed", "Deprecated", "Removed", "Notes"]).describe("Entry category."),
      bullets: pi.zod.array(pi.zod.string()).describe("Intention-first bullets: what the reader gains or what stopped breaking; at most one path/command mention per bullet."),
      date: pi.zod.string().optional().describe("Entry date YYYY-MM-DD; defaults to today."),
    }),
    async execute(_id, params: ChangelogInput, _signal, _onUpdate, ctx) {
      const result = upsertChangelogEntry(`${ctx.cwd}/CHANGELOG.md`, {
        title: params.title,
        category: params.category,
        bullets: params.bullets,
        date: params.date,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  pi.registerCommand("checkpoint", {
    description: "Save an AI-readable session checkpoint.",
    handler: async (args, ctx) => {
      await pi.sendUserMessage(`/skill:checkpoint${args.trim() ? ` ${args.trim()}` : ""}`, {
        deliverAs: ctx.isIdle() ? undefined : "followUp",
        expandPromptTemplates: true,
      });
    },
  });
}
