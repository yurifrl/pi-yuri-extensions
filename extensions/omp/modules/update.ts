import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { push } from "../../modules/lib/cmuxNotify.ts";

/**
 * update — declarative plugin-store maintenance for omp.
 *
 * Usage:
 *   /update          - reinstall (clean node_modules + bun install) + omp update --plugins + omp update (background)
 *   /update check    - reinstall only, no omp upgrades
 *   /update status   - show whether a run is in flight / last report
 *
 * Everything runs detached in the background; the report surfaces as a cmux
 * banner when the pipeline finishes. A lock file prevents overlapping runs.
 */

const PLUGIN_DIR = `${process.env.HOME}/.omp/plugins`;
const LOCK_FILE = `${PLUGIN_DIR}/.update-running`;
const LOG_FILE = `${PLUGIN_DIR}/.update-last.log`;

interface StepResult {
	ok: boolean;
	summary: string;
}

interface RunStep {
	cmd: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	label: string;
}

function runStep(step: RunStep): Promise<StepResult> {
	const { promise, resolve } = Promise.withResolvers<StepResult>();
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(step.cmd, step.args, { cwd: step.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
	} catch (e) {
		resolve({ ok: false, summary: e instanceof Error ? e.message : String(e) });
		return promise;
	}
	let out = "";
	const timer = setTimeout(() => child.kill("SIGKILL"), step.timeoutMs);
	timer.unref?.();

	const append = (d: Buffer) => {
		out += d.toString("utf8");
		if (out.length > 20_000) out = out.slice(-20_000);
	};
	child.stdout?.on("data", append);
	child.stderr?.on("data", append);

	child.on("error", (e) => {
		clearTimeout(timer);
		resolve({ ok: false, summary: e.message });
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		const tail = out.trimEnd().split("\n").slice(-3).join(" | ").slice(0, 300);
		resolve({ ok: code === 0, summary: code === 0 ? tail || "ok" : `${tail} (exit ${code ?? "?"})` });
	});
	return promise;
}

async function pipeline(checkOnly: boolean): Promise<string> {
	const lines: string[] = [];
	const bun = process.env.BUN_BIN ?? "bun";
	// bun has no `prune` in 1.3.x (reserved subcommand). The declarative
	// equivalent of prune+install: a clean reinstall from package.json —
	// node_modules is derived state, bun.lock is the source of truth.
	const steps: RunStep[] = [
		{ cmd: "mv", args: ["node_modules", ".node_modules.trash"], cwd: PLUGIN_DIR, timeoutMs: 60_000, label: "clean" },
		{ cmd: bun, args: ["install"], cwd: PLUGIN_DIR, timeoutMs: 10 * 60_000, label: "install" },
	];
	if (!checkOnly) {
		steps.push({ cmd: "omp", args: ["update", "--plugins"], cwd: PLUGIN_DIR, timeoutMs: 15 * 60_000, label: "omp update --plugins" });
		steps.push({ cmd: "omp", args: ["update"], cwd: PLUGIN_DIR, timeoutMs: 15 * 60_000, label: "omp update" });
	}

	for (const step of steps) {
		const result = await runStep(step);
		lines.push(`${step.label}: ${result.ok ? "done" : "FAILED"} ${result.summary}`);
	}
	if (!checkOnly) {
		try {
			rmSync(`${PLUGIN_DIR}/.node_modules.trash`, { recursive: true, force: true });
		} catch {}
	}
	return lines.join("\n");
}

export default function update(pi: ExtensionAPI): void {
	pi.registerCommand("update", {
		description:
			"Reinstall the omp plugin store declaratively in the background: clean node_modules + bun install (+ omp update --plugins and omp update unless /update check). /update status shows last report.",
		handler: async (args, ctx) => {
			const mode = (args ?? "").trim().toLowerCase();
			const checkOnly = mode === "check";

			if (mode === "status") {
				if (existsSync(LOCK_FILE)) {
					ctx.ui.notify("update: already running", "info");
				} else if (existsSync(LOG_FILE)) {
					ctx.ui.notify(`last run:\n${readFileSync(LOG_FILE, "utf8").trim()}`, "info");
				} else {
					ctx.ui.notify("update: idle, no previous run", "info");
				}
				return;
			}

			if (existsSync(LOCK_FILE)) {
				ctx.ui.notify("update: already running — check /update status", "warning");
				return;
			}

			writeFileSync(LOCK_FILE, new Date().toISOString(), "utf8");
			ctx.ui.notify(checkOnly ? "update: checking in background…" : "update: running in background…", "info");

			void pipeline(checkOnly)
				.then((report) => {
					writeFileSync(LOG_FILE, `${new Date().toISOString()}\n${report}\n`, "utf8");
					push(checkOnly ? "🔄 Update Check" : "✅ Plugin Store Updated", report || "completed");
				})
				.catch((e: unknown) => {
					writeFileSync(LOG_FILE, `${new Date().toISOString()}\nerror: ${String(e)}\n`, "utf8");
					push("💥 Update Failed", String(e).slice(0, 300));
				})
				.finally(() => {
					try {
						rmSync(LOCK_FILE);
					} catch {}
				});
		},
	});
}
