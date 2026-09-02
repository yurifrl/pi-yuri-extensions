import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, migrateStatusline, type YuriExtensionsConfig } from "../modules/config.ts";

export const CONFIG_PATH = path.join(homedir(), ".omp", "agent", "extensions", "pi-yuri-extensions.json");

export function readOmpConfig(): YuriExtensionsConfig {
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  try {
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("modules" in parsed) || typeof parsed.modules !== "object" || parsed.modules === null) return DEFAULT_CONFIG;
    const raw = parsed as Record<string, unknown>;
    return {
      modules: {
        ...DEFAULT_CONFIG.modules,
        ...(raw.modules as Record<string, unknown>),
      },
      budgetGates: raw.budgetGates as number[] | undefined,
      ctxLimit: raw.ctxLimit as number | undefined,
      ctxLimitAction: raw.ctxLimitAction as "compact" | "stop" | undefined,
      statusline: migrateStatusline(raw.statusline as unknown),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Persist the full config (modules incl. per-module extras like notifications.events). */
export function writeOmpConfig(filePath: string, config: YuriExtensionsConfig): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
