import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCheckpoint } from "./core.ts";

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

export default function checkpoint(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const file = event.input.path;
    if (typeof file === "string") touchedFiles.add(path.isAbsolute(file) ? file : path.resolve(cwdOf(ctx), file));
  });
  pi.on("resources_discover", async () => ({ skillPaths: [skillPath] }));
  pi.registerTool({
    name: "checkpoint_prepare",
    label: "Prepare Checkpoint",
    description: "Prepare deterministic session metadata and a checkpoint path. The caller writes the AI-authored checkpoint and changelog.",
    parameters: Type.Object({ name: Type.String({ description: "Kebab-case checkpoint name." }) }),
    async execute(_id, params, _signal, _update, ctx) {
      const session = sessionOf(ctx);
      const details = prepareCheckpoint({
        cwd: cwdOf(ctx),
        session,
        name: params.name,
        touchedFiles: [...touchedFiles],
        resume: `pi --resume ${session.id}`,
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
