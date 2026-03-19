import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Loads .agents/mcp.json from the project root into .pi/mcp.json
 * so pi-mcp-adapter picks it up automatically on session start.
 */
export default function (pi: ExtensionAPI) {
  pi.on("session_directory", async (event) => {
    const sourcePath = join(event.cwd, ".agents", "mcp.json");

    if (!existsSync(sourcePath)) return;

    let source: Record<string, unknown>;
    try {
      source = JSON.parse(readFileSync(sourcePath, "utf-8"));
    } catch {
      return;
    }

    const sourceServers =
      (source.mcpServers ?? source["mcp-servers"] ?? {}) as Record<string, unknown>;

    if (!sourceServers || typeof sourceServers !== "object") return;

    const piDir = join(event.cwd, ".pi");
    const destPath = join(piDir, "mcp.json");

    // Load existing .pi/mcp.json if present (non-generated file wins)
    let existing: Record<string, unknown> = { mcpServers: {} };
    if (existsSync(destPath)) {
      try {
        existing = JSON.parse(readFileSync(destPath, "utf-8"));
      } catch {}
    }

    const existingServers =
      (existing.mcpServers ?? existing["mcp-servers"] ?? {}) as Record<string, unknown>;

    // .agents/mcp.json is the base; any existing .pi/mcp.json entries win on conflict
    const merged = {
      ...existing,
      mcpServers: {
        ...sourceServers,
        ...existingServers,
      },
    };

    mkdirSync(piDir, { recursive: true });
    writeFileSync(destPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  });
}
