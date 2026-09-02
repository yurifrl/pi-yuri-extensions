export const MODULE_NAMES = [
  "checkpoint",
  "envs",
  "editor",
  "save",
  "session-id",
  "working",
  "nudge",
  "notifications",
  "aws",
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

export type ModuleName = (typeof MODULE_NAMES)[number];

export type ModuleConfig = {
  enabled?: boolean;
  checkpointsDirectory?: string;
  /** working module: seconds of silence before the elapsed timer starts. */
  graceSeconds?: number;
  /** working module: seconds of silence before the label flips to "Still working…". */
  stillAfterSeconds?: number;
  /** working module: log event/timer diagnostics to the omp log. */
  debug?: boolean;
  /** notifications module: per-event on/off overrides (see omp/modules/notifications.ts). */
  events?: Record<string, boolean>;
};

export const STATUSLINE_SEGMENT_NAMES = ["contextLimit", "budget", "sessionCost", "aws", "kube"] as const;
export const STATUSLINE_COLORS = [
  "accent",
  "success",
  "warning",
  "error",
  "statusLineContext",
  "statusLineSpend",
  "statusLineCost",
] as const;

export const STATUSLINE_DEFAULT_SEGMENTS: StatuslineSegment[] = [
  { name: "contextLimit" },
  { name: "budget", color: "statusLineSpend" },
  { name: "sessionCost" },
  { name: "aws", color: "warning" },
  { name: "kube", color: "success" },
];

export type StatuslineSegmentName = (typeof STATUSLINE_SEGMENT_NAMES)[number];
export type StatuslineColor = (typeof STATUSLINE_COLORS)[number];

/** Toolkit top-level fields (see modules/budget, modules/ctx, omp/modules/continue). */
export interface StatuslineSegment {
  name: (typeof STATUSLINE_SEGMENT_NAMES)[number];
  color?: (typeof STATUSLINE_COLORS)[number];
  /** false hides the segment from the footer. */
  enabled?: boolean;
}

export type YuriExtensionsConfig = {
  modules?: Partial<Record<ModuleName, ModuleConfig>>;
  /** budget module: USD spend gates persisted globally. */
  budgetGates?: number[];
  /** ctx module: artificial context cap in tokens. */
  ctxLimit?: number;
  /** ctx module: what happens at the cap. */
  ctxLimitAction?: "compact" | "stop";
  /** continue module: prompt re-sent after automatic maintenance compaction. */
  continueAfterCompactPrompt?: string;
  statusline?: { segments?: StatuslineSegment[] };
};
export const DEFAULT_CONFIG: Required<Pick<YuriExtensionsConfig, "modules">> & Partial<YuriExtensionsConfig> = {
  modules: {
    checkpoint: { enabled: true },
    envs: { enabled: true },
    editor: { enabled: true },
    "session-id": { enabled: true },
    working: { enabled: true },
    nudge: { enabled: true },
    notifications: { enabled: true },
    aws: { enabled: true },
    budget: { enabled: true },
    coderabbit: { enabled: true },
    continue: { enabled: true },
    ctx: { enabled: true },
    exit: { enabled: true },
    handoff: { enabled: true },
    queue: { enabled: true },
    quick: { enabled: true },
    respond: { enabled: true },
    statusline: { enabled: true },
    thinking: { enabled: true },
    update: { enabled: true },
    save: { enabled: true },
  },
};

export function isModuleEnabled(config: YuriExtensionsConfig | undefined, name: ModuleName): boolean {
  return config?.modules?.[name]?.enabled ?? DEFAULT_CONFIG.modules[name]?.enabled ?? true;
}

// ---------------------------------------------------------------------------
// Shared config store — runtime-agnostic read/write of pi-yuri-extensions.json.
// Each runtime resolves its own global config path: omp passes
// pi.pi.settings.getAgentDir(), pi passes its global config dir. Modules in
// this directory never touch the filesystem directly.
// ---------------------------------------------------------------------------

export interface ConfigStore {
  read(): YuriExtensionsConfig;
  write(config: YuriExtensionsConfig): void;
}

let store: ConfigStore | undefined;

/** Register the runtime config store. Called once by each runtime's loader. */
export function setConfigStore(impl: ConfigStore): void {
  store = impl;
}

/** Read the shared config. Falls back to defaults when no store is registered. */
export function readSharedConfig(): YuriExtensionsConfig {
  return store?.read() ?? DEFAULT_CONFIG;
}

/** Write through the registered store. No-op when none is registered. */
export function writeSharedConfig(config: YuriExtensionsConfig): void {
  store?.write(config);
}
