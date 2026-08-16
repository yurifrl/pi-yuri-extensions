import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function exitTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "exit",
    label: "Exit Pi",
    description: "Gracefully exit the current interactive Pi session.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      ctx.shutdown();

      return {
        content: [{ type: "text", text: "Pi is shutting down." }],
        details: {},
        terminate: true,
      };
    },
  });
}
