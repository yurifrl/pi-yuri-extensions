import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { isModuleEnabled, type ModuleName } from "../modules/config.ts";
import { readOmpConfig } from "./config.ts";
import aws from "../modules/aws.ts";
import checkpoint from "../modules/checkpoint/omp.ts";
import editor from "./modules/editor.ts";
import envs from "./modules/envs.ts";
import nudge from "./modules/nudge.ts";
import notifications from "./modules/notifications.ts";
import save from "../modules/save.ts";
import sessionId from "./modules/session-id.ts";
import working from "./modules/working.ts";
import toolkit from "./modules/toolkit/index.ts";

type OmpModule = (pi: ExtensionAPI) => void;

const MODULES: Partial<Record<ModuleName, OmpModule>> = {
  aws,
  checkpoint,
  envs,
  editor,
  save,
  "session-id": sessionId,
  working,
  nudge,
  notifications,
  toolkit,
};

export default function yuriExtensions(pi: ExtensionAPI): void {
  const config = readOmpConfig();
  for (const name of Object.keys(MODULES) as ModuleName[]) {
    const register = MODULES[name];
    if (register && isModuleEnabled(config, name)) register(pi);
  }
}
