import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Convert standard markdown to Slack-compatible mrkdwn.
 *
 * Slack differences from CommonMark / GFM:
 *  - Bold:          *text*  (NOT **text**)
 *  - Italic:        _text_
 *  - Strike:        ~text~
 *  - Inline code:   `code`  (same)
 *  - Code block:    ```...``` (same, but no language hint after ```)
 *  - Quote:         >text   (same)
 *  - Links:         <url|label>  (NOT [label](url))
 *  - Headers:       → bold line  (no # syntax)
 *  - HR:            removed entirely
 *  - Bullet lists with * → - (because * means bold)
 */
function toSlackMarkdown(text: string): string {
  // --- protect code blocks first so we don't mangle their content ---
  const codeBlocks: string[] = [];
  let out = text.replace(/```[\s\S]*?```/g, (match) => {
    // strip language hint from opening fence: ```typescript → ```
    const stripped = match.replace(/^```[^\n]*\n/, "```\n");
    const idx = codeBlocks.push(stripped) - 1;
    return `\x00CODE${idx}\x00`;
  });

  // --- protect inline code ---
  const inlineCodes: string[] = [];
  out = out.replace(/`[^`\n]+`/g, (match) => {
    const idx = inlineCodes.push(match) - 1;
    return `\x00INLINE${idx}\x00`;
  });

  // --- headings: # Heading → *Heading* ---
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // --- horizontal rules → blank line ---
  out = out.replace(/^[-*_]{3,}\s*$/gm, "");

  // --- bold **text** or __text__ → *text* ---
  out = out.replace(/\*\*(.+?)\*\*/g, "*$1*");
  out = out.replace(/__(.+?)__/g, "*$1*");

  // --- italic *text* (single, not already part of bold) → _text_ ---
  // Only replace standalone single asterisks (not already converted bold markers)
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_");

  // --- Markdown links [label](url) → <url|label> ---
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // --- bullet lists using * → - (avoid Slack bold confusion) ---
  out = out.replace(/^(\s*)\* /gm, "$1- ");

  // --- restore inline code ---
  out = out.replace(/\x00INLINE(\d+)\x00/g, (_m, i) => inlineCodes[Number(i)]!);

  // --- restore code blocks ---
  out = out.replace(/\x00CODE(\d+)\x00/g, (_m, i) => codeBlocks[Number(i)]!);

  // --- collapse 3+ blank lines into 2 ---
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

function getLastAssistantText(ctx: { sessionManager: { getBranch(): Array<any> } }): string | null {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      const content = entry.message.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text as string)
          .join("\n")
          .trim();
        if (text) return text;
      } else if (typeof content === "string" && content.trim()) {
        return content.trim();
      }
    }
  }
  return null;
}

async function copyToClipboard(text: string): Promise<void> {
  const platform = process.platform;
  if (platform === "darwin") {
    await execFileAsync("pbcopy", [], { input: text } as any);
  } else if (platform === "linux") {
    // Try xclip, then xsel
    try {
      await execFileAsync("xclip", ["-selection", "clipboard"], { input: text } as any);
    } catch {
      await execFileAsync("xsel", ["--clipboard", "--input"], { input: text } as any);
    }
  } else if (platform === "win32") {
    await execFileAsync("clip", [], { input: text } as any);
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-slack", {
    description: "Copy last agent message to clipboard, formatted for Slack",
    handler: async (_args, ctx) => {
      const raw = getLastAssistantText(ctx);
      if (!raw) {
        ctx.ui.notify("No agent messages to copy yet.", "error");
        return;
      }

      const slackText = toSlackMarkdown(raw);

      try {
        await copyToClipboard(slackText);
        ctx.ui.notify("Copied to clipboard (Slack format)", "success");
      } catch (err) {
        ctx.ui.notify(
          `Failed to copy: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });
}
