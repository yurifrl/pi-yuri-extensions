export const MODULE_NAMES = ["checkpoint", "envs", "editor", "save", "session-id", "working", "nudge", "notifications"] as const;

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

export type YuriExtensionsConfig = {
  modules?: Partial<Record<ModuleName, ModuleConfig>>;
};

export const DEFAULT_CONFIG: Required<YuriExtensionsConfig> = {
  modules: {
    checkpoint: { enabled: true },
    envs: { enabled: true },
    editor: { enabled: true },
    "session-id": { enabled: true },
    working: { enabled: true },
    nudge: { enabled: true },
    notifications: { enabled: true },
    save: { enabled: true },
  },
};

export function isModuleEnabled(config: YuriExtensionsConfig | undefined, name: ModuleName): boolean {
  return config?.modules?.[name]?.enabled ?? DEFAULT_CONFIG.modules[name]?.enabled ?? true;
}
