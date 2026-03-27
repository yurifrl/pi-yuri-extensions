import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";

function cyan(s: string): string {
  return `\x1b[38;2;54;249;246m${s}\x1b[39m`;
}
function yellow(s: string): string {
  return `\x1b[38;2;254;222;93m${s}\x1b[39m`;
}
function dim(s: string): string {
  return `\x1b[38;2;120;100;140m${s}\x1b[39m`;
}

interface LoadedSource {
  relPath: string;
  serverNames: string[];
}

function renderNotification(sources: LoadedSource[]): string {
  const lines: string[] = [];

  lines.push(yellow("[MCP servers]"));
  for (const src of sources) {
    lines.push(`  ${dim(src.relPath)}`);
    for (const name of src.serverNames) {
      lines.push(`      ${cyan(name)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Loads MCP server configs from common project-level config files
 * into .pi/mcp.json so pi-mcp-adapter picks them up on session start.
 *
 * Sources (lowest → highest priority):
 *   .agents/mcp.json  — agents convention
 *   .kiro/settings/mcp.json — Kiro
 *   .cursor/mcp.json  — Cursor
 *   .vscode/mcp.json  — VS Code
 *   .mcp.json         — Claude Code / standard
 *
 * Existing .pi/mcp.json entries always win on conflict.
 */
export default function (pi: ExtensionAPI) {
  let pendingNotification: { sources: LoadedSource[] } | null = null;

  pi.on("session_directory", async (event) => {
    const sources = [
      join(event.cwd, ".agents", "mcp.json"),
      join(event.cwd, ".kiro", "settings", "mcp.json"),
      join(event.cwd, ".cursor", "mcp.json"),
      join(event.cwd, ".vscode", "mcp.json"),
      join(event.cwd, ".mcp.json"),
    ];

    // Collect servers from each source (later entries override earlier)
    let mergedSourceServers: Record<string, unknown> = {};
    const loadedSources: LoadedSource[] = [];

    for (const sourcePath of sources) {
      if (!existsSync(sourcePath)) continue;

      let source: Record<string, unknown>;
      try {
        source = JSON.parse(readFileSync(sourcePath, "utf-8"));
      } catch {
        pi.log(`⚠ mcp-loader: failed to parse ${relative(event.cwd, sourcePath)}, skipping`);
        continue;
      }

      const servers =
        (source.mcpServers ?? source["mcp-servers"] ?? {}) as Record<string, unknown>;

      if (!servers || typeof servers !== "object") continue;

      const names = Object.keys(servers);
      loadedSources.push({ relPath: relative(event.cwd, sourcePath), serverNames: names });
      mergedSourceServers = { ...mergedSourceServers, ...servers };
    }

    if (Object.keys(mergedSourceServers).length === 0) return;

    const piDir = join(event.cwd, ".pi");
    const destPath = join(piDir, "mcp.json");

    // Load existing .pi/mcp.json if present (non-generated entries win)
    let existing: Record<string, unknown> = { mcpServers: {} };
    if (existsSync(destPath)) {
      try {
        existing = JSON.parse(readFileSync(destPath, "utf-8"));
      } catch {}
    }

    const existingServers =
      (existing.mcpServers ?? existing["mcp-servers"] ?? {}) as Record<string, unknown>;

    const merged = {
      ...existing,
      mcpServers: {
        ...mergedSourceServers,
        ...existingServers,
      },
    };

    mkdirSync(piDir, { recursive: true });
    writeFileSync(destPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");

    pendingNotification = { sources: loadedSources };
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!pendingNotification) return;
    const { sources } = pendingNotification;
    pendingNotification = null;

    if (ctx.hasUI) {
      setTimeout(() => {
        ctx.ui.notify(renderNotification(sources), "info");
      }, 100);
    }
  });
}
