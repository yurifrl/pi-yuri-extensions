import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * /handoff — Compact the current conversation into a handoff document for
 * another agent to pick up. Writes to the OS temp dir, prints the path, and
 * copies the document to the clipboard.
 *
 * Runs synchronously (foreground): the slash-command awaits the LLM call so
 * the user sees the result as soon as it's ready, with no fire-and-forget.
 *
 * Based on: https://github.com/mattpocock/skills/blob/main/skills/productivity/handoff/SKILL.md
 */

const SYSTEM_PROMPT = `You are writing a handoff document so a fresh agent can continue the work in this conversation.

Output a single markdown document. No preamble. No commentary. Just the document.

Required structure:
# Handoff: <short title>

## Context
<1-3 sentences: what this session was about>

## Current state
<bullets: what is done, what is in progress, what is blocked>

## Files & artifacts
<bullets referencing paths/URLs of PRDs, plans, ADRs, issues, commits, diffs.
DO NOT duplicate content already captured in those artifacts — reference them.>

## Open questions / next steps
<concrete next actions the next agent should take>

## Suggested skills
<bullet list of skills (slash commands or skill names) the next agent should invoke,
based on the work pattern in this session>

Rules:
- Redact API keys, passwords, tokens, and PII.
- Be concrete. Reference paths, line numbers, commit SHAs, URLs.
- If the user provided a focus argument, tailor the doc to that focus.
- Keep it tight. No filler.`;

async function copyToClipboard(text: string): Promise<void> {
  const platform = process.platform;
  if (platform === "darwin") {
    await execFileAsync("pbcopy", [], { input: text } as any);
  } else if (platform === "linux") {
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

function getGitContext(cwd: string): string {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--short"], {
      encoding: "utf-8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const log = execFileSync("git", ["log", "--oneline", "-5"], {
      encoding: "utf-8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return `Branch: ${branch}\n\nStatus:\n${status || "(clean)"}\n\nRecent commits:\n${log}`;
  } catch {
    return "(not in git repo)";
  }
}

function tsStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Generate a handoff doc for the next agent (foreground, copies to clipboard)",
    handler: async (args, ctx) => {
      const STATUS_KEY = "handoff";
      const focus = (Array.isArray(args) ? args.join(" ") : (args as unknown as string) || "").trim();

      ctx.ui.setStatus(STATUS_KEY, "⏳ Handoff: collecting context…");
      ctx.ui.notify("Generating handoff…", "info");

      // Run async without await — returning quickly unblocks the prompt.
      void (async () => {
        try {
        // Try every available source. Slash commands run with limited
        // session views — be defensive about what's wired up.
        const sm: any = ctx.sessionManager;
        let branch: any[] = [];
        try {
          if (typeof sm?.getBranch === "function") branch = sm.getBranch() || [];
        } catch {}
        if (!branch.length && typeof sm?.getEntries === "function") {
          try { branch = sm.getEntries() || []; } catch {}
        }
        if (!branch.length && typeof sm?.getMessages === "function") {
          try { branch = sm.getMessages() || []; } catch {}
        }

        const cwd = ctx.cwd || process.cwd();
        // Hand-render — bypass convertToLlm so we never crash on unexpected
        // entry shapes.
        const parts: string[] = [];
        for (const e of branch) {
          if (e?.type === "message" && e.message) {
            const role = e.message.role || "unknown";
            const c = e.message.content;
            const text = Array.isArray(c)
              ? c.filter((b: any) => b?.type === "text" && typeof b.text === "string")
                  .map((b: any) => b.text)
                  .join("\n")
              : typeof c === "string"
                ? c
                : "";
            if (text.trim()) parts.push(`## ${role}\n${text.trim()}`);
          } else if (e?.role && (typeof e.content === "string" || Array.isArray(e.content))) {
            const c = e.content;
            const text = Array.isArray(c)
              ? c.filter((b: any) => b?.type === "text" && typeof b.text === "string")
                  .map((b: any) => b.text)
                  .join("\n")
              : (c as string);
            if (text.trim()) parts.push(`## ${e.role}\n${text.trim()}`);
          }
        }
        let conversationText = parts.join("\n\n");
        if (!conversationText.trim() && branch.length) {
          try {
            conversationText = serializeConversation(convertToLlm(branch as any));
          } catch {}
        }
        if (!conversationText.trim()) {
          ctx.ui.setStatus(STATUS_KEY, undefined);
          ctx.ui.notify(
            `Handoff: empty transcript (branch entries=${branch.length}). Try after the model has replied at least once.`,
            "error",
          );
          return;
        }

        const MAX_CHARS = 60_000;
        const transcript =
          conversationText.length > MAX_CHARS
            ? `…(truncated head)…\n${conversationText.slice(-MAX_CHARS)}`
            : conversationText;

        const gitContext = getGitContext(cwd);

        const model = ctx.model;
        if (!model) throw new Error("No active model available");
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          throw new Error(`No API key for ${model.provider}/${model.id}: ${auth.error}`);
        }

        ctx.ui.setStatus(STATUS_KEY, "⏳ Handoff: asking model…");

        const userParts: string[] = [];
        if (focus) userParts.push(`Next-session focus (from user): ${focus}`);
        userParts.push(`Working directory: ${cwd}`);
        userParts.push(`Git context:\n${gitContext}`);
        userParts.push(`Conversation transcript:\n${transcript}`);

        const response = await complete(
          model,
          {
            systemPrompt: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userParts.join("\n\n---\n\n") }],
          },
          { apiKey: auth.apiKey, headers: auth.headers },
        );

        const doc =
          (typeof (response as any).content === "string" && (response as any).content.trim()) ||
          (Array.isArray((response as any).content)
            ? (response as any).content
                .filter((b: any) => b?.type === "text" && typeof b.text === "string")
                .map((b: any) => b.text)
                .join("\n")
                .trim()
            : "") ||
          "";

        if (!doc) throw new Error("Model returned empty handoff document");

        const outPath = path.join(tmpdir(), `handoff-${tsStamp()}.md`);
        writeFileSync(outPath, doc, "utf-8");

        try {
          await copyToClipboard(doc);
        } catch (err) {
          ctx.ui.setStatus(STATUS_KEY, undefined);
          ctx.ui.notify(
            `Handoff written to ${outPath} but clipboard copy failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
            "error",
          );
          return;
        }

        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.notify(
          `✅ Handoff ready (${doc.length} chars)\n📄 ${outPath}\n📋 Copied to clipboard`,
          "success",
        );
      } catch (err) {
          ctx.ui.setStatus(STATUS_KEY, undefined);
          ctx.ui.notify(
            `Handoff failed: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
      })();
    },
  });
}
