import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import path from "node:path";

/**
 * session-print
 *
 * Prints the current session id on start and shutdown.
 * Extracts the UUID from the session file name, e.g.
 *   2026-04-10T01-07-28-091Z_3053243f-d4b5-4738-892c-ca1f887f2b76.jsonl
 *   -> 3053243f-d4b5-4738-892c-ca1f887f2b76
 */
function sessionId(file: string | undefined): string {
  if (!file) return "ephemeral";
  const base = path.basename(file, ".jsonl");
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : base;
}

export default function sessionPrint(pi: ExtensionAPI) {
  pi.on("session_shutdown", (_e, ctx) => {
    const id = sessionId(ctx.sessionManager?.getSessionFile?.());
    // eslint-disable-next-line no-console
    console.error(`session: ${id}`);
  });
}
