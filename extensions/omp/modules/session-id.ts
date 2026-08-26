import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function sessionId(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "session_id",
    label: "Session ID",
    description: "Return the current OMP session ID, or 'ephemeral' before it is persisted.",
    parameters: pi.zod.object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const id = ctx.sessionManager.getSessionId() ?? "ephemeral";
      return { content: [{ type: "text", text: id }], details: { sessionId: id } };
    },
  });
}
