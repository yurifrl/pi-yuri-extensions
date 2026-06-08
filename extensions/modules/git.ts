/**
 * git — comprehensive git slashes for pi.
 *
 * Replaces the simple git-wip.ts with multiple subcommands:
 *   /git wip        — Stage, commit, and push (equivalent to /git commit --yolo)
 *   /git status, st — Show git status
 *   /git diff       — Show staged/unstaged diff
 *   /git add        — Stage files interactively
 *   /git commit     — Commit with --yolo, --yes, --dry-run, -a flags
 *   /git push       — Push changes
 *   /git log        — Show recent commits
 *
 * All operations use native git commands (no external dependencies).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import path from "node:path";

const TIMEOUT_MS = 60_000;

interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: { path: string; status: string }[];
  unstaged: { path: string; status: string }[];
  untracked: string[];
  conflicted: string[];
  clean: boolean;
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let resolved = false;
    const finish = (v: RunResult) => {
      if (!resolved) {
        resolved = true;
        resolve(v);
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      finish({
        ok: false,
        code: null,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    let stdout = "";
    let stderr = "";

    const t = setTimeout(() => {
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    t.unref?.();

    child.stdout?.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString("utf8");
    });

    child.on("error", (e) => {
      clearTimeout(t);
      finish({
        ok: false,
        code: null,
        stdout,
        stderr: stderr || e.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(t);
      finish({
        ok: code === 0,
        code,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
      });
    });
  });
}

async function runGit(cwd: string, ...args: string[]): Promise<RunResult> {
  return runCommand("git", args, cwd);
}



function notify(
  ctx: any,
  msg: string,
  kind: "success" | "info" | "warning" | "error" = "info"
) {
  try {
    ctx?.ui?.notify?.(msg, kind);
  } catch {}
  try {
    console.log(msg);
  } catch {}
}

async function getStatus(cwd: string): Promise<GitStatus> {
  const status = await runGit(cwd, "status", "--porcelain", "-b");
  const branchInfo = await runGit(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  const upstreamInfo = await runGit(cwd, "rev-list", "--left-right", "--count", "@{u}...HEAD");

  const branch = branchInfo.stdout.trim() || "unknown";
  let ahead = 0;
  let behind = 0;

  if (upstreamInfo.ok && upstreamInfo.stdout) {
    const parts = upstreamInfo.stdout.trim().split(/\s+/);
    if (parts.length === 2) {
      behind = parseInt(parts[0] || "0", 10) || 0;
      ahead = parseInt(parts[1] || "0", 10) || 0;
    }
  }

  const staged: { path: string; status: string }[] = [];
  const unstaged: { path: string; status: string }[] = [];
  const untracked: string[] = [];
  const conflicted: string[] = [];

  if (status.stdout) {
    const lines = status.stdout.split("\n");
    for (const line of lines) {
      if (!line.trim() || line.startsWith("##")) continue;

      const index = line[0] || " ";
      const worktree = line[1] || " ";
      const file = line.slice(3).trim();

      // Conflicted
      if (index === "U" || worktree === "U" || index === "A" && worktree === "A" || index === "D" && worktree === "D") {
        conflicted.push(file);
        continue;
      }

      // Staged (index status)
      if (index !== " " && index !== "?") {
        staged.push({ path: file, status: index });
      }

      // Unstaged (worktree status)
      if (worktree !== " " && worktree !== "?") {
        unstaged.push({ path: file, status: worktree });
      }

      // Untracked
      if (index === "?" && worktree === "?") {
        untracked.push(file);
      }
    }
  }

  return {
    branch,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicted,
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0 && conflicted.length === 0,
  };
}

function formatStatus(status: GitStatus): string {
  const parts: string[] = [];
  parts.push(`On branch ${status.branch}`);

  if (status.ahead > 0 || status.behind > 0) {
    if (status.ahead > 0) parts.push(`Your branch is ahead by ${status.ahead} commit(s)`);
    if (status.behind > 0) parts.push(`Your branch is behind by ${status.behind} commit(s)`);
  }

  if (status.conflicted.length > 0) {
    parts.push("", `Conflicted files (${status.conflicted.length}):`, ...status.conflicted.map(f => `  ${f}`));
  }

  if (status.staged.length > 0) {
    parts.push("", `Changes to be committed (${status.staged.length}):`, ...status.staged.map(f => `  ${f.status} ${f.path}`));
  }

  if (status.unstaged.length > 0) {
    parts.push("", `Changes not staged (${status.unstaged.length}):`, ...status.unstaged.map(f => `  ${f.status} ${f.path}`));
  }

  if (status.untracked.length > 0) {
    parts.push("", `Untracked files (${status.untracked.length}):`, ...status.untracked.map(f => `  ${f}`));
  }

  if (status.clean) {
    parts.push("", "working tree clean");
  }

  return parts.join("\n");
}

async function handleStatus(ctx: any, cwd: string, porcelain = false) {
  if (porcelain) {
    const result = await runGit(cwd, "status", "-sb");
    if (result.ok) {
      notify(ctx, `Git status:\n${result.stdout || "(clean)"}`, "info");
    } else {
      notify(ctx, `Git status failed: ${result.stderr}`, "error");
    }
    return;
  }

  const status = await getStatus(cwd);
  notify(ctx, formatStatus(status), status.clean ? "success" : "info");
}

async function handleDiff(ctx: any, cwd: string, args: string[]) {
  const subArgs = args.length > 0 ? args : ["--staged"];
  const result = await runGit(cwd, "diff", ...subArgs);

  if (result.ok) {
    if (result.stdout) {
      // Truncate if too long
      const maxLen = 8000;
      const output = result.stdout.length > maxLen
        ? result.stdout.slice(0, maxLen) + `\n... (${result.stdout.length - maxLen} more chars)`
        : result.stdout;
      notify(ctx, `Git diff:\n${output}`, "info");
    } else {
      notify(ctx, "No diff to show", "info");
    }
  } else {
    notify(ctx, `Git diff failed: ${result.stderr}`, "error");
  }
}

async function handleAdd(ctx: any, cwd: string, args: string[]) {
  if (args.length === 0) {
    // Interactive mode: show status and ask
    const status = await getStatus(cwd);
    const filesToAdd: string[] = [];

    // Add all unstaged and untracked by default in non-interactive context
    filesToAdd.push(...status.unstaged.map(f => f.path));
    filesToAdd.push(...status.untracked);

    if (filesToAdd.length === 0) {
      notify(ctx, "No files to add", "info");
      return;
    }

    notify(ctx, `Adding ${filesToAdd.length} file(s)...`, "info");
    const result = await runGit(cwd, "add", ...filesToAdd);

    if (result.ok) {
      notify(ctx, `Added ${filesToAdd.length} file(s)`, "success");
    } else {
      notify(ctx, `Git add failed: ${result.stderr}`, "error");
    }
    return;
  }

  // Add specific files
  const result = await runGit(cwd, "add", ...args);
  if (result.ok) {
    notify(ctx, `Added: ${args.join(", ")}`, "success");
  } else {
    notify(ctx, `Git add failed: ${result.stderr}`, "error");
  }
}

async function handleCommit(ctx: any, cwd: string, args: string[]) {
  const useYolo = args.includes("--yolo");
  const useYes = args.includes("--yes") || args.includes("-y");
  const dryRun = args.includes("--dry-run") || args.includes("-d");
  const commitAll = args.includes("-a");

  // For yolo mode: stage all, commit, push
  if (useYolo) {
    // Stage all changes first
    const addResult = await runGit(cwd, "add", "-A");
    if (!addResult.ok) {
      notify(ctx, `❌ Failed to stage changes: ${addResult.stderr}`, "error");
      return;
    }

    // Check if there's anything to commit
    const status = await getStatus(cwd);
    if (dryRun) {
      notify(ctx, `Dry run - would commit ${status.staged.length} staged file(s)`, "info");
      return;
    }

    if (status.staged.length === 0) {
      notify(ctx, "Nothing to commit - working tree clean", "info");
      return;
    }

    // Commit
    const commitMsg = `wip :zap:`;
    const commitResult = await runGit(cwd, "commit", "-m", commitMsg);
    if (!commitResult.ok) {
      notify(ctx, `❌ Commit failed: ${commitResult.stderr}`, "error");
      return;
    }

    // Push
    const pushResult = await runGit(cwd, "push");
    if (pushResult.ok) {
      notify(ctx, `✅ WIP committed and pushed`, "success");
    } else {
      notify(ctx, `✅ Committed, but push failed: ${pushResult.stderr}`, "warning");
    }
    return;
  }

  // Normal commit flow
  if (commitAll) {
    // Stage all changes
    const addResult = await runGit(cwd, "add", "-A");
    if (!addResult.ok) {
      notify(ctx, `❌ Failed to stage changes: ${addResult.stderr}`, "error");
      return;
    }
  }

  // Check if we have staged changes
  const status = await getStatus(cwd);
  if (status.staged.length === 0) {
    notify(ctx, "No staged changes to commit. Run /git add first or use /git commit -a", "warning");
    return;
  }

  if (dryRun) {
    const diff = await runGit(cwd, "diff", "--cached");
    notify(ctx, `Dry run - would commit ${status.staged.length} file(s):\n${diff.stdout || "(no diff)"}`, "info");
    return;
  }

  // Simple commit with default message
  const commitMsg = `wip :zap:`;
  const result = await runGit(cwd, "commit", "-m", commitMsg);

  if (result.ok) {
    notify(ctx, `✅ Committed: ${commitMsg}`, "success");
  } else {
    notify(ctx, `❌ Commit failed: ${result.stderr}`, "error");
  }
}

async function handlePush(ctx: any, cwd: string, args: string[]) {
  const pushArgs = ["push"];
  if (args.includes("--force")) pushArgs.push("--force-with-lease");

  notify(ctx, "Pushing changes...", "info");
  const result = await runGit(cwd, ...pushArgs);

  if (result.ok) {
    notify(ctx, "Push successful", "success");
  } else {
    notify(ctx, `Push failed: ${result.stderr || result.stdout}`, "error");
  }
}

async function handleLog(ctx: any, cwd: string, args: string[]) {
  const count = parseInt(args[0], 10) || 10;
  const result = await runGit(cwd, "log", `--${args.includes("--oneline") ? "oneline" : "format=%h %s (%cr)"}`, "-n", String(count));

  if (result.ok) {
    notify(ctx, `Recent commits:\n${result.stdout || "(no commits)"}`, "info");
  } else {
    notify(ctx, `Git log failed: ${result.stderr}`, "error");
  }
}

async function handleWip(ctx: any, cwd: string) {
  // /git wip is just /git commit --yolo
  await handleCommit(ctx, cwd, ["--yolo"]);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("git", {
    description:
      "Git commands: /git wip (stage, commit, push), /git status|st, /git diff, /git add [files], /git commit [--yolo|--yes|--dry-run], /git push, /git log [n]",
    getArgumentCompletions: () => [
      {
        value: "wip",
        label: "wip",
        description: "Quick commit and push (stage all, commit, push)",
      },
      {
        value: "status",
        label: "status",
        description: "Show git status summary",
      },
      {
        value: "st",
        label: "st",
        description: "Alias for status",
      },
      {
        value: "diff",
        label: "diff",
        description: "Show diff (staged by default)",
      },
      {
        value: "add",
        label: "add",
        description: "Stage files (all if no args, or specific files)",
      },
      {
        value: "commit",
        label: "commit",
        description: "Commit with AI split. Use --yolo to skip prompts, --dry-run to preview",
      },
      {
        value: "push",
        label: "push",
        description: "Push to remote",
      },
      {
        value: "log",
        label: "log",
        description: "Show recent commits (default: 10)",
      },
    ],
    handler: async (args, ctx) => {
      const cwd =
        typeof ctx.cwd === "function" ? ctx.cwd() : ctx.cwd ?? process.cwd();
      const rawArgs = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const subcommand = (rawArgs[0] ?? "").toLowerCase();
      const subArgs = rawArgs.slice(1);

      switch (subcommand) {
        case "wip":
          await handleWip(ctx, cwd);
          break;
        case "status":
        case "s":
          await handleStatus(ctx, cwd, subArgs.includes("--porcelain"));
          break;
        case "diff":
          await handleDiff(ctx, cwd, subArgs);
          break;
        case "add":
          await handleAdd(ctx, cwd, subArgs);
          break;
        case "commit":
        case "c":
          await handleCommit(ctx, cwd, subArgs);
          break;
        case "push":
          await handlePush(ctx, cwd, subArgs);
          break;
        case "log":
        case "l":
          await handleLog(ctx, cwd, subArgs);
          break;
        default:
          // No subcommand - show usage
          notify(
            ctx,
            `Git commands:\n` +
              `  /git wip          - Quick commit + push (stage all, commit, push)\n` +
              `  /git status, s    - Show current status\n` +
              `  /git diff [args]  - Show diff (--staged by default)\n` +
              `  /git add [files]  - Stage files (all if none specified)\n` +
              `  /git commit, c    - Commit staged changes\n` +
              `                      --yolo: stage, commit, push\n` +
              `                      --yes/-y: auto-confirm\n` +
              `                      --dry-run/-d: preview only\n` +
              `                      -a: stage all before commit\n` +
              `  /git push         - Push to remote\n` +
              `  /git log, l [n]   - Show last n commits (default 10)`,
            "info"
          );
      }
    },
  });
}
