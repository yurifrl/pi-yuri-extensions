import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * coderabbit — auto CodeRabbit review after pushing a PR branch.
 *
 * Workflow (pure code, no AI):
 *   1. Watch every bash `git push` the agent runs (tool_execution_end).
 *   2. On a successful push, check `gh pr view` for the current branch.
 *   3. If (and only if) the branch has an OPEN pull request, run
 *      `coderabbit review --agent` in the background.
 *   4. When it finishes, save the raw JSONL, count findings by severity,
 *      and notify with the summary + `/coderabbit show` to read it.
 *
 * Commands:
 *   /coderabbit            — status / last review summary
 *   /coderabbit show       — print the latest review findings
 *   /coderabbit run        — trigger a review now (ignores PR check)
 *   /coderabbit install-hook — install a git pre-push hook (terminal pushes)
 *
 * Disable: "modules": { "coderabbit": false }.
 */

// git push at command start or after a shell separator (avoids "fix push bug" false positives)
const PUSH_RE = /(^|&&|\|\||;|\||\n)\s*git\s+push\b/;
const REVIEW_TIMEOUT_MS = 20 * 60_000;
const SEVERITY_ORDER = ["critical", "major", "minor", "trivial", "info"];

export interface ReviewSummary {
	counts: Record<string, number>;
	total: number;
	findings: { severity: string; fileName?: string; comment: string }[];
}

/** Parse `coderabbit review --agent` JSONL output into severity counts + findings. */
export function parseAgentJsonl(raw: string): ReviewSummary {
	const counts: Record<string, number> = {};
	const findings: ReviewSummary["findings"] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t.startsWith("{")) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(t);
		} catch {
			continue;
		}
		if (typeof obj !== "object" || obj === null) continue;
		const rec = obj as Record<string, unknown>;
		if (rec.type !== "finding") continue;
		const sev = String(rec.severity ?? "info").toLowerCase();
		counts[sev] = (counts[sev] ?? 0) + 1;
		findings.push({
			severity: sev,
			fileName: typeof rec.fileName === "string" ? rec.fileName : undefined,
			comment:
				typeof rec.comment === "string" ? rec.comment : typeof rec.codegenInstructions === "string" ? rec.codegenInstructions : "",
		});
	}
	return { counts, total: findings.length, findings };
}

/** Human summary like "2 critical, 5 minor" (known severities first). */
export function formatCounts(counts: Record<string, number>): string {
	const known = SEVERITY_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
	const extra = Object.keys(counts)
		.filter((s) => !SEVERITY_ORDER.includes(s))
		.map((s) => `${counts[s]} ${s}`);
	const all = [...known, ...extra];
	return all.length ? all.join(", ") : "no findings";
}

function bashCommandText(args: unknown): string {
	if (typeof args === "object" && args !== null && "command" in args) {
		const cmd = args.command;
		if (typeof cmd === "string") return cmd;
	}
	return "";
}

function notify(ctx: ExtensionContext, msg: string, kind: "info" | "warning" | "error" = "info"): void {
	try {
		ctx.ui.notify(msg, kind);
	} catch {
		// UI unavailable — fall back to the console so the message isn't lost
		console.log(msg);
	}
}

function ctxCwd(ctx: ExtensionContext): string {
	return ctx.cwd || process.cwd();
}

function slug(branch: string): string {
	return branch.replace(/[^\w.-]+/g, "-");
}

function reviewDir(cwd: string): string {
	return path.join(cwd, ".pi", "coderabbit");
}

// Module state (single review at a time is plenty here).
let running = false;
let lastReviewPath: string | null = null;
let lastSummary: ReviewSummary | null = null;
const pendingPush = new Set<string>();

async function currentBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	try {
		const r = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 60_000 });
		return r.code === 0 ? r.stdout.trim() : "";
	} catch {
		return "";
	}
}

/** Pure-code decision: does the current branch have an OPEN PR? */
async function openPrNumber(pi: ExtensionAPI, cwd: string): Promise<number | null> {
	try {
		const r = await pi.exec("gh", ["pr", "view", "--json", "number,state"], { cwd, timeout: 60_000 });
		if (r.code !== 0) return null;
		const j = JSON.parse(r.stdout) as { state?: string; number?: number };
		return j.state === "OPEN" ? (j.number ?? 0) : null;
	} catch {
		return null;
	}
}

async function runReview(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string, opts: { requirePr: boolean }): Promise<void> {
	if (running) {
		notify(ctx, "CodeRabbit review already running.", "info");
		return;
	}
	// Claim the slot before any awaited work so concurrent pushes can't both pass the guard.
	running = true;
	try {
		const branch = await currentBranch(pi, cwd);
		if (opts.requirePr) {
			const pr = await openPrNumber(pi, cwd);
			if (pr === null) return; // not a PR branch — silently skip
			notify(ctx, `CodeRabbit: PR #${pr} detected on ${branch}, reviewing in background…`, "info");
		} else {
			notify(ctx, `CodeRabbit: reviewing ${branch} in background…`, "info");
		}

		const dir = reviewDir(cwd);
		await fs.mkdir(dir, { recursive: true }).catch(() => {});
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const outPath = path.join(dir, `review-${slug(branch)}-${ts}.jsonl`);

		const res = await pi
			.exec("coderabbit", ["review", "--agent", "--type", "committed"], { cwd, timeout: REVIEW_TIMEOUT_MS })
			.catch((e: unknown) => {
				notify(ctx, `CodeRabbit review failed: ${e instanceof Error ? e.message : String(e)}`, "error");
				return null;
			});
		if (!res) return;
		if (res.killed) {
			// Timed out — stdout holds a truncated partial review, not a result.
			notify(
				ctx,
				`CodeRabbit review timed out after ${Math.round(REVIEW_TIMEOUT_MS / 60_000)} min; partial output discarded.`,
				"warning",
			);
			return;
		}
		if (res.code !== 0) {
			notify(ctx, `CodeRabbit review failed: ${res.stderr || `exit ${res.code}`}`, "error");
			return;
		}

		try {
			await fs.writeFile(outPath, res.stdout, "utf8");
		} catch (e) {
			notify(ctx, `CodeRabbit review finished but could not save ${outPath}: ${e instanceof Error ? e.message : String(e)}`, "error");
			return;
		}
		lastReviewPath = outPath;
		lastSummary = parseAgentJsonl(res.stdout);

		const summary = formatCounts(lastSummary.counts);
		notify(
			ctx,
			`CodeRabbit done on ${branch}: ${summary}. Saved to ${outPath}\nRun /coderabbit show to read the findings.`,
			lastSummary.total > 0 ? "warning" : "info",
		);
	} finally {
		running = false;
	}
}

async function loadLatest(cwd: string): Promise<{ path: string; summary: ReviewSummary } | null> {
	if (lastReviewPath && lastSummary) return { path: lastReviewPath, summary: lastSummary };
	const dir = reviewDir(cwd);
	let files: string[];
	try {
		files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
	} catch {
		return null;
	}
	const latest = files.at(-1);
	if (!latest) return null;
	const p = path.join(dir, latest);
	const raw = await fs.readFile(p, "utf8").catch(() => "");
	return { path: p, summary: parseAgentJsonl(raw) };
}

async function handleShow(ctx: ExtensionContext, cwd: string): Promise<void> {
	const latest = await loadLatest(cwd);
	if (!latest) {
		notify(ctx, "No CodeRabbit reviews saved yet.", "info");
		return;
	}
	const { path: p, summary } = latest;
	const lines = [`CodeRabbit review — ${formatCounts(summary.counts)} (${p})`, ""];
	for (const f of summary.findings) {
		lines.push(`[${f.severity}] ${f.fileName ?? "?"}`);
		if (f.comment) lines.push(`  ${f.comment.split("\n")[0]}`);
	}
	if (summary.findings.length === 0) lines.push("No findings.");
	notify(ctx, lines.join("\n"), "info");
}

const HOOK_MARKER = "# toolkit-coderabbit pre-push hook";
const HOOK_BODY = `#!/bin/sh
${HOOK_MARKER}
branch=$(git rev-parse --abbrev-ref HEAD | tr '/' '-')
if gh pr view --json state 2>/dev/null | grep -q '"OPEN"'; then
  dir="$(git rev-parse --show-toplevel)/.pi/coderabbit"
  mkdir -p "$dir"
  ts=$(date +%Y%m%d-%H%M%S)
  (coderabbit review --agent --type committed > "$dir/review-$branch-$ts.jsonl" 2>/dev/null &)
fi
exit 0
`;

async function handleInstallHook(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string): Promise<void> {
	// --git-path resolves the real hooks dir (the common dir), so linked worktrees
	// — where .git is a file, not a directory — don't blow up with ENOTDIR.
	const gp = await pi.exec("git", ["rev-parse", "--git-path", "hooks/pre-push"], { cwd, timeout: 60_000 }).catch(() => null);
	if (!gp || gp.code !== 0) {
		notify(ctx, "Not a git repository.", "error");
		return;
	}
	// git prints --git-path output relative to cwd; resolve before using file APIs.
	const hookPath = path.resolve(cwd, gp.stdout.trim());
	const existing = await fs.readFile(hookPath, "utf8").catch(() => null);
	if (existing && !existing.includes(HOOK_MARKER)) {
		notify(ctx, `A different pre-push hook already exists at ${hookPath}. Not overwriting.`, "warning");
		return;
	}
	await fs.writeFile(hookPath, HOOK_BODY, { mode: 0o755 });
	notify(ctx, `Installed CodeRabbit pre-push hook at ${hookPath}`, "info");
}

export default function coderabbit(pi: ExtensionAPI): void {
	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== "bash") return;
		const cmd = bashCommandText(event.args);
		if (PUSH_RE.test(cmd)) pendingPush.add(event.toolCallId);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!pendingPush.delete(event.toolCallId)) return;
		if (event.isError) return;
		await runReview(pi, ctx, ctxCwd(ctx), { requirePr: true });
	});

	pi.registerCommand("coderabbit", {
		description: "CodeRabbit review: /coderabbit [show|run|install-hook]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const cwd = ctxCwd(ctx);
			const sub = (args ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
			switch (sub) {
				case "show":
					await handleShow(ctx, cwd);
					break;
				case "run":
					await runReview(pi, ctx, cwd, { requirePr: false });
					break;
				case "install-hook":
					await handleInstallHook(pi, ctx, cwd);
					break;
				default: {
					const summary = lastSummary ? formatCounts(lastSummary.counts) : "none yet";
					notify(
						ctx,
						`CodeRabbit\n  Last review: ${summary}${lastReviewPath ? ` (${lastReviewPath})` : ""}\n\n` +
							`  /coderabbit show          - print latest findings\n` +
							`  /coderabbit run           - review now (skips PR check)\n` +
							`  /coderabbit install-hook  - pre-push hook for terminal pushes\n\n` +
							`Auto-runs after a successful \`git push\` on an OPEN PR branch.`,
						"info",
					);
				}
			}
		},
	});
}
