/**
 * /respond [N] — re-edit a previous assistant (pi) message in $EDITOR (vim)
 * and drop the result into the prompt box, ready to send.
 *
 * Behavior:
 *  - `/respond`        opens the LAST assistant message in $EDITOR.
 *  - `/respond 1`      same as `/respond` (1 = last).
 *  - `/respond 2`      opens the second-to-last assistant message, etc.
 *
 * After the editor exits with status 0, the (possibly edited) content is
 * pushed into the composer via ctx.ui.setEditorText so the user only has to
 * press Enter to send. Empty result or non-zero exit cancels.
 *
 * Phase: SESSION_START. No CLI flag, no preboot needed.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

type AnyEntry = {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
};

function extractAssistantText(entry: AnyEntry): string | null {
  if (entry?.type !== "message") return null;
  const msg = entry.message;
  if (!msg || msg.role !== "assistant") return null;
  const content = msg.content;
  if (typeof content === "string") {
    return content.trim() ? content : null;
  }
  if (Array.isArray(content)) {
    // Assistant messages are blocks: text | thinking | toolCall.
    // We only want plain text (skip thinking and tool calls).
    const text = content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text as string)
      .join("\n")
      .trim();
    return text || null;
  }
  return null;
}

/** Walk the current branch newest-first, return the Nth assistant message text. */
function getNthLastAssistantText(
  ctx: { sessionManager: { getBranch(): AnyEntry[] } },
  n: number,
): string | null {
  const branch = ctx.sessionManager.getBranch();
  let seen = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    const text = extractAssistantText(branch[i] as AnyEntry);
    if (text === null) continue;
    seen += 1;
    if (seen === n) return text;
  }
  return null;
}

function parseN(args: string | undefined): number {
  if (!args) return 1;
  const trimmed = args.trim();
  if (!trimmed) return 1;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

/**
 * Suspend the TUI, spawn $EDITOR on a temp file, restore the TUI.
 * Returns the file content on success, or null on cancel/error.
 *
 * We use ctx.ui.custom() solely to gain access to the TUI instance so we
 * can call tui.stop()/start() — same trick the built-in Ctrl+G external
 * editor uses (see dist/modes/interactive/components/extension-editor.js).
 */
/**
 * Detect "saved" by comparing mtime: vim only updates mtime on `:w`.
 * If the user exits without writing (`:q`, `:q!`, `ZQ`, Ctrl-C), mtime is
 * unchanged from the initial write and we treat it as a cancel.
 */
async function editInExternal(
  ctx: any,
  initial: string,
): Promise<string | null> {
  const editorCmd = process.env.VISUAL || process.env.EDITOR || "vim";
  const tmpFile = path.join(
    os.tmpdir(),
    `pi-respond-${Date.now()}-${process.pid}.md`,
  );
  await fs.writeFile(tmpFile, initial, "utf-8");
  const initialMtimeMs = (await fs.stat(tmpFile)).mtimeMs;

  try {
    if (!ctx.hasUI) {
      // No TUI to suspend; just refuse.
      return null;
    }

    return await ctx.ui.custom<string | null>(
      (tui: any, _theme: any, _kb: any, done: (r: string | null) => void) => {
        // We need to return *something* synchronously, but the actual
        // editor lifecycle runs async. Use a noop component and schedule
        // the spawn on the next tick so the custom handle is fully
        // installed before we start tearing down the TUI.
        const noop: any = {
          render: () => [],
          invalidate: () => {},
        };

        queueMicrotask(async () => {
          try {
            tui.stop();
            process.stdout.write(
              `Launching ${editorCmd} (save & exit to drop into prompt)...\n`,
            );
            const [editor, ...editorArgs] = editorCmd.split(" ");
            const status = await new Promise<number | null>((resolve) => {
              const child = spawn(editor!, [...editorArgs, tmpFile], {
                stdio: "inherit",
                shell: process.platform === "win32",
              });
              child.on("error", () => resolve(null));
              child.on("close", (code) => resolve(code));
            });

            if (status !== 0) {
              done(null);
              return;
            }
            // Saved-detection: vim bumps mtime only on `:w`. No write → cancel.
            let savedMtimeMs: number;
            try {
              savedMtimeMs = (await fs.stat(tmpFile)).mtimeMs;
            } catch {
              done(null);
              return;
            }
            if (savedMtimeMs === initialMtimeMs) {
              done(null);
              return;
            }
            const raw = await fs.readFile(tmpFile, "utf-8");
            const cleaned = raw.replace(/\n+$/, "");
            done(cleaned.length > 0 ? cleaned : null);
          } catch {
            done(null);
          } finally {
            try {
              tui.start();
              tui.requestRender(true);
            } catch {
              /* ignore */
            }
          }
        });

        return noop;
      },
    );
  } finally {
    try {
      await fs.unlink(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("respond", {
    description:
      "Edit a previous pi (assistant) message in $EDITOR (default vim) and drop it back into the prompt box. Usage: /respond [N] (default 1 = last)",
    handler: async (args, ctx) => {
      const n = parseN(args);
      const original = getNthLastAssistantText(
        ctx as { sessionManager: { getBranch(): AnyEntry[] } },
        n,
      );
      if (!original) {
        ctx.ui.notify(
          n === 1
            ? "No previous pi message to respond to."
            : `Only found fewer than ${n} pi messages in this session.`,
          "error",
        );
        return;
      }

      const edited = await editInExternal(ctx, original);
      if (edited === null) {
        ctx.ui.notify(
          "Respond cancelled (no save — prompt unchanged).",
          "info",
        );
        return;
      }

      ctx.ui.setEditorText(edited);
      ctx.ui.notify(
        `Loaded pi message #${n} from history into prompt — press Enter to send.`,
        "success",
      );
    },
  });
}
