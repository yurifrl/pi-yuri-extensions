import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import path from "node:path";

function fromFile(file: string | undefined): string {
  if (!file) return "ephemeral";
  const base = path.basename(file, ".jsonl");
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : base;
}

export default function sessionIdTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "session_id",
    label: "Session ID",
    description: "Return the current pi session id (UUID), or 'ephemeral' if the session is not persisted.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const id =
        ctx.sessionManager?.getSessionId?.() ??
        fromFile(ctx.sessionManager?.getSessionFile?.());
      return { content: [{ type: "text", text: id }], details: { sessionId: id } };
    },
  });
}
