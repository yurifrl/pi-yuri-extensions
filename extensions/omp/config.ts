import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, type YuriExtensionsConfig } from "../modules/config.ts";

const CONFIG_PATH = path.join(homedir(), ".omp", "agent", "extensions", "pi-yuri-extensions.json");

export function readOmpConfig(): YuriExtensionsConfig {
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  try {
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("modules" in parsed) || typeof parsed.modules !== "object" || parsed.modules === null) return DEFAULT_CONFIG;
    return {
      modules: {
        ...DEFAULT_CONFIG.modules,
        ...parsed.modules,
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
