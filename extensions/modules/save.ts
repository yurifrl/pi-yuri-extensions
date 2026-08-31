import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * save — register the current session with `cly agent-session` (`cly as save`).
 *
 * Ported from the cly-shipped pi extension (home/.pi/agent/extensions/cly.ts,
 * originally home/.pi/agent/extensions/pi-cly/index.ts) so both Pi and OMP get
 * /save from pi-yuri-extensions.
 *
 *   /save [name] [description="..."]
 *     Runs `cly as save <id> --name <name> --description <description> --override`
 *     with deterministic prefilled values and surfaces the result via
 *     ctx.ui.notify. Fully handled by this extension — nothing is fed back to
 *     the agent, so /save never triggers a turn.
 *
 * Session id resolution: ctx.sessionManager.getSessionId()/getSessionFile()
 * first-line `.id`, falling back to the latest *.jsonl under the runtime
 * session dir for cwd. Works identically for Pi and OMP — both write a
 * `{"type":"session",...,"id"}` header as the first jsonl line.
 *
 * Optional runtime-session naming: $CLY_SESSION_NAME (or $CLAUDE_SESSION_NAME)
 * is applied as the session display name on session_start when different.
 */

interface SaveArgs {
	id: string;
	name: string;
	description: string;
}

interface SaveOverrides {
	name?: string;
	description?: string;
}

interface ClyResult {
	code: number;
	stdout: string;
	stderr: string;
}

type SessionManagerLike = {
	getSessionFile?: () => string | null;
	getSessionId?: () => string | null;
};

const KV_RE = /(\w+)=(?:"([^"]*)"|(\S+))/g;

export function parseSaveArgs(raw: string): SaveOverrides {
	const overrides: Record<string, string> = {};
	const rest = raw.replace(KV_RE, (_m, key: string, quoted?: string, bare?: string) => {
		overrides[key] = quoted !== undefined ? quoted : bare !== undefined ? bare : "";
		return " ";
	});
	const name = rest.trim();
	const out: SaveOverrides = {};
	if (name.length > 0) out.name = name;
	if (typeof overrides.description === "string") out.description = overrides.description;
	return out;
}

function slugify(input: string): string {
	const s = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return s.length > 0 ? s : "session";
}

function cwdOf(ctx: unknown): string {
	if (typeof ctx !== "object" || ctx === null || !("cwd" in ctx)) return process.cwd();
	const cwd = (ctx as { cwd: unknown }).cwd;
	if (typeof cwd === "function") return cwd() as string;
	if (typeof cwd === "string") return cwd;
	return process.cwd();
}

function readIdFromSessionFile(file: string | null | undefined): string {
	try {
		if (typeof file !== "string" || file.length === 0) return "";
		const first = readFileSync(file, "utf-8").split("\n")[0]?.trim() ?? "";
		if (first.length === 0) return "";
		const obj: unknown = JSON.parse(first);
		if (typeof obj === "object" && obj !== null && "id" in obj && typeof (obj as { id: unknown }).id === "string") {
			return (obj as { id: string }).id;
		}
	} catch {
		// fall through — caller treats "" as unresolved
	}
	return "";
}

/**
 * Latest *.jsonl under <agentDir>/sessions/--<cwd>-- for either runtime.
 * Pi and OMP use the same `--slash-free-cwd--` encoding (OMP additionally
 * allows date-prefixed subdirectories, which we skip — files only).
 */
function findSessionFileForCwd(agentDir: string, cwd: string): string {
	const trimmed = cwd.replace(/^\/+|\/+$/g, "");
	const encoded = `--${trimmed.replace(/\//g, "-")}--`;
	const sessionDir = path.join(agentDir, "sessions", encoded);
	if (!existsSync(sessionDir)) return "";
	try {
		const candidates = readdirSync(sessionDir)
			.filter((n) => n.endsWith(".jsonl"))
			.map((n) => path.join(sessionDir, n))
			.filter((f) => { try { return statSync(f).isFile(); } catch { return false; } })
			.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
		return candidates[0] ?? "";
	} catch {
		return "";
	}
}

function getSessionId(ctx: unknown, cwd: string): string {
	try {
		let manager: SessionManagerLike | undefined;
		if (typeof ctx === "object" && ctx !== null && "sessionManager" in ctx) {
			const raw = (ctx as { sessionManager: unknown }).sessionManager;
			if (typeof raw === "object" && raw !== null) manager = raw as SessionManagerLike;
		}
		if (manager) {
			if (typeof manager.getSessionId === "function") {
				const direct = manager.getSessionId();
				if (typeof direct === "string" && direct.length > 0) return direct;
			}
			const id = readIdFromSessionFile(typeof manager.getSessionFile === "function" ? manager.getSessionFile() : null);
			if (id.length > 0) return id;
		}
		const home = process.env.HOME ?? "";
		for (const agentDir of [path.join(home, ".pi", "agent"), path.join(home, ".omp", "agent")]) {
			const id = readIdFromSessionFile(findSessionFileForCwd(agentDir, cwd));
			if (id.length > 0) return id;
		}
	} catch {
		// ignore — caller falls back to a timestamped synthetic id
	}
	return "";
}

function defaultPrefills(pi: ExtensionAPI, ctx: unknown, cwd: string): SaveArgs {
	const slug = slugify(path.basename(cwd));
	let id = getSessionId(ctx, cwd);
	if (id.length === 0) {
		const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
		id = `${slug}-${ts}`;
	}
	let summary = "";
	try {
		const name = (pi as ExtensionAPI & { getSessionName?: () => string | null }).getSessionName?.();
		if (typeof name === "string") summary = name.trim();
	} catch {
		// summary is optional decoration
	}
	return {
		id,
		name: summary.length > 0 ? summary : slug,
		description: `session in ${cwd}`,
	};
}

function runCly(args: string[]): Promise<ClyResult> {
	const { promise, resolve } = Promise.withResolvers<ClyResult>();
	const child = spawn("cly", args, { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
	child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
	child.on("error", (err: Error) => resolve({ code: -1, stdout, stderr: `${stderr}${String(err)}` }));
	child.on("close", (code) => resolve({ code: code == null ? -1 : code, stdout, stderr }));
	return promise;
}

function notify(ctx: unknown, msg: string, level: "info" | "success" | "error"): void {
	try {
		if (typeof ctx !== "object" || ctx === null || !("ui" in ctx) || !("hasUI" in ctx)) return;
		if ((ctx as { hasUI: unknown }).hasUI !== true) return;
		const ui = (ctx as { ui: unknown }).ui;
		if (typeof ui !== "object" || ui === null || !("notify" in ui)) return;
		const notifyFn = (ui as { notify: unknown }).notify;
		if (typeof notifyFn === "function") (notifyFn as (m: string, l?: string) => void)(msg, level);
	} catch {
		// notification must never break the command
	}
}

function applySessionNameFromEnv(pi: ExtensionAPI): void {
	try {
		const desired = (process.env.CLY_SESSION_NAME ?? process.env.CLAUDE_SESSION_NAME ?? "").trim();
		if (desired.length === 0) return;
		const api = pi as ExtensionAPI & { getSessionName?: () => string | null; setSessionName?: (n: string) => void | Promise<void> };
		const current = typeof api.getSessionName === "function" ? (api.getSessionName() ?? "").trim() : "";
		if (current === desired) return;
		void api.setSessionName?.(desired);
	} catch {
		// never block session startup
	}
}

export default function save(pi: ExtensionAPI): void {
	// Apply session name from $CLY_SESSION_NAME (set by `cly pi -n NAME`).
	pi.on("session_start", () => applySessionNameFromEnv(pi));

	pi.registerCommand("save", {
		description: 'Save the current agent session. Usage: /save [name] [description="..."]. Invokes `cly as save`. Does not forward to the agent.',
		handler: async (args: string, ctx: unknown) => {
			const cwd = cwdOf(ctx);
			const prefills = defaultPrefills(pi, ctx, cwd);
			const overrides = parseSaveArgs(args ?? "");
			const resolved: SaveArgs = {
				id: prefills.id,
				name: overrides.name ?? prefills.name,
				description: overrides.description ?? prefills.description,
			};

			// Explicit provider: cly's default comes from modules.agent_session.default_provider
			// ("omp" here), and upsert of an id it cannot auto-detect (synthetic fallback)
			// fails with "unknown provider". Both pi and omp session files resolve as "pi".
			const result = await runCly(["as", "save", resolved.id, "--provider", "pi", "--name", resolved.name, "--description", resolved.description, "--override"]);

			if (result.code === 0) {
				notify(ctx, `/save → ${resolved.name} (${resolved.id})`, "success");
			} else {
				const err = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
				notify(ctx, `/save failed: ${err}`, "error");
			}
			// Deliberately do NOT call pi.sendUserMessage — /save must not trigger the agent.
		},
	});
}
