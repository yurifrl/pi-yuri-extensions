import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, isToolCallEventType, serializeConversation } from "@mariozechner/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Files touched by this agent during the session (write/edit tool calls). Used to scope git diff. */
const touchedFiles = new Set<string>();

function encodeCwdForPiSessionDir(cwd: string): string {
  const trimmed = cwd.replace(/^\/+|\/+$/g, "");
  return `--${trimmed.replace(/\//g, "-")}--`;
}

function resolveCurrentSession(ctx: any): { sessionFile: string; sessionId: string } {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (typeof sessionFile === "string" && sessionFile.trim() && existsSync(sessionFile)) {
    return { sessionFile, sessionId: getSessionIdFromFile(sessionFile) };
  }

  const cwd = ctx.cwd || process.cwd();
  const sessionDir = path.join(process.env.HOME || "", ".pi", "agent", "sessions", encodeCwdForPiSessionDir(cwd));
  if (!existsSync(sessionDir)) throw new Error(`No pi session directory for cwd: ${cwd}`);

  const candidates = readdirSync(sessionDir)
    .filter((n) => n.endsWith(".jsonl") || n.endsWith(".json"))
    .map((n) => path.join(sessionDir, n))
    .filter((f) => { try { return statSync(f).isFile(); } catch { return false; } })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  const latest = candidates[0];
  if (!latest) throw new Error(`No pi session file found for cwd: ${cwd}`);
  return { sessionFile: latest, sessionId: getSessionIdFromFile(latest) };
}

function getSessionIdFromFile(sessionFile: string): string {
  const first = readFileSync(sessionFile, "utf-8").split("\n")[0]?.trim();
  if (!first) throw new Error(`Empty session file: ${sessionFile}`);
  const obj = JSON.parse(first);
  const id = obj.id;
  if (!id) throw new Error(`No id in session file: ${sessionFile}`);
  return id;
}

interface Entry {
  id: string;
  name: string;
  provider: string;
  path: string;
  description?: string;
  saved_at?: string;
  meta?: Record<string, string>;
}

function findSessionInCly(sessionId: string): Entry | null {
  try {
    const sessionsPath = path.join(homedir(), ".config", "cly", "sessions.json");
    const raw = readFileSync(sessionsPath, "utf-8");
    const sessions = JSON.parse(raw);
    for (const entry of Object.values(sessions) as Entry[]) {
      if (entry.id === sessionId) return entry;
    }
  } catch {}
  return null;
}

function saveSessionToCly(name: string, sessionId: string, description: string): Entry {
  const out = execFileSync("cly", [
    "agent-session", "upsert", "--provider", "pi",
    "--name", name,
    "--description", description,
    sessionId,
  ], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return JSON.parse(out);
}

function findOrCreateSession(sessionId: string, name: string, description: string): { entry: Entry; created: boolean } {
  const existing = findSessionInCly(sessionId);
  if (existing) return { entry: existing, created: false };
  const entry = saveSessionToCly(name, sessionId, description);
  return { entry, created: true };
}

function nowDateHM(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** In-memory cache: sessionId → resolved { name, description }. Prevents re-generation on repeat /checkpoint calls. */
const resolvedNameCache = new Map<string, { name: string; description: string }>();

async function generateSessionMeta(ctx: any): Promise<{ shortName: string; description: string }> {
  const messages = ctx.sessionManager?.getMessages?.() || [];
  const conversationText = serializeConversation(convertToLlm(messages));
  const cwd = ctx.cwd || process.cwd();

  let gitContext = "";
  try {
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf-8", cwd }).trim();
    const log = execFileSync("git", ["log", "--oneline", "-3"], { encoding: "utf-8", cwd }).trim();
    gitContext = `New files:\n${untracked}\n\nRecent commits:\n${log}`;
  } catch {}

  const model = ctx.model;
  if (!model) throw new Error("No active model available");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`No API key for ${model.provider}/${model.id}: ${auth.error}`);
  const { apiKey, headers } = auth;

  const recent = conversationText.length > 4000 ? conversationText.slice(-4000) : conversationText;

  const response = await complete(
    model,
    {
      systemPrompt: `Respond with exactly two lines, nothing else.
Line 1: A short kebab-case name for this session, 2-4 words max (e.g. "checkpoint-cly-naming", "auth-token-refresh"). Lowercase, hyphens only.
Line 2: A one-sentence description of what was built/done in this session. Natural language, specific.`,
      messages: [{
        role: "user",
        content: [{ type: "text", text: `${gitContext}\n\n${recent}` }],
        timestamp: Date.now(),
      }],
    },
    { apiKey, headers, maxTokens: 120 },
  );

  const raw = response.content
    .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
    .map((c: any) => c.text)
    .join("").trim();

  const lines = raw.split("\n").map((l: string) => l.trim()).filter(Boolean);
  const projectFallback = slugify(path.basename(cwd)) || "session";
  const shortName = slugify(lines[0] || "") || projectFallback;
  const description = (lines[1] || lines[0] || "").replace(/^["']|["']$/g, "");

  if (!shortName || shortName.length < 2) throw new Error("Empty session name");
  return { shortName, description };
}

async function findOrCreateContextName(ctx: any, sessionId: string): Promise<{ name: string; description: string }> {
  // In-memory cache: guarantees same name for repeat /checkpoint calls in same process
  const cached = resolvedNameCache.get(sessionId);
  if (cached) return cached;

  const existing = findSessionInCly(sessionId);
  if (existing) {
    const result = { name: existing.name, description: existing.description || existing.name };
    resolvedNameCache.set(sessionId, result);
    return result;
  }

  const { shortName, description } = await generateSessionMeta(ctx);
  const name = `${nowDateHM()}-${shortName}`;

  findOrCreateSession(sessionId, name, description);

  const result = { name, description };
  resolvedNameCache.set(sessionId, result);
  return result;
}

function buildCheckpointPrompt(
  args: string,
  cwd: string,
  session: { sessionFile: string; sessionId: string },
  contextName: string,
  touchedFiles: Set<string>,
): string {
  const compact = args.trim() === "--compact";
  const contextFile = path.join(cwd, ".agents", "contexts", `${contextName}.md`);
  const project = path.basename(cwd);

  return `Perform a session checkpoint now. Run all three phases in order: save, summary, changelog.

**Important:** If you see multiple checkpoint prompts in this conversation, only execute THIS one (context name: ${contextName}). Ignore any earlier checkpoint prompts with different context names — they are stale duplicates.

## Session metadata
- Working directory: ${cwd}
- Session file: ${session.sessionFile}
- Session ID: ${session.sessionId}
- Context name: ${contextName}
- Context file: ${contextFile}

## Phase 1 — Save context

Write to \`${contextFile}\`. If it exists, update in place.

Context file format:

\`\`\`yaml
---
created: <ISO timestamp>
project: ${project}
description: <one-line summary>
context: <what this relates to>
tags: []
session_name: <session name you infer>
purpose: <one-sentence purpose you infer>
session_id: ${session.sessionId}
provider: pi
resume_with: cly agent-session resume --provider pi ${contextName}
context_name: ${contextName}
context_file: ${contextFile}
---
\`\`\`

Body sections: Session (name, purpose, change id, resume command), Context, Problem, Decisions, Current State, Next Steps.
Be specific: file paths not abstractions, include reasoning, no fluff.

## Phase 2 — Print summary

${compact
    ? "Single paragraph: goal + work + outcome."
    : "Format: Goal, Work Done, Outcome, Key Decisions (if meaningful), Next Steps (if clear)."}
Goal first, skip minutiae, be concise.

## Phase 3 — Update changelog

${touchedFiles.size > 0
    ? `This agent touched the following files during this session:
${[...touchedFiles].map(f => `  - ${f}`).join("\n")}

Run \`git diff -- ${[...touchedFiles].join(" ")}\` to see only this agent's changes.
Also run \`git status -- ${[...touchedFiles].join(" ")}\` to catch untracked new files.
Only include changes from those files in the changelog — do not describe changes to other files.`
    : "Run git log/status/diff to determine scope."
}

CHANGELOG.md format:

\`\`\`markdown
# Changelog

## YYYY-MM-DD <Nice Capitalized Title>
- Session ID: ${session.sessionId}
- Session File: ${session.sessionFile}
- Session Name: ${contextName}
- Context Name: ${contextName}

### Added / ### Changed / ### Removed
\`\`\`

Title is a nice human-readable capitalized description, not a slug.
Update existing session block in place, don't duplicate. Create CHANGELOG.md if missing.
Truthful, deduplicated, concise, no trivial changes.

## Final output shape

\`\`\`
---
Context saved: ${contextFile}
Session: ${contextName}
Purpose: <purpose>
Session ID: ${session.sessionId}
Session File: ${session.sessionFile}
Resume: cly agent-session resume --provider pi ${contextName}
---

## Summary
...

---

## Changelog
...
\`\`\`

Be concise across all phases.`;
}

export default function checkpoint(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const filePath = event.input.path as string;
      if (filePath) {
        const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);
        touchedFiles.add(resolved);
      }
    }
  });

  pi.registerCommand("checkpoint", {
    description: "Save context, summary, and changelog with Pi session metadata",
    handler: async (args, ctx) => {
      try {
        const cwd = ctx.cwd || process.cwd();
        const session = resolveCurrentSession(ctx);

        let result: { name: string; description: string } | null = null;

        if (ctx.hasUI) {
          result = await ctx.ui.custom<{ name: string; description: string } | null>((tui, theme, _kb, done) => {
            const loader = new BorderedLoader(tui, theme, "Saving session & generating context name...");
            loader.onAbort = () => done(null);
            findOrCreateContextName(ctx, session.sessionId).then(done).catch((e) => {
              console.error(e);
              done(null);
            });
            return loader;
          });
        } else {
          result = await findOrCreateContextName(ctx, session.sessionId);
        }

        if (!result) {
          ctx.ui.notify("Checkpoint cancelled or name generation failed", "info");
          return;
        }

        ctx.ui.notify(`Session saved: ${result.name}`, "success");

        const prompt = buildCheckpointPrompt(args, cwd, session, result.name, touchedFiles);

        if (ctx.isIdle()) {
          pi.sendUserMessage(prompt);
        } else {
          // Agent is busy — queue as followUp but warn about duplicate
          pi.sendUserMessage(prompt, { deliverAs: "followUp" });
          ctx.ui.notify("Checkpoint queued (agent busy — will run after current task)", "info");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Checkpoint failed: ${message}`, "error");
      }
    },
  });
}
