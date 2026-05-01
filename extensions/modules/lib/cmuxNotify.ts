/**
 * cmuxNotify — shared helper for pushing / listing / dismissing cmux notifications.
 *
 * Used by multiple pi-extension modules (memwatch, idle-watch, …) so the
 * spawn/parse/error-swallow logic is written once.
 *
 * Only Node built-ins + the locally installed `cmux` binary are used.
 * No module-level state, no singletons — safe to import anywhere.
 */

import { spawn, spawnSync } from "node:child_process";

export interface CmuxNotification {
	title: string;
	subtitle?: string;
	body: string;
}

/**
 * Run a command, capture stdout, kill after timeoutMs, never throw.
 * Identical semantics to the local `run` previously in memwatch.ts.
 */
function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			resolve(out);
		}, timeoutMs);
		child.stdout.on("data", (d) => {
			out += d.toString();
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve(out);
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolve(out);
		});
	});
}

/**
 * Push a cmux notification. Returns the cmux-assigned id (looked up via
 * `cmux list-notifications` by matching the caller-provided title), or
 * null if the post failed or the id could not be determined.
 */
export async function push(n: CmuxNotification): Promise<string | null> {
	const args = ["notify", "--title", n.title];
	if (typeof n.subtitle === "string" && n.subtitle.length > 0) {
		args.push("--subtitle", n.subtitle);
	}
	args.push("--body", n.body);

	await run("cmux", args);

	const listed = await list();
	// Most recent matches win — scan reversed.
	for (let i = listed.length - 1; i >= 0; i--) {
		if (listed[i]?.title === n.title) return listed[i]!.id;
	}
	return null;
}

/** Async per-id dismiss via `cmux rpc notification.clear`. Errors are swallowed. */
export async function dismiss(id: string): Promise<void> {
	await run("cmux", ["rpc", "notification.clear", JSON.stringify({ id })]);
}

/**
 * Synchronous best-effort dismiss (for session_shutdown / process.on("exit")).
 * Short timeout, no throw.
 */
export function dismissSync(id: string): void {
	try {
		spawnSync("cmux", ["rpc", "notification.clear", JSON.stringify({ id })], {
			stdio: "ignore",
			timeout: 2000,
		});
	} catch {}
}

/**
 * Parse `cmux list-notifications` output into `{ id, title }` records.
 * Returns [] on any failure. Never throws.
 */
export async function list(): Promise<Array<{ id: string; title: string }>> {
	const out = await run("cmux", ["list-notifications"]);
	const rows: Array<{ id: string; title: string }> = [];
	for (const line of out.split("\n")) {
		const m = line.match(/^\d+:([0-9A-F-]+)\|[^|]*\|[^|]*\|[^|]*\|([^|]+)\|/);
		if (m) rows.push({ id: m[1]!, title: m[2]! });
	}
	return rows;
}
