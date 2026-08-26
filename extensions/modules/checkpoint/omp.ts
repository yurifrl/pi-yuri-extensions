import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { prepareCheckpoint } from "./core.ts";

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
    description: "Prepare deterministic session metadata and a checkpoint path. The caller writes the AI-authored checkpoint and changelog.",
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
