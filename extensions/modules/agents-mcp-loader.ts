import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";

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
    const loaded: string[] = [];

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
      loaded.push(`${relative(event.cwd, sourcePath)} (${names.join(", ")})`);
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

    for (const entry of loaded) {
      pi.log(`✔ mcp-loader: loaded ${entry}`);
    }
    pi.log(`✔ mcp-loader: wrote ${Object.keys(merged.mcpServers as object).length} server(s) to .pi/mcp.json`);
  });
}
