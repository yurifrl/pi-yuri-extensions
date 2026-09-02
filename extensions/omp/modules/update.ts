import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { rmSync } from "node:fs";

const STATUS_KEY = "update";
/** omp's plugin store: declarative package.json/bun.lock, node_modules is derived state. */
const PLUGIN_DIR = `${process.env.HOME}/.omp/plugins`;
const STALE_DIR = `${PLUGIN_DIR}/.node_modules.trash`;

type UpdateStep = {
	label: string;
	run: string;
	args: string[];
};

/**
 * Modes:
 *   /update        — omp update --plugins, then omp update (marketplace AGENTS.md sequence)
 *   /update prune  — clean reinstall of the plugin store: move node_modules aside,
 *                    bun install to reconcile from package.json/bun.lock. This is the
 *                    declarative prune (bun 1.3.x has no `bun prune` subcommand).
 *
 * Steps run sequentially in the background with a single-flight guard (concurrent
 * invocations are refused). Disable: "modules": { "update": false }.
 */
const UPDATE_STEPS: UpdateStep[] = [
	{ label: "OMP plugins", run: "omp", args: ["update", "--plugins"] },
	{ label: "OMP", run: "omp", args: ["update"] },
];

const PRUNE_STEPS: UpdateStep[] = [
	{ label: "clean", run: "sh", args: ["-c", "mv -f node_modules .node_modules.trash 2>/dev/null; true"] },
	{ label: "install", run: "bun", args: ["install"] },
];

export default function update(pi: ExtensionAPI): void {
	// One update at a time: concurrent /update + /update prune would interleave
	// destructive steps (mv node_modules aside while another run reinstalls it).
	let running = false;
	pi.registerCommand("update", {
		description:
			"Update omp plugins and omp. Usage: /update — updates plugins then omp; /update prune — clean reinstall of the plugin store (declarative prune). Offers a session reload on success.",
		handler: async (args, ctx) => {
			const c = ctx as ExtensionCommandContext;
			const mode = (args ?? "").trim().toLowerCase();
			const prune = mode === "prune";
			const steps = prune ? PRUNE_STEPS : UPDATE_STEPS;

			c.ui.notify(prune ? "Pruning plugin store in background…" : "Starting update in background…", "info");

			if (running) {
				c.ui.notify("Update already in progress", "warning");
				return;
			}
			running = true;
			void (async () => {
				try {
					await runSteps(pi, prune, steps, c);
				} finally {
					running = false;
				}
			})();
		},
	});
}

async function runSteps(pi: ExtensionAPI, prune: boolean, steps: UpdateStep[], c: ExtensionCommandContext): Promise<void> {
	const errors: string[] = [];

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		c.ui.setStatus(STATUS_KEY, `⏳ ${step.label}… (${i + 1}/${steps.length})`);

		try {
			const result = await pi.exec(step.run, step.args, { cwd: PLUGIN_DIR, timeout: 600_000 });
			if (result.code !== 0) {
				const msg = (result.stderr || result.stdout || "").trim();
				errors.push(`${step.label} failed (exit ${result.code}): ${msg}`);
				break;
			}
		} catch (err: unknown) {
			errors.push(`${step.label}: ${err instanceof Error ? err.message : String(err)}`);
			break;
		}
	}

	// Best-effort: drop the stale tree after a successful prune.
	if (errors.length === 0 && prune) {
		try {
			rmSync(STALE_DIR, { recursive: true, force: true });
		} catch {}
	}

	c.ui.setStatus(STATUS_KEY, undefined);

	if (errors.length > 0) {
		c.ui.notify(`Update failed:\n${errors.join("\n")}`, "error");
		return;
	}

	c.ui.notify(prune ? "Store reinstalled (pruned)" : "All updates complete", "info");
	if (!prune) {
		const reload = await c.ui.confirm("Reload session?", "Updates installed. Reload to pick up changes?");
		if (reload) await c.reload();
	}
}
