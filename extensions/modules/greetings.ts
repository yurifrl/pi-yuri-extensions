import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import path from "node:path";

function sessionId(file: string | undefined): string {
  if (!file) return "ephemeral";
  const base = path.basename(file, ".jsonl");
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : base;
}

// dim gray "session id" + purple uuid
function formatted(id: string): string {
  return `\x1b[90msession id\x1b[0m  \x1b[35m${id}\x1b[0m`;
}

export default function greetings(pi: ExtensionAPI) {
  pi.on("session_start", (_e, ctx) => {
    const id = sessionId(ctx.sessionManager?.getSessionFile?.());
    try {
      ctx.ui?.notify?.(formatted(id), "info");
    } catch {}

    process.on("exit", () => {
      process.stdout.write(formatted(id) + "\n");
    });
  });
}
