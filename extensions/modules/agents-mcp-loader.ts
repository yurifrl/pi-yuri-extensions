import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
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
  label: string;
  serverNames: string[];
}

function renderNotification(sources: LoadedSource[]): string {
  const lines: string[] = [];
  lines.push(yellow("[MCP servers from .agents]"));
  for (const src of sources) {
    lines.push(`  ${dim(src.label)}`);
    for (const name of src.serverNames) {
      lines.push(`      ${cyan(name)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Merges MCP servers from .agents/mcp.json (project) and ~/.agents/mcp.json (global)
 * into ~/.pi/agent/mcp.json so pi-mcp-adapter picks them up.
 *
 * Project .agents/mcp.json overrides ~/.agents/mcp.json.
 * Existing ~/.pi/agent/mcp.json entries always win (never clobbered).
 */
export default function (pi: ExtensionAPI) {
  let pendingNotification: { sources: LoadedSource[] } | null = null;

  pi.on("session_directory", async (event) => {
    const sources: { path: string; label: string }[] = [
      { path: join(homedir(), ".agents", "mcp.json"), label: "~/.agents/mcp.json" },
      { path: join(event.cwd, ".agents", "mcp.json"), label: ".agents/mcp.json" },
    ];

    let mergedServers: Record<string, unknown> = {};
    const loadedSources: LoadedSource[] = [];

    for (const { path: srcPath, label } of sources) {
      if (!existsSync(srcPath)) continue;

      let source: Record<string, unknown>;
      try {
        source = JSON.parse(readFileSync(srcPath, "utf-8"));
      } catch {
        pi.log(`⚠ mcp-loader: failed to parse ${label}, skipping`);
        continue;
      }

      const servers =
        (source.mcpServers ?? source["mcp-servers"] ?? {}) as Record<string, unknown>;
      if (!servers || typeof servers !== "object") continue;

      const names = Object.keys(servers);
      if (names.length === 0) continue;

      loadedSources.push({ label, serverNames: names });
      mergedServers = { ...mergedServers, ...servers };
    }

    if (Object.keys(mergedServers).length === 0) return;

    const destPath = join(homedir(), ".pi", "agent", "mcp.json");

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
        ...mergedServers,
        ...existingServers,
      },
    };

    mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
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
