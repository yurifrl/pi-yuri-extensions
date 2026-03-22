import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import { readPiYuConfigFile } from "./config.ts";

type ExtensionModule = { default?: (pi: ExtensionAPI) => void };

type ToggleConfig = {
  extensions?: Record<string, boolean>;
  notify?: {
    backend?: string;
    oscProtocol?: string;
  };
};

const MODULE_LOADERS: Record<string, () => Promise<ExtensionModule>> = {
  "agent-loop": () => import("./modules/agent-loop.ts"),
  "agents-mcp-loader": () => import("./modules/agents-mcp-loader.ts"),
  "yu-notify": () => import("./modules/yu-notify.ts"),
  minimal: () => import("./modules/minimal.ts"),
  "pure-focus": () => import("./modules/pure-focus.ts"),
  "purpose-gate": () => import("./modules/purpose-gate.ts"),
  "tool-counter": () => import("./modules/tool-counter.ts"),
  "tool-counter-widget": () => import("./modules/tool-counter-widget.ts"),
  what: () => import("./modules/what.ts"),
  "subagent-widget": () => import("./modules/subagent-widget.ts"),
  tilldone: () => import("./modules/tilldone.ts"),
  "tilldone-footer": () => import("./modules/tilldone-footer.ts"),
  "theme-cycler": () => import("./modules/theme-cycler.ts"),
  "system-select": () => import("./modules/system-select.ts"),
  "session-replay": () => import("./modules/session-replay.ts"),
  "damage-control": () => import("./modules/damage-control.ts"),
  "cross-agent": () => import("./modules/cross-agent.ts"),
  "agent-team": () => import("./modules/agent-team.ts"),
  "agent-chain": () => import("./modules/agent-chain.ts"),
  "pi-pi": () => import("./modules/pi-pi.ts"),
  "confirm-notify": () => import("./modules/confirm-notify.ts"),
  "custom-footer": () => import("./modules/custom-footer.ts"),
};

const DEFAULT_CONFIG: ToggleConfig = {
  extensions: Object.fromEntries(Object.keys(MODULE_LOADERS).map((name) => [name, false])),
};

async function readConfig(cwd: string): Promise<{ config: ToggleConfig; configPath: string }> {
  const { configPath, content } = await readPiYuConfigFile(cwd);

  if (!content) {
    return { config: DEFAULT_CONFIG, configPath };
  }

  try {
    const parsed = JSON.parse(content) as ToggleConfig;

    return {
      config: {
        ...DEFAULT_CONFIG,
        ...parsed,
        extensions: {
          ...DEFAULT_CONFIG.extensions,
          ...(parsed.extensions || {}),
        },
      },
      configPath,
    };
  } catch {
    return { config: DEFAULT_CONFIG, configPath };
  }
}

function enabledModules(config: ToggleConfig): string[] {
  const entries = config.extensions || {};
  return Object.keys(MODULE_LOADERS).filter((name) => entries[name] === true);
}

async function loadEnabled(pi: ExtensionAPI, cwd: string): Promise<{ loaded: string[]; configPath: string }> {
  const { config, configPath } = await readConfig(cwd);
  const enabled = enabledModules(config);
  const loaded: string[] = [];

  for (const name of enabled) {
    const loader = MODULE_LOADERS[name];
    if (!loader) continue;

    try {
      const mod = await loader();
      if (typeof mod.default === "function") {
        mod.default(pi);
        loaded.push(name);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[pi-my-extensions] failed to load module '${name}':`, error);
    }
  }

  return { loaded, configPath };
}

export default function piYu(pi: ExtensionAPI) {
  let initialized = false;
  let loadedModules: string[] = [];
  let configPath = path.join(process.cwd(), ".pi", "extensions", "pi-my-extensions.json");

  pi.on("session_start", async (_event, ctx) => {
    if (initialized) return;
    initialized = true;

    const loaded = await loadEnabled(pi, ctx.cwd);
    loadedModules = loaded.loaded;
    configPath = loaded.configPath;

    const msg = loadedModules.length > 0
      ? `pi-my-extensions loaded: ${loadedModules.join(", ")}`
      : "pi-my-extensions loaded with no active modules (all off by default)";

    ctx.ui.notify(msg, loadedModules.length > 0 ? "success" : "info");
  });

  pi.registerCommand("pi-my-extensions", {
    description: "Show pi-my-extensions module toggle status and config path",
    handler: async (_args, ctx) => {
      const { config } = await readConfig(ctx.cwd);
      const rows = Object.keys(MODULE_LOADERS)
        .sort()
        .map((name) => `${config.extensions?.[name] ? "ON " : "OFF"}  ${name}`)
        .join("\n");

      const loaded = loadedModules.length ? loadedModules.join(", ") : "(none)";
      const text = `pi-my-extensions\n\nConfig: ${configPath}\n\nLoaded this session: ${loaded}\n\nToggles:\n${rows}`;

      // eslint-disable-next-line no-console
      console.log(text);
      ctx.ui.notify(`pi-my-extensions status printed to terminal (${configPath})`, "info");
    },
  });
}
