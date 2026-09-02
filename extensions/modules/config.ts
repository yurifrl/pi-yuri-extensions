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
  "later",
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

export const STATUSLINE_COMPONENT_NAMES = ["indicator", "contextLimit", "budget", "sessionCost", "aws", "kube"] as const;
export const STATUSLINE_COLORS = [
  "accent",
  "success",
  "warning",
  "error",
  "statusLineContext",
  "statusLineSpend",
  "statusLineCost",
] as const;

export type StatuslineComponentName = (typeof STATUSLINE_COMPONENT_NAMES)[number];
export type StatuslineColor = (typeof STATUSLINE_COLORS)[number];

/** statusline.prefix: "state" renders the event-driven indicator glyph, "none" no prefix, a literal string as-is. */
export type StatuslinePrefix = "state" | "none" | (string & {});

/** Per-component config block; unknown extra keys are tolerated for forward compatibility. */
export interface StatuslineComponentConfig {
  enabled?: boolean;
  color?: StatuslineColor | "auto";
}

export interface StatuslineConfig {
  /** "state" (default) | "none" | literal prefix glyph. */
  prefix?: StatuslinePrefix;
  /** Render order; every name must be a registered component. */
  order?: StatuslineComponentName[];
  /** Per-component blocks keyed by component name. */
  components?: Partial<Record<StatuslineComponentName, Record<string, unknown>>>;
}

export const STATUSLINE_DEFAULT_ORDER: StatuslineComponentName[] = [
  "indicator",
  "contextLimit",
  "budget",
  "sessionCost",
  "aws",
  "kube",
];


/**
 * Normalize a raw `statusline` config value: unknown/non-object → undefined; legacy `segments` array →
 * `order` + per-component `{enabled, color}` (both runtimes call this on read, so the rest of the code
 * only ever sees the new shape). Already-migrated blocks pass through untouched.
 */
export function migrateStatusline(raw: unknown): StatuslineConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown> & Partial<StatuslineConfig>;
  const migrated: StatuslineConfig = {
    prefix: input.prefix,
    order: input.order ? [...input.order] : undefined,
    components: input.components ? { ...input.components } : undefined,
  };
  if (Array.isArray(input.segments)) {
    const order = migrated.order ?? [];
    const components = { ...(migrated.components ?? {}) };
    for (const segment of input.segments) {
      if (typeof segment !== "object" || segment === null) continue;
      const { name, color, enabled } = segment as { name?: unknown; color?: unknown; enabled?: unknown };
      if (typeof name !== "string" || !STATUSLINE_COMPONENT_NAMES.includes(name as StatuslineComponentName)) continue;
      if (!order.includes(name as StatuslineComponentName)) order.push(name as StatuslineComponentName);
      components[name as StatuslineComponentName] = {
        ...components[name as StatuslineComponentName],
        ...(typeof color === "string" ? { color } : {}),
        ...(enabled === false ? { enabled: false } : {}),
      };
    }
    migrated.order = order;
    migrated.components = components;
  }
  if (!migrated.prefix && !migrated.order?.length && !migrated.components && !Array.isArray(input.segments)) return undefined;
  return migrated;
}


export type YuriExtensionsConfig = {
  modules?: Partial<Record<ModuleName, ModuleConfig>>;
  /** budget module: USD spend gates persisted globally. */
  budgetGates?: number[];
  statusline?: StatuslineConfig;
  ctxLimit?: number;
  /** ctx module: what happens at the cap. */
  ctxLimitAction?: "compact" | "stop";
  /** continue module: prompt re-sent after automatic maintenance compaction. */
  continueAfterCompactPrompt?: string;
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
    later: { enabled: true },
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
