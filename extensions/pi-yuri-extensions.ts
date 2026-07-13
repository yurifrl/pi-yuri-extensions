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
  yes: () => import("./modules/yes.ts"),
  "agents-mcp-loader": () => import("./modules/agents-mcp-loader.ts"),
  "yu-notify": () => import("./modules/yu-notify.ts"),
  "tilldone-footer": () => import("./modules/tilldone-footer.ts"),
  "cross-agent": () => import("./modules/cross-agent.ts"),
  "custom-footer": () => import("./modules/custom-footer.ts"),
  checkpoint: () => import("./modules/checkpoint.ts"),
  "supplemental-notifications": () => import("./modules/supplemental-notifications.ts"),
  update: () => import("./modules/update.ts"),
  "copy-slack": () => import("./modules/copy-slack.ts"),
  respond: () => import("./modules/respond.ts"),
  draft: () => import("./modules/draft.ts"),
  "greetings": () => import("./modules/greetings.ts"),
  "session-id": () => import("./modules/session-id.ts"),
  aws: () => import("./modules/aws.ts"),
  memwatch: () => import("./modules/memwatch.ts"),
  "idle-watch": () => import("./modules/idle-watch.ts"),
  helpy: () => import("./modules/helpy.ts"),
  "pi-beads": () => import("./modules/pi-beads.ts"),
  "git": () => import("./modules/git.ts"),
  thinking: () => import("./modules/thinking.ts"),
  timeout: () => import("./modules/timeout.ts"),
  e: () => import("./modules/e.ts"),
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
      console.error(`[pi-yuri-extensions] failed to load module '${name}':`, error);
    }
  }

  return { loaded, configPath };
}

export default function piYu(pi: ExtensionAPI) {
  // Flags for modules that need preboot registration.
  // registerFlag only works here (before argv is parsed); modules load too late.
  pi.registerFlag?.("yes", {
    description: "Auto-approve all interactive prompts (session-only)",
    type: "boolean",
    default: false,
  });
  pi.registerFlag?.("cross-agent-verbose", {
    description: "Print cross-agent discovery details on startup",
    type: "boolean",
    default: false,
  });
  pi.registerFlag?.("quiet", {
    description: "Suppress non-error pi-yuri-extensions / pi-gastown notifications (info/success toasts)",
    type: "boolean",
    default: false,
  });
  let initialized = false;
  let loadedModules: string[] = [];
  let configPath = path.join(process.cwd(), ".pi", "extensions", "pi-yuri-extensions.json");

  pi.on("session_start", async (_event, ctx) => {
    if (initialized) return;
    initialized = true;

    // --quiet: monkey-patch the shared uiContext so EVERY extension's
    // ctx.ui.notify(...) becomes a no-op (errors still surface). All
    // extensions read ctx.ui from the same runner.uiContext object, so
    // patching once silences pi-yuri-extensions, pi-gastown, idle-watch,
    // anything else loaded.
    if (pi.getFlag?.("quiet") === true) {
      const orig = ctx.ui.notify.bind(ctx.ui);
      ctx.ui.notify = (msg: string, type?: "info" | "warning" | "error") => {
        if (type === "error") orig(msg, type);
      };
    }

    const loaded = await loadEnabled(pi, typeof ctx.cwd === "function" ? ctx.cwd() : ctx.cwd);
    loadedModules = loaded.loaded;
    configPath = loaded.configPath;

    const msg = loadedModules.length > 0
      ? `pi-yuri-extensions loaded: ${loadedModules.join(", ")}`
      : "pi-yuri-extensions loaded with no active modules (all off by default)";

    if (pi.getFlag?.("quiet") !== true) {
      ctx.ui.notify(msg, loadedModules.length > 0 ? "success" : "info");
    }
  });

  pi.registerCommand("pi-yuri-extensions", {
    description: "Show pi-yuri-extensions module toggle status and config path",
    handler: async (_args, ctx) => {
      const { config } = await readConfig(typeof ctx.cwd === "function" ? ctx.cwd() : ctx.cwd);
      const rows = Object.keys(MODULE_LOADERS)
        .sort()
        .map((name) => `${config.extensions?.[name] ? "ON " : "OFF"}  ${name}`)
        .join("\n");

      const loaded = loadedModules.length ? loadedModules.join(", ") : "(none)";
      const text = `pi-yuri-extensions\n\nConfig: ${configPath}\n\nLoaded this session: ${loaded}\n\nToggles:\n${rows}`;

      // eslint-disable-next-line no-console
      console.log(text);
      ctx.ui.notify(`pi-yuri-extensions status printed to terminal (${configPath})`, "info");
    },
  });
}
