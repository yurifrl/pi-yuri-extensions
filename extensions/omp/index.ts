import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { isModuleEnabled, setConfigStore, type ModuleName } from "../modules/config.ts";
import { readOmpConfig, writeOmpConfig, CONFIG_PATH } from "./config.ts";
import aws from "../modules/aws/index.ts";
import budget from "../modules/budget.ts";
import checkpoint from "../modules/checkpoint/omp.ts";
import coderabbit from "../modules/coderabbit/index.ts";
import contextLimit from "../modules/ctx.ts";
import continueAfterCompact from "./modules/continue.ts";
import editor from "./modules/editor.ts";
import envs from "./modules/envs.ts";
import exitTool from "../modules/exit.ts";
import handoff from "../modules/handoff.ts";
import nudge from "./modules/nudge.ts";
import notifications from "./modules/notifications.ts";
import queue from "../modules/queue.ts";
import quick from "../modules/quick.ts";
import respond from "../modules/respond.ts";
import save from "../modules/save.ts";
import sessionId from "./modules/session-id.ts";
import statusline from "../modules/statusline/index.ts";
import thinking from "../modules/thinking.ts";
import ompUpdate from "./modules/update.ts";
import working from "./modules/working.ts";

setConfigStore({
  read: readOmpConfig,
  write: (config) => writeOmpConfig(CONFIG_PATH, config),
});

type OmpModule = (pi: ExtensionAPI) => void;

const MODULES: Partial<Record<ModuleName, OmpModule>> = {
  aws,
  budget,
  checkpoint,
  coderabbit,
  continue: continueAfterCompact,
  ctx: contextLimit,
  envs,
  editor,
  exit: exitTool,
  handoff,
  queue,
  quick,
  respond,
  save,
  "session-id": sessionId,
  statusline,
  thinking,
  update: ompUpdate,
  working,
  nudge,
  notifications,
};

export default function yuriExtensions(pi: ExtensionAPI): void {
  const config = readOmpConfig();
  for (const name of Object.keys(MODULES) as ModuleName[]) {
    const register = MODULES[name];
    if (register && isModuleEnabled(config, name)) register(pi);
  }
}
