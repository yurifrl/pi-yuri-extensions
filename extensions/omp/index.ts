import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { isModuleEnabled, type ModuleName } from "../modules/config.ts";
import { readOmpConfig } from "./config.ts";
import checkpoint from "../modules/checkpoint/omp.ts";
import editor from "./modules/editor.ts";
import envs from "./modules/envs.ts";
import nudge from "./modules/nudge.ts";
import update from "./modules/update.ts";
import sessionId from "./modules/session-id.ts";
import working from "./modules/working.ts";

type OmpModule = (pi: ExtensionAPI) => void;

const MODULES: Record<ModuleName, OmpModule> = {
  checkpoint,
  editor,
  envs,
  "session-id": sessionId,
  update,
  nudge,
  notifications,
};

export default function yuriExtensions(pi: ExtensionAPI): void {
  const config = readOmpConfig();
  for (const name of Object.keys(MODULES) as ModuleName[]) {
    if (isModuleEnabled(config, name)) MODULES[name](pi);
  }
}
