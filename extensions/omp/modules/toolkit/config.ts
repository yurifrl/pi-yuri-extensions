/**
 * Config adapter — backs the toolkit modules with the YuriExtensionsConfig store.
 *
 * All settings live in ~/.omp/agent/extensions/pi-yuri-extensions.json (see ../config.ts). This module keeps the
 * original @fbr/toolkit surface (loadConfig / saveConfig / bootstrapConfig + statusline constants) so the module files
 * stay byte-identical to the marketplace source; only the storage backend differs.
 */
import { STATUSLINE_SEGMENT_NAMES, STATUSLINE_COLORS } from "../../../modules/config.ts";
import type { StatuslineSegment } from "../../../modules/config.ts";
import { CONFIG_PATH, readOmpConfig, writeOmpConfig } from "../../config.ts";

export { STATUSLINE_SEGMENT_NAMES, STATUSLINE_COLORS };
export type { StatuslineSegment };
export type StatuslineSegmentName = (typeof STATUSLINE_SEGMENT_NAMES)[number];
export type StatuslineColor = (typeof STATUSLINE_COLORS)[number];

export interface StatuslineConfig {
  segments?: StatuslineSegment[];
}

/** Feature keys, one per registered module surface in index.ts. */
export const MODULE_KEYS = [
  "budget",
  "coderabbit",
  "continue",
  "ctx",
  "exit",
  "handoff",
  "queue",
  "quick",
  "respond",
  "statusline",
  "thinking",
  "update",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export type ModuleConfig = {
  /** false skips the module's command(s) and handlers entirely. */
  enabled?: boolean;
};

export interface ToolkitConfig {
  budgetGates?: number[];
  ctxLimit?: number;
  ctxLimitAction?: "compact" | "stop";
  continueAfterCompactPrompt?: string;
  modules?: Partial<Record<ModuleKey, ModuleConfig>>;
  statusline?: StatuslineConfig;
}

export const STATUSLINE_DEFAULT_SEGMENTS: StatuslineSegment[] = [
  { name: "contextLimit" },
  { name: "budget", color: "statusLineSpend" },
  { name: "sessionCost" },
  { name: "aws", color: "warning" },
  { name: "kube", color: "success" },
];

/**
 * Read the toolkit view of the shared config. Pure read — safe per render frame; the shared reader already falls back
 * to defaults for a missing or malformed file.
 */
export function loadConfig(_agentDir: string): ToolkitConfig {
  const yuri = readOmpConfig();
  return {
    budgetGates: yuri.budgetGates,
    ctxLimit: yuri.ctxLimit,
    ctxLimitAction: yuri.ctxLimitAction,
    continueAfterCompactPrompt: yuri.continueAfterCompactPrompt,
    modules: yuri.modules as ToolkitConfig["modules"],
    statusline: yuri.statusline,
  };
}

/** No-op: bootstrap is owned by the shared config store (pi-yuri-extensions.json). */
export function bootstrapConfig(_agentDir: string): void {}

/** Persist the toolkit-view fields back into the shared config store. */
export function saveConfig(_agentDir: string, config: ToolkitConfig): void {
  const current = readOmpConfig();
  writeOmpConfig(CONFIG_PATH, {
    ...current,
    budgetGates: config.budgetGates,
    ctxLimit: config.ctxLimit,
    ctxLimitAction: config.ctxLimitAction,
    continueAfterCompactPrompt: config.continueAfterCompactPrompt,
    statusline: config.statusline ?? current.statusline,
  });
}
