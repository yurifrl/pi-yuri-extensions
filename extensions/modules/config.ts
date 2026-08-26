export const MODULE_NAMES = ["checkpoint", "envs", "editor", "session-id"] as const;

export type ModuleName = (typeof MODULE_NAMES)[number];

export type ModuleConfig = {
  enabled?: boolean;
  checkpointsDirectory?: string;
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
  },
};

export function isModuleEnabled(config: YuriExtensionsConfig | undefined, name: ModuleName): boolean {
  return config?.modules?.[name]?.enabled ?? DEFAULT_CONFIG.modules[name].enabled;
}
