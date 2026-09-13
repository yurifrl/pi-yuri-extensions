/**
 * Comments Watch — pull diff-review comments from cmux's diff viewer and Hunk's live
 * sessions into the current OMP session.
 *
 * Sources (both read-only, toggleable via module config `sources`):
 * - cmux: comments persist at
 *   `~/Library/Application Support/cmux/diff-comments/<sha256(canonical repoRoot)[0:24]>.json`
 *   (no comments CLI/events on cmux 0.64.x — we read the store directly).
 * - hunk: `hunk session comment list --repo <root> --json` against the live daemon.
 *
 * /comments-watch [on|off|status] [filter] — toggle a poller that submits new comments for
 *   the session repo into this session as a followUp message. Optional filter: a regex
 *   matched against comment file paths, or a comma-separated file list (exact or
 *   path-suffix match). No filter = all comments for the repo.
 * /comments-sync [--all] [filter] — one-shot: submit new comments now (current repo, or
 *   every repo that has a store when `--all`), with the same optional filter.
 *
 * Both keep a per-session, per-repo "sent" pointer (seen comment ids per source) so a
 * comment is submitted exactly once. Comments excluded by the filter stay unsent and are
 * reconsidered on the next poll/sync. LLM-facing tools (diff_pending, diff_all,
 * diff_cmux_all, diff_hunk_all, diff_get, diff_mark_sent) expose the same data without
 * advancing pointers unless the model calls diff_mark_sent.
 *
 * Disable: "modules": { "comments-watch": { "enabled": false } }.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readSharedConfig } from "../../modules/config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiffComment {
	id: string;
	source: "cmux" | "hunk";
	repoRoot: string;
	filePath: string;
	startLine: number | null;
	endLine: number | null;
	side: string | null;
	message: string;
	lineText: string | null;
	/** cmux-only: full diff-context blob the comment was written against. */
	submissionText?: string;
	createdAt: string | null;
	/** cmux-only: set once the comment was delivered to an agent via cmux's TextBox. */
	consumedAt?: string | null;
	author?: string | null;
	/** Present on diff_all output: whether this session already submitted the comment. */
	sent?: boolean;
}

interface SentPointers {
	cmux: string[];
	hunk: string[];
}

/** repoRoot (canonical) -> per-source seen comment ids. */
type WatchState = Record<string, SentPointers>;

interface SourceFlags {
	cmux: boolean;
	hunk: boolean;
}

interface HunkListRow {
	id?: string;
	filePath?: string;
	file?: string;
	newLine?: number;
	oldLine?: number;
	startLine?: number;
	endLine?: number;
	summary?: string;
	message?: string;
	body?: string;
	author?: string;
	createdAt?: string;
}

/** omp-only agent-dir accessor; pi (non-omp) builds never reach this module. */
const ompAgentDir = (pi: ExtensionAPI): string | undefined =>
	(pi as unknown as { pi?: { settings?: { getAgentDir?: () => string } } }).pi?.settings?.getAgentDir?.();

const POLL_MS = 2_000;
const CMUX_STORE_DIR = join(homedir(), "Library", "Application Support", "cmux", "diff-comments");

// ---------------------------------------------------------------------------
// cmux store reader
// ---------------------------------------------------------------------------

/** Canonicalize a repo root the way cmux's DiffCommentStore does: standardize + realpath. */
function canonicalRepoRoot(raw: string): string {
	try {
		return realpathSync.native(raw);
	} catch {
		return raw.replace(/\/+$/, "");
	}
}

/** cmux store file for a repo root. Key = first 24 hex of sha256(canonical root). */
function cmuxStoreFile(repoRoot: string): string {
	const canonical = canonicalRepoRoot(repoRoot);
	const key = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
	return join(CMUX_STORE_DIR, `${key}.json`);
}

function parseCmuxComment(raw: Record<string, unknown>, repoRoot: string): DiffComment {
	return {
		id: `cmux:${String(raw.id ?? "")}`,
		source: "cmux",
		repoRoot,
		filePath: String(raw.filePath ?? ""),
		startLine: typeof raw.startLine === "number" ? raw.startLine : null,
		endLine: typeof raw.endLine === "number" ? raw.endLine : null,
		side: typeof raw.side === "string" ? raw.side : null,
		message: String(raw.message ?? ""),
		lineText: typeof raw.lineText === "string" ? raw.lineText : null,
		submissionText: typeof raw.submissionText === "string" ? raw.submissionText : undefined,
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
		consumedAt: typeof raw.consumedAt === "string" ? raw.consumedAt : null,
		author: null,
	};
}

function readCmuxComments(repoRoot: string): DiffComment[] {
	const file = cmuxStoreFile(repoRoot);
	if (!existsSync(file)) return [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null || !("comments" in parsed)) return [];
		const { comments, repoRoot: storedRoot } = parsed as { comments?: unknown; repoRoot?: unknown };
		if (!Array.isArray(comments)) return [];
		const root = typeof storedRoot === "string" ? storedRoot : repoRoot;
		return comments.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null).map((c) => parseCmuxComment(c, root));
	} catch {
		return [];
	}
}

/** Every repo root that has a cmux comment store on disk (read from each store's repoRoot field). */
function cmuxReposWithStores(): string[] {
	if (!existsSync(CMUX_STORE_DIR)) return [];
	const roots: string[] = [];
	try {
		for (const file of readdirSync(CMUX_STORE_DIR).filter((f) => f.endsWith(".json"))) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(join(CMUX_STORE_DIR, file), "utf8"));
				if (typeof parsed === "object" && parsed !== null && "repoRoot" in parsed) {
					const { repoRoot } = parsed as { repoRoot?: unknown };
					if (typeof repoRoot === "string") roots.push(repoRoot);
				}
			} catch {
				// unreadable store file — skip
			}
		}
	} catch {
		// store dir vanished between existsSync and readdirSync
	}
	return roots;
}

// ---------------------------------------------------------------------------
// hunk reader
// ---------------------------------------------------------------------------

function parseHunkRow(row: HunkListRow, index: number, repoRoot: string): DiffComment {
	const filePath = row.filePath ?? row.file ?? "";
	const newLine = typeof row.newLine === "number" ? row.newLine : typeof row.startLine === "number" ? row.startLine : null;
	const oldLine = typeof row.oldLine === "number" ? row.oldLine : null;
	return {
		id: `hunk:${row.id ?? `idx-${index}`}`,
		source: "hunk",
		repoRoot,
		filePath,
		startLine: newLine ?? oldLine,
		endLine: typeof row.endLine === "number" ? row.endLine : null,
		side: newLine != null ? "additions" : oldLine != null ? "deletions" : null,
		message: row.summary ?? row.message ?? row.body ?? "",
		lineText: null,
		createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
		consumedAt: null,
		author: typeof row.author === "string" ? row.author : null,
	};
}

async function readHunkComments(pi: ExtensionAPI, repoRoot: string): Promise<DiffComment[]> {
	let result;
	try {
		result = await pi.exec("hunk", ["session", "comment", "list", "--repo", repoRoot, "--json"], {
			cwd: repoRoot,
			timeout: 10_000,
		});
	} catch {
		return []; // daemon down — not an error
	}
	if (result.code !== 0) return [];
	const stdout = result.stdout.trim();
	if (!stdout) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	const rows: unknown[] = Array.isArray(parsed)
		? parsed
		: typeof parsed === "object" && parsed !== null && "comments" in parsed && Array.isArray((parsed as { comments?: unknown[] }).comments)
			? ((parsed as { comments: unknown[] }).comments satisfies unknown[] as unknown[])
			: [];
	return rows
		.filter((r): r is HunkListRow => typeof r === "object" && r !== null)
		.map((row, i) => parseHunkRow(row, i, repoRoot));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatComments(comments: DiffComment[]): string {
	if (comments.length === 0) return "";
	const byRepo = new Map<string, DiffComment[]>();
	for (const c of comments) {
		const list = byRepo.get(c.repoRoot) ?? [];
		list.push(c);
		byRepo.set(c.repoRoot, list);
	}
	const parts: string[] = [`Diff review comments (${comments.length}):`];
	for (const [repo, list] of byRepo) {
		parts.push("", `## ${repo}`);
		for (const c of list) {
			const loc = `${c.filePath}${c.startLine != null ? `:${c.startLine}` : ""}`;
			const flags = `${c.side ? ` [${c.side}]` : ""}${c.source === "hunk" ? " (hunk)" : ""}`;
			parts.push(`- ${loc}${flags}: ${c.message.trim()}`);
			if (c.lineText) parts.push(`  > ${c.lineText.trim()}`);
		}
	}
	parts.push("", "(diff_get with an id for full diff context; diff_mark_sent to consume.)");
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Optional comment filter. A regex is matched against the comment's file path; a
 * comma-separated value is a file list matched exactly or by path suffix (`foo.ts`
 * matches `src/foo.ts`). No filter = every comment for the repo.
 */
export interface CommentFilter {
	describe: string;
	test: (filePath: string) => boolean;
}

export function parseFilter(raw: string | undefined): CommentFilter | undefined {
	const text = raw?.trim();
	if (!text) return undefined;
	if (text.includes(",")) {
		const files = text.split(",").map((f) => f.trim()).filter(Boolean);
		return {
			describe: files.join(", "),
			test: (filePath) => files.some((f) => filePath === f || filePath.endsWith(`/${f}`)),
		};
	}
	let re: RegExp;
	try {
		re = new RegExp(text);
	} catch {
		throw new Error(`invalid filter regex: ${text}`);
	}
	return { describe: `/${text}/`, test: (filePath) => re.test(filePath) };
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export default function commentsWatch(pi: ExtensionAPI): void {
	const agentDir = ompAgentDir(pi);
	const stateDir = agentDir ? join(agentDir, "comments-watch") : join(homedir(), ".config", "pi-yuri-extensions", "comments-watch");
	// One-time migration: sent-pointer files used to live under "diff-watch/".
	const legacyStateDir = agentDir ? join(agentDir, "diff-watch") : join(homedir(), ".config", "pi-yuri-extensions", "diff-watch");
	if (!existsSync(stateDir) && existsSync(legacyStateDir)) {
		try {
			renameSync(legacyStateDir, stateDir);
		} catch {
			// stale pointers are harmless — a session would re-submit old comments once
		}
	}

	const moduleCfg = readSharedConfig().modules?.["comments-watch"];
	const sources: SourceFlags = {
		cmux: moduleCfg?.sources?.cmux ?? true,
		hunk: moduleCfg?.sources?.hunk ?? true,
	};

	let sessionKey: string | undefined;
	let state: WatchState = {};
	let generation = 0;
	let watching = false;
	let pollTimer: ReturnType<ExtensionContext["setTimeout"]> | undefined;
	let pollCtx: ExtensionContext | undefined;
	let watchedRepo: string | undefined;
	let watchFilter: CommentFilter | undefined;

	// ---- pointer persistence: one file per session, all repos in one object ----
	const stateFile = () => (sessionKey ? join(stateDir, `${sessionKey.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`) : undefined);

	const load = () => {
		state = {};
		const file = stateFile();
		if (!file || !existsSync(file)) return;
		try {
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (typeof parsed !== "object" || parsed === null) return;
			for (const [repo, value] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof value !== "object" || value === null) continue;
				const v = value as Partial<SentPointers>;
				state[repo] = {
					cmux: Array.isArray(v.cmux) ? v.cmux.filter((x): x is string => typeof x === "string") : [],
					hunk: Array.isArray(v.hunk) ? v.hunk.filter((x): x is string => typeof x === "string") : [],
				};
			}
		} catch {
			// ignore corrupt state
		}
	};

	const save = () => {
		const file = stateFile();
		if (!file) return;
		try {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, JSON.stringify(state), "utf8");
		} catch {
			// best effort
		}
	};

	const pointersFor = (repoRoot: string): SentPointers => (state[canonicalRepoRoot(repoRoot)] ??= { cmux: [], hunk: [] });

	const markSent = (repoRoot: string, comments: DiffComment[]) => {
		if (comments.length === 0) return;
		const pointers = pointersFor(repoRoot);
		for (const c of comments) {
			const bucket = c.source === "hunk" ? pointers.hunk : pointers.cmux;
			if (!bucket.includes(c.id)) bucket.push(c.id);
		}
		save();
	};

	const repoRootFor = async (ctx: ExtensionContext, dir?: string): Promise<string | undefined> => {
		const start = dir ?? ctx.cwd;
		const result = await pi.exec("git", ["-C", start, "rev-parse", "--show-toplevel"], { cwd: start, timeout: 5_000 });
		const root = result.stdout.trim();
		return result.code === 0 && root ? root : undefined;
	};

	const readSource = (source: "cmux" | "hunk", repoRoot: string): Promise<DiffComment[]> | DiffComment[] =>
		source === "cmux" ? readCmuxComments(repoRoot) : readHunkComments(pi, repoRoot);

	/** Comments from enabled sources not yet marked sent for this session, optionally filtered. */
	const collectNew = async (repoRoot: string, filter?: CommentFilter): Promise<DiffComment[]> => {
		const pointers = pointersFor(repoRoot);
		const fresh: DiffComment[] = [];
		for (const source of ["cmux", "hunk"] as const) {
			if (!sources[source]) continue;
			const bucket = source === "hunk" ? pointers.hunk : pointers.cmux;
			for (const c of await readSource(source, repoRoot)) {
				if (!bucket.includes(c.id) && (!filter || filter.test(c.filePath))) fresh.push(c);
			}
		}
		return fresh;
	};

	const reposForScope = async (ctx: ExtensionContext, scope: "repo" | "all", repo?: string): Promise<string[]> => {
		if (scope === "repo") return [canonicalRepoRoot(repo ?? (await resolveRepoOrThrow(ctx)))];
		const roots = new Set(cmuxReposWithStores().map(canonicalRepoRoot));
		if (repo) roots.add(canonicalRepoRoot(repo));
		else {
			const cwdRepo = await repoRootFor(ctx);
			if (cwdRepo) roots.add(canonicalRepoRoot(cwdRepo));
		}
		return [...roots];
	};

	const resolveRepoOrThrow = async (ctx: ExtensionContext, repo?: string): Promise<string> => {
		if (repo) return canonicalRepoRoot(repo);
		const root = await repoRootFor(ctx);
		if (!root) throw new Error("Not inside a git repository; pass an explicit repo path");
		return canonicalRepoRoot(root);
	};

	// ---- submit ----
	const submit = async (ctx: ExtensionContext, scope: "repo" | "all", filter?: CommentFilter): Promise<number> => {
		const repos = await reposForScope(ctx, scope);
		const allFresh: DiffComment[] = [];
		for (const repo of repos) {
			const fresh = await collectNew(repo, filter);
			allFresh.push(...fresh);
			markSent(repo, fresh);
		}
		const filterNote = filter ? ` (filter: ${filter.describe})` : "";
		if (allFresh.length === 0) {
			ctx.ui.notify(`comments-sync: no new comments${filterNote}`, "info");
			return 0;
		}
		pi.sendUserMessage(formatComments(allFresh), { deliverAs: "followUp" });
		ctx.ui.notify(`comments-sync: submitted ${allFresh.length} comment${allFresh.length === 1 ? "" : "s"}${filterNote}`, "info");
		return allFresh.length;
	};

	// ---- widget ----
	const refreshWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!watching) {
			ctx.ui.setWidget("yuri-comments-watch", undefined);
			return;
		}
		ctx.ui.setWidget("yuri-comments-watch", (_tui, theme: Theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const repoShort = watchedRepo?.split("/").slice(-2).join("/") ?? "";
				const srcs = [sources.cmux ? "cmux" : "", sources.hunk ? "hunk" : ""].filter(Boolean).join("+");
				const filter = watchFilter ? ` · ${watchFilter.describe}` : "";
				const text = ` ◉ comments-watch ${srcs}${filter} · ${repoShort}`;
				return [theme.fg("accent", text.length > width ? `${text.slice(0, Math.max(width - 1, 1))}…` : text)];
			},
		}));
	};

	// ---- poller ----
	const stopWatch = (ctx?: ExtensionContext) => {
		watching = false;
		watchFilter = undefined;
		if (pollTimer) {
			(pollCtx ?? ctx)?.clearTimer(pollTimer);
			pollTimer = undefined;
		}
		ctx?.ui.setWidget("yuri-comments-watch", undefined);
	};

	const tick = async (ctx: ExtensionContext, atGeneration: number) => {
		if (!watching || atGeneration !== generation) return;
		try {
			if (watchedRepo) {
				const fresh = await collectNew(watchedRepo, watchFilter);
				if (fresh.length > 0) {
					markSent(watchedRepo, fresh);
					pi.sendUserMessage(formatComments(fresh), { deliverAs: "followUp" });
				}
			}
		} catch {
			// keep polling through transient errors
		}
		if (watching && atGeneration === generation) pollTimer = ctx.setTimeout(() => void tick(ctx, atGeneration), POLL_MS);
	};

	const startWatch = async (ctx: ExtensionContext, filter?: CommentFilter) => {
		const repo = await repoRootFor(ctx);
		if (!repo) {
			ctx.ui.notify("comments-watch: not inside a git repository", "error");
			return;
		}
		watchedRepo = canonicalRepoRoot(repo);
		watchFilter = filter;
		pollCtx = ctx;
		watching = true;
		generation++;
		refreshWidget(ctx);
		pollTimer = ctx.setTimeout(() => void tick(ctx, generation), POLL_MS);
		ctx.ui.notify(`comments-watch: on — polling ${watchedRepo} every ${POLL_MS / 1000}s${filter ? ` (filter: ${filter.describe})` : ""}`, "info");
	};

	const handleWatch = async (args: string | undefined, ctx: ExtensionContext) => {
		const input = (args ?? "").trim();
		const match = input.match(/^(on|off|status)\b\s*(.*)$/);
		const verb = match ? match[1] : input ? "on" : "";
		const filterRaw = (match ? match[2] : input).trim();
		if (verb === "off" || (input === "" && watching)) {
			stopWatch(ctx);
			ctx.ui.notify("comments-watch: off", "info");
			return;
		}
		if (verb === "status") {
			const repo = watchedRepo ?? (await repoRootFor(ctx));
			const filterNote = watching && watchFilter ? ` — filter: ${watchFilter.describe}` : "";
			ctx.ui.notify(watching ? `comments-watch: on (${repo ?? "?"})${filterNote}` : `comments-watch: off${repo ? ` — repo ${repo}` : ""}`, "info");
			return;
		}
		// "" / "on [filter]" / bare filter: start the watcher, or update its filter live.
		let filter: CommentFilter | undefined;
		try {
			filter = parseFilter(filterRaw);
		} catch (error) {
			ctx.ui.notify(`comments-watch: ${(error as Error).message}`, "error");
			return;
		}
		if (watching) {
			watchFilter = filter;
			refreshWidget(ctx);
			ctx.ui.notify(`comments-watch: filter ${filter ? filter.describe : "cleared"}`, "info");
			return;
		}
		await startWatch(ctx, filter);
	};

	const handleSync = async (args: string | undefined, ctx: ExtensionContext) => {
		const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
		const scope = tokens.includes("--all") ? "all" : "repo";
		let filter: CommentFilter | undefined;
		try {
			filter = parseFilter(tokens.filter((t) => t !== "--all").join(" "));
		} catch (error) {
			ctx.ui.notify(`comments-sync: ${(error as Error).message}`, "error");
			return;
		}
		if (scope === "repo" && !(await repoRootFor(ctx))) {
			ctx.ui.notify("comments-sync: not inside a git repository (use /comments-sync --all)", "error");
			return;
		}
		await submit(ctx, scope, filter);
	};

	// ---- session lifecycle ----
	const rekey = (ctx: ExtensionContext) => {
		generation++;
		stopWatch();
		const file = ctx.sessionManager.getSessionFile();
		const key = file ?? ctx.sessionManager.getSessionId() ?? undefined;
		if (key === sessionKey) return;
		sessionKey = key;
		load();
	};

	pi.on("session_start", (_event, ctx) => rekey(ctx));
	// omp-only events (re-key on /new, /resume, fork, handoff); widened so registration
	// typechecks against pi's narrower event map — same pattern as later.ts.
	const ompEvents = pi as unknown as { on(event: string, handler: (event: never, ctx: ExtensionContext) => void): void };
	for (const event of ["session_switch", "session_branch"]) {
		ompEvents.on(event, (_event, ctx) => rekey(ctx));
	}
	pi.on("session_shutdown", () => stopWatch());

	// ---- commands ----
	pi.registerCommand("comments-watch", {
		description:
			"Watch cmux/Hunk review comments for this repo; submit new ones here (on|off|status [filter]). Filter: regex on file path or comma-separated file list; no filter = all comments.",
		handler: handleWatch,
	});
	pi.registerCommand("comments-sync", {
		description:
			"Submit new cmux/Hunk review comments into this session now (--all for every repo; optional filter). Filter: regex on file path or comma-separated file list; no filter = all comments.",
		handler: handleSync,
	});
	// ---- tools (LLM surface) ----
	const z = pi.zod;
	const pendingSchema = z.object({ repo: z.string().optional().describe("Repo root path; defaults to the session cwd's git root") });
	const allSchema = z.object({
		repo: z.string().optional().describe("Repo root path; defaults to the session cwd's git root"),
		scope: z.enum(["repo", "all"]).optional().describe("repo (default) = current repo; all = every repo with a store"),
		includeConsumed: z.boolean().optional().describe("Exclude cmux comments already delivered via cmux TextBox (default: include)"),
	});
	const cmuxAllSchema = z.object({
		repo: z.string().optional().describe("Repo root path; defaults to the session cwd's git root"),
		scope: z.enum(["repo", "all"]).optional().describe("repo (default) = current repo; all = every repo with a store"),
	});
	const hunkAllSchema = pendingSchema;
	const getSchema = z.object({
		repo: z.string().optional().describe("Repo root path; defaults to the session cwd's git root"),
		scope: z.enum(["repo", "all"]).optional().describe("repo (default) = current repo; all = every repo with a store"),
		ids: z.array(z.string().describe("Comment id (cmux:<uuid> or hunk:<id>)")).min(1).describe("Comment ids to fetch"),
	});
	const markSentSchema = z.object({
		repo: z.string().optional().describe("Repo root path; defaults to the session cwd's git root"),
		ids: z.array(z.string().describe("Comment id (cmux:<uuid> or hunk:<id>)")).optional().describe("Comment ids to mark sent"),
		all: z.boolean().optional().describe("Mark every stored comment for the repo as sent"),
	});
	type PendingParams = typeof pendingSchema._output;
	type AllParams = typeof allSchema._output;
	type GetParams = typeof getSchema._output;
	type MarkSentParams = typeof markSentSchema._output;
	const toResult = (comments: DiffComment[], note: string) => ({
		content: [{ type: "text" as const, text: note + (formatComments(comments) || "No comments.") }],
		details: { count: comments.length, comments },
	});

	pi.registerTool({
		name: "diff_pending",
		label: "Diff Pending Comments",
		description:
			"List NEW (not yet submitted) diff-review comments for the current repo from cmux's diff viewer and live Hunk sessions. Read-only: does not advance the sent pointer. Use diff_mark_sent to consume.",
		parameters: pendingSchema,
		async execute(_id, params: PendingParams, _signal, _onUpdate, ctx) {
			const repo = await resolveRepoOrThrow(ctx, params.repo);
			const fresh = await collectNew(repo);
			return toResult(fresh, `${fresh.length} pending comment(s) in ${repo}.`);
		},
	});

	pi.registerTool({
		name: "diff_all",
		label: "All Diff Comments",
		description:
			"List every stored diff-review comment for a repo (or all repos with scope:'all'), from cmux's diff viewer and live Hunk sessions, annotated sent: true|false relative to this session's pointer.",
		parameters: allSchema,
		async execute(_id, params: AllParams, _signal, _onUpdate, ctx) {
			const repos = await reposForScope(ctx, params.scope ?? "repo", params.repo);
			const excludeConsumed = params.includeConsumed === false;
			const out: DiffComment[] = [];
			for (const repo of repos) {
				const pointers = pointersFor(repo);
				for (const source of ["cmux", "hunk"] as const) {
					if (!sources[source]) continue;
					for (const c of await readSource(source, repo)) {
						if (excludeConsumed && c.consumedAt) continue;
						const bucket = source === "hunk" ? pointers.hunk : pointers.cmux;
						out.push({ ...c, sent: bucket.includes(c.id) });
					}
				}
			}
			return toResult(out, `${out.length} comment(s) across ${repos.length} repo(s).`);
		},
	});

	pi.registerTool({
		name: "diff_cmux_all",
		label: "All cmux Diff Comments",
		description: "Raw dump of every comment stored by cmux's diff viewer (files under ~/Library/Application Support/cmux/diff-comments/). scope:'all' reads every repo's store.",
		parameters: cmuxAllSchema,
		async execute(_id, params: AllParams, _signal, _onUpdate, ctx) {
			const repos = await reposForScope(ctx, params.scope ?? "repo", params.repo);
			const out = repos.flatMap((repo) => readCmuxComments(repo));
			return toResult(out, `${out.length} cmux comment(s).`);
		},
	});

	pi.registerTool({
		name: "diff_hunk_all",
		label: "All Hunk Comments",
		description: "Every comment from live Hunk review sessions matching the repo (hunk session comment list --json). Empty when no Hunk session is running.",
		parameters: hunkAllSchema,
		async execute(_id, params: PendingParams, _signal, _onUpdate, ctx) {
			const repo = await resolveRepoOrThrow(ctx, params.repo);
			const out = await readHunkComments(pi, repo);
			return toResult(out, `${out.length} hunk comment(s) in ${repo}.`);
		},
	});

	pi.registerTool({
		name: "diff_get",
		label: "Get Diff Comments By Id",
		description: "Fetch full diff-review comment records (including cmux submissionText diff context) by id. Ids come from diff_pending/diff_all ('cmux:<uuid>' or 'hunk:<id>').",
		parameters: getSchema,
		async execute(_id, params: GetParams, _signal, _onUpdate, ctx) {
			const wanted = new Set(params.ids);
			const repos = await reposForScope(ctx, params.scope ?? "repo", params.repo);
			const found: DiffComment[] = [];
			for (const repo of repos) {
				for (const source of ["cmux", "hunk"] as const) {
					if (!sources[source]) continue;
					for (const c of await readSource(source, repo)) {
						if (wanted.has(c.id) && !found.some((f) => f.id === c.id)) found.push(c);
					}
				}
			}
			const missing = [...wanted].filter((id) => !found.some((f) => f.id === id));
			return toResult(found, `${found.length}/${params.ids.length} found${missing.length ? `; missing: ${missing.join(", ")}` : ""}.`);
		},
	});

	pi.registerTool({
		name: "diff_mark_sent",
		label: "Mark Diff Comments Sent",
		description: "Advance the sent pointer: mark diff-review comments as submitted for this session so diff_pending and /comments-watch stop re-reporting them. Pass ids, or all:true to consume everything stored for the repo.",
		parameters: markSentSchema,
		async execute(_id, params: MarkSentParams, _signal, _onUpdate, ctx) {
			const repo = await resolveRepoOrThrow(ctx, params.repo);
			if (params.all) {
				const everything: DiffComment[] = [];
				for (const source of ["cmux", "hunk"] as const) {
					if (!sources[source]) continue;
					everything.push(...(await readSource(source, repo)));
				}
				markSent(repo, everything);
				return toResult([], `marked ${everything.length} comment(s) sent in ${repo}.`);
			}
			if (!params.ids?.length) throw new Error("Pass ids or all:true");
			const wanted = new Set(params.ids);
			const matches: DiffComment[] = [];
			for (const source of ["cmux", "hunk"] as const) {
				if (!sources[source]) continue;
				for (const c of await readSource(source, repo)) if (wanted.has(c.id)) matches.push(c);
			}
			markSent(repo, matches);
			const missing = [...wanted].filter((id) => !matches.some((m) => m.id === id));
			return toResult([], `marked ${matches.length} sent${missing.length ? `; not found: ${missing.join(", ")}` : ""}.`);
		},
	});
}
