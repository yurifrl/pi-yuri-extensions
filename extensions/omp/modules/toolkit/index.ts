/**
 * Toolkit entry point — registers every toolkit module, honoring its enable flag.
 *
 * Config comes from the shared YuriExtensionsConfig store (pi-yuri-extensions.json, read via ./config.ts). Each
 * module below registers unless the config disables it via "modules": { "<key>": false }. Keys must stay in sync with
 * MODULE_KEYS in config.ts and MODULE_NAMES in ../../../modules/config.ts.
 */
import exitTool from "./exit.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { bootstrapConfig, loadConfig, type ModuleKey } from "./config.ts";
import budget from "./budget.ts";
import coderabbit from "./coderabbit.ts";
import continueAfterCompact from "./continue.ts";
import contextLimit from "./ctx.ts";
import handoff from "./handoff.ts";
import queue from "./queue.ts";
import quick from "./quick.ts";
import respond from "./respond.ts";
import statusline from "./statusline.ts";
import thinking from "./thinking.ts";
import update from "./update.ts";

export default function toolkit(pi: ExtensionAPI): void {
	pi.setLabel("Yuri Toolkit");
	bootstrapConfig(pi.pi.settings.getAgentDir());
	const config = loadConfig(pi.pi.settings.getAgentDir());
	const modules: Record<ModuleKey, (pi: ExtensionAPI) => void> = {
		budget,
		coderabbit,
		continue: continueAfterCompact,
		ctx: contextLimit,
		exit: exitTool,
		handoff,
		queue,
		quick,
		respond,
		statusline,
		thinking,
		update,
	};
	for (const [key, register] of Object.entries(modules) as Array<[ModuleKey, (pi: ExtensionAPI) => void]>) {
		if (config.modules?.[key]?.enabled !== false) register(pi);
	}
}
