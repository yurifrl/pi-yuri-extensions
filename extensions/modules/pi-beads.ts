/**
 * pi-beads — beads (`bd`) integration for pi.
 *
 * Behaviour:
 *   - Runs `bd prime` on session_start and session_before_compact and injects
 *     the output into the conversation (mirrors the Claude Code hook).
 *   - Provides a `/beads` slash command with subcommands:
 *
 *       /beads hook on|off|status        Toggle the bd-prime hook globally
 *       /beads create                    Open an in-process form overlay (pi-tui)
 *       /beads list [args...]            Run `bd list` and inject the output
 *       /beads ready                     Run `bd ready` and inject the output
 *       /beads show <id>                 Run `bd show <id>` and inject the output
 *       /beads close <id> [reason]       Run `bd close` and inject the output
 *       /beads update <id> <args...>     Run `bd update` and inject the output
 *       /beads <anything>                Pass-through: runs `bd <anything>`
 *
 *   - All handlers return IMMEDIATELY (fire-and-forget). The chat is never
 *     blocked waiting for `bd` to finish; results are delivered later via
 *     `pi.sendUserMessage(..., { deliverAs: "followUp" })` or `ui.notify`.
 *
 * Toggle config (hook only — extension itself stays loaded):
 *   - Global: ~/.pi/agent/extensions/pi-extensions.json  → "pi-beads".hook = true|false
 *   - Loader gate (separate): "extensions"."pi-beads" controls whether the
 *     module is loaded at all by the pi-extensions hub. Don't toggle that
 *     from /beads — turning it off would also kill the /beads command.
 *
 * Skips priming silently when:
 *   - `bd` is not on PATH
 *   - cwd has no `.beads/` directory walking up 8 parents
 *   - in-memory `disabled` flag is set (set by `/beads hook off` for current session)
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  Editor,
  Key,
  matchesKey,
  truncateToWidth,
  type EditorTheme,
} from "@earendil-works/pi-tui";

const EXEC_TIMEOUT_MS = 8_000;
const BD_RUN_TIMEOUT_MS = 30_000;
const GLOBAL_TOGGLE_PATH = join(homedir(), ".pi", "agent", "extensions", "pi-extensions.json");

// In-memory override so `/beads hook off` takes effect immediately. Initialised
// from the on-disk config so a fresh session inherits the saved choice.
let disabled = false;
try { disabled = !((): boolean => {
  try { const raw = readFileSync(GLOBAL_TOGGLE_PATH, "utf8"); return JSON.parse(raw)?.["pi-beads"]?.hook !== false; } catch { return true; }
})(); } catch { /* ignore */ }

// ──────────────────────────────────────────────────────────────────────────────
// bd helpers
// ──────────────────────────────────────────────────────────────────────────────

interface BdResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function runBd(args: string[], cwd: string, timeoutMs = BD_RUN_TIMEOUT_MS): Promise<BdResult> {
  return new Promise<BdResult>((resolve) => {
    let resolved = false;
    const finish = (v: BdResult) => { if (!resolved) { resolved = true; resolve(v); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("bd", args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish({ ok: false, code: null, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    t.unref?.();
    child.stdout?.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(t); finish({ ok: false, code: null, stdout, stderr: stderr || e.message }); });
    child.on("close", (code) => {
      clearTimeout(t);
      finish({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function isBeadsProject(cwd: string): boolean {
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".beads"))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// Toggle config (global)
// ──────────────────────────────────────────────────────────────────────────────

function readToggleConfig(): Record<string, any> {
  try { return JSON.parse(readFileSync(GLOBAL_TOGGLE_PATH, "utf8")); } catch { return {}; }
}

function writeToggleConfig(cfg: Record<string, any>): void {
  writeFileSync(GLOBAL_TOGGLE_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function setHookEnabled(enabled: boolean): void {
  const cfg = readToggleConfig();
  cfg["pi-beads"] = { ...(cfg["pi-beads"] ?? {}), hook: enabled };
  writeToggleConfig(cfg);
}

function getHookEnabled(): boolean {
  const cfg = readToggleConfig();
  // Default: ON unless explicitly disabled. Back-compat: if the legacy
  // `extensions["pi-beads"] === false` flag is present we DO NOT honour it for
  // the hook — that flag controls whether the module is loaded at all, and if
  // we're running this code the module IS loaded.
  const v = cfg?.["pi-beads"]?.hook;
  return v !== false;
}

// ──────────────────────────────────────────────────────────────────────────────
// Hook: bd prime → conversation
// ──────────────────────────────────────────────────────────────────────────────

async function runBdPrime(cwd: string): Promise<string | null> {
  const r = await runBd(["prime"], cwd, EXEC_TIMEOUT_MS);
  return r.ok && r.stdout ? r.stdout : null;
}

async function prime(pi: ExtensionAPI, ctx: any, reason: string): Promise<void> {
  if (disabled) return;            // session override
  if (!getHookEnabled()) return;   // on-disk toggle (this was missing)
  const cwd = (typeof ctx?.cwd === "function" ? ctx.cwd() : ctx?.cwd) ?? process.cwd();
  if (!isBeadsProject(cwd)) return;
  const out = await runBdPrime(cwd);
  if (!out) return;
  const message = `<pi-beads trigger="${reason}">\n${out}\n</pi-beads>`;
  try {
    pi.sendUserMessage(message, { deliverAs: "followUp" });
  } catch {
    try { pi.sendUserMessage(message); } catch {}
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Async dispatch helpers — never block the handler
// ──────────────────────────────────────────────────────────────────────────────

function notify(ctx: any, msg: string, kind: "success" | "info" | "warning" | "error" = "info") {
  try { ctx?.ui?.notify?.(msg, kind); } catch {}
  try { console.log(msg); } catch {}
}

function injectFollowUp(pi: ExtensionAPI, body: string) {
  try {
    pi.sendUserMessage(body, { deliverAs: "followUp" });
  } catch {
    try { pi.sendUserMessage(body); } catch {}
  }
}

function ctxCwd(ctx: any): string {
  return (typeof ctx?.cwd === "function" ? ctx.cwd() : ctx?.cwd) ?? process.cwd();
}

/**
 * Run `bd <args>` in the background; deliver the result as a follow-up user
 * message tagged so the assistant knows it came from /beads. Fire-and-forget.
 */
function runAndInject(pi: ExtensionAPI, ctx: any, label: string, args: string[]) {
  const cwd = ctxCwd(ctx);
  notify(ctx, `🪡 bd ${args.join(" ")} …`, "info");
  void runBd(args, cwd).then((r) => {
    const tag = `<pi-beads cmd="${label}" exit="${r.code ?? "?"}">`;
    const body = r.ok
      ? `${tag}\n${r.stdout || "(no output)"}\n</pi-beads>`
      : `${tag}\nFAILED (exit ${r.code ?? "?"})\n${r.stderr || r.stdout || "(no output)"}\n</pi-beads>`;
    injectFollowUp(pi, body);
    notify(ctx, r.ok ? `✅ bd ${label} done` : `❌ bd ${label} failed`, r.ok ? "success" : "error");
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// /beads create — pi-tui form overlay
// ──────────────────────────────────────────────────────────────────────────────

const BD_TYPES = ["task", "feature", "bug", "chore", "epic", "decision"] as const;
const BD_PRIORITIES = ["0", "1", "2", "3", "4"] as const;

interface BdFormResult {
  cancelled: boolean;
  title: string;
  description: string;
  type: string;
  priority: string;
  labels: string;
}

type FieldKind = "text" | "select";
interface FormField {
  id: keyof Omit<BdFormResult, "cancelled">;
  label: string;
  kind: FieldKind;
  options?: readonly string[];
  required?: boolean;
}

const FORM_FIELDS: FormField[] = [
  { id: "title",       label: "Title",       kind: "text",   required: true },
  { id: "description", label: "Description", kind: "text" },
  { id: "type",        label: "Type",        kind: "select", options: BD_TYPES },
  { id: "priority",    label: "Priority",    kind: "select", options: BD_PRIORITIES },
  { id: "labels",      label: "Labels",      kind: "text" },
];

async function openCreateForm(ctx: any): Promise<BdFormResult> {
  if (!ctx?.hasUI || !ctx?.ui?.custom) {
    return { cancelled: true, title: "", description: "", type: "task", priority: "2", labels: "" };
  }

  return await ctx.ui.custom<BdFormResult>((tui: any, theme: any, _kb: any, done: (v: BdFormResult) => void) => {
    // State
    const values: Record<string, string> = {
      title: "",
      description: "",
      type: "task",
      priority: "2",
      labels: "",
    };
    let fieldIndex = 0;       // 0..FORM_FIELDS.length  (last = Submit button)
    let cachedLines: string[] | undefined;

    // Editors per text field (so they keep their own cursor / state)
    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
    };
    const editors = new Map<string, Editor>();
    for (const f of FORM_FIELDS) {
      if (f.kind === "text") {
        const ed = new Editor(tui, editorTheme);
        editors.set(f.id, ed);
      }
    }

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function isSubmitRow(): boolean {
      return fieldIndex === FORM_FIELDS.length;
    }

    function syncEditorValue(field: FormField) {
      const ed = editors.get(field.id);
      if (ed) values[field.id] = ed.getText?.() ?? values[field.id];
    }

    function syncAllValues() {
      for (const f of FORM_FIELDS) if (f.kind === "text") syncEditorValue(f);
    }

    function submit(cancelled: boolean) {
      syncAllValues();
      done({
        cancelled,
        title: values.title.trim(),
        description: values.description,
        type: values.type,
        priority: values.priority,
        labels: values.labels.trim(),
      });
    }

    function moveField(delta: number) {
      syncAllValues();
      const max = FORM_FIELDS.length; // submit row
      fieldIndex = (fieldIndex + delta + max + 1) % (max + 1);
      refresh();
    }

    function handleInput(data: string) {
      // Global: cancel
      if (matchesKey(data, Key.escape)) {
        submit(true);
        return;
      }

      // Submit row
      if (isSubmitRow()) {
        if (matchesKey(data, Key.enter)) {
          syncAllValues();
          if (!values.title.trim()) {
            // bounce back to title
            fieldIndex = 0;
            refresh();
            return;
          }
          submit(false);
          return;
        }
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) { moveField(1); return; }
        if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.up)) { moveField(-1); return; }
        return;
      }

      const field = FORM_FIELDS[fieldIndex];

      // Field navigation
      if (matchesKey(data, Key.tab) || (field.kind === "text" && matchesKey(data, Key.alt("down")))) {
        moveField(1); return;
      }
      if (matchesKey(data, Key.shift("tab")) || (field.kind === "text" && matchesKey(data, Key.alt("up")))) {
        moveField(-1); return;
      }

      if (field.kind === "select") {
        const opts = field.options!;
        const idx = Math.max(0, opts.indexOf(values[field.id]));
        if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
          values[field.id] = opts[(idx - 1 + opts.length) % opts.length];
          refresh(); return;
        }
        if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
          values[field.id] = opts[(idx + 1) % opts.length];
          refresh(); return;
        }
        // Number shortcut for priority/type quick-pick
        const n = Number(data);
        if (Number.isInteger(n) && n >= 0 && n < opts.length) {
          values[field.id] = opts[n];
          refresh(); return;
        }
        if (matchesKey(data, Key.enter)) { moveField(1); return; }
        return;
      }

      // text field: route to its Editor; Enter advances field (no newlines)
      if (matchesKey(data, Key.enter)) { moveField(1); return; }
      const ed = editors.get(field.id);
      if (ed) {
        ed.handleInput(data);
        values[field.id] = ed.getText?.() ?? values[field.id];
        refresh();
      }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;
      const lines: string[] = [];
      const add = (s: string) => lines.push(truncateToWidth(s, width));

      add(theme.fg("accent", "─".repeat(width)));
      add(theme.fg("accent", theme.bold(" /beads create — new issue")));
      add("");

      for (let i = 0; i < FORM_FIELDS.length; i++) {
        const f = FORM_FIELDS[i];
        const focused = i === fieldIndex;
        const marker = focused ? theme.fg("accent", "›") : " ";
        const reqStar = f.required ? theme.fg("warning", "*") : " ";
        const label = `${marker} ${reqStar} ${f.label}:`;
        const labelStyled = focused ? theme.fg("accent", label) : theme.fg("muted", label);

        if (f.kind === "select") {
          const opts = f.options!;
          const cur = values[f.id];
          const chips = opts.map((o) => {
            if (o === cur) return theme.bg("selectedBg", theme.fg("text", ` ${o} `));
            return theme.fg(focused ? "text" : "muted", ` ${o} `);
          }).join(theme.fg("dim", "│"));
          add(`${labelStyled}  ${chips}`);
        } else {
          const ed = editors.get(f.id)!;
          add(labelStyled);
          const innerWidth = Math.max(20, width - 4);
          const editorLines = ed.render?.(innerWidth) ?? [values[f.id] || ""];
          for (const ln of editorLines) add(`   ${ln}`);
        }
        add("");
      }

      const submitFocus = isSubmitRow();
      const submitText = " ✓ Create issue ";
      const submitStyled = submitFocus
        ? theme.bg("selectedBg", theme.fg("text", submitText))
        : theme.fg("success", submitText);
      add(`  ${submitStyled}    ${theme.fg("muted", "(Tab/↑↓ navigate · ←→ pick · Enter confirm · Esc cancel)")}`);

      add(theme.fg("accent", "─".repeat(width)));
      cachedLines = lines;
      return lines;
    }

    return {
      render,
      invalidate: () => { cachedLines = undefined; },
      handleInput,
    };
  }, {
    overlay: true,
    overlayOptions: {
      width: "70%",
      minWidth: 60,
      maxHeight: "80%",
      anchor: "center",
      margin: 2,
    },
  });
}

function buildCreateArgs(form: BdFormResult): string[] {
  const args = ["create", form.title, "--type", form.type, "--priority", form.priority];
  if (form.description.trim()) {
    args.push("--description", form.description);
  }
  if (form.labels.trim()) {
    args.push("--labels", form.labels);
  }
  return args;
}

async function dispatchCreate(pi: ExtensionAPI, ctx: any) {
  if (!ctx?.hasUI) {
    notify(ctx, "/beads create needs an interactive UI. Try `bd create-form` directly.", "warning");
    return;
  }
  const form = await openCreateForm(ctx);
  if (form.cancelled) {
    notify(ctx, "✋ /beads create cancelled.", "info");
    return;
  }
  if (!form.title.trim()) {
    notify(ctx, "/beads create: title is required.", "warning");
    return;
  }
  runAndInject(pi, ctx, "create", buildCreateArgs(form));
}

// ──────────────────────────────────────────────────────────────────────────────
// /beads hook on|off|status
// ──────────────────────────────────────────────────────────────────────────────

const HOOK_HELP = [
  "/beads hook — control the bd-prime session hook",
  "",
  "  /beads hook            Show current state (alias of status)",
  "  /beads hook status     Show current state",
  "  /beads hook on         Enable globally",
  "  /beads hook off        Disable globally + current session",
  "  /beads hook toggle     Flip current state (on ↔ off)",
  "",
  `config: ${GLOBAL_TOGGLE_PATH}`,
].join("\n");

function hookStatusMsg(): { msg: string; effective: boolean } {
  const onDisk = getHookEnabled();
  const effective = onDisk && !disabled;
  const msg =
    `beads hook: effective=${effective ? "ON" : "OFF"}  ` +
    `(config=${onDisk ? "on" : "off"}, session-override=${disabled ? "off" : "none"})\n` +
    `config: ${GLOBAL_TOGGLE_PATH} → "pi-beads".hook`;
  return { msg, effective };
}

function setHook(ctx: any, on: boolean) {
  disabled = !on;
  try {
    setHookEnabled(on);
    notify(
      ctx,
      on
        ? "✅ beads hook: ON (bd prime will run on session_start / before_compact)."
        : "🛑 beads hook: OFF (extension stays loaded; only the bd-prime hook is disabled).",
      "success",
    );
  } catch (e) {
    notify(
      ctx,
      `beads hook: ${on ? "enabled" : "disabled"} in this session, but failed to update config: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
  }
}

function dispatchHook(ctx: any, sub: string) {
  const arg = sub.trim().toLowerCase();

  if (arg === "help" || arg === "?" || arg === "-h" || arg === "--help") {
    notify(ctx, HOOK_HELP, "info");
    return;
  }

  if (arg === "" || arg === "status") {
    const { msg, effective } = hookStatusMsg();
    notify(ctx, msg + "\n\n" + HOOK_HELP, effective ? "info" : "warning");
    return;
  }

  if (arg === "off")    { setHook(ctx, false); return; }
  if (arg === "on")     { setHook(ctx, true);  return; }

  if (arg === "toggle") {
    const { effective } = hookStatusMsg();
    setHook(ctx, !effective);
    return;
  }

  notify(ctx, `beads hook: unknown subcommand "${arg}".\n\n${HOOK_HELP}`, "error");
}

// ──────────────────────────────────────────────────────────────────────────────
// Argument tokenizer (very small — splits on whitespace, supports "quoted")
// ──────────────────────────────────────────────────────────────────────────────

function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) { q = null; continue; }
      cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
    } else if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ""; }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Help
// ──────────────────────────────────────────────────────────────────────────────

const HELP_TEXT = [
  "/beads — beads (bd) integration",
  "",
  "  /beads hook [on|off|toggle|status]   Control the bd-prime session hook",
  "  /beads create               Open a form overlay to create a new issue",
  "  /beads ready                Show ready work (`bd ready`)",
  "  /beads list [args...]       Run `bd list ...`",
  "  /beads show <id>            Run `bd show <id>`",
  "  /beads close <id> [reason]  Run `bd close <id> [reason]`",
  "  /beads update <id> ...      Run `bd update <id> ...`",
  "  /beads <anything>           Pass-through: runs `bd <anything>`",
  "",
  "All subcommands run asynchronously — the chat is never blocked.",
].join("\n");

// ──────────────────────────────────────────────────────────────────────────────
// Extension entry
// ──────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await prime(pi, ctx, "session_start");
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    await prime(pi, ctx, "session_before_compact");
  });

  pi.registerCommand?.("beads", {
    description: "Beads (bd) integration. Try `/beads`, `/beads create`, `/beads hook status`.",
    getArgumentCompletions: () => [
      { value: "create",      label: "create",      description: "Open form to create a new issue" },
      { value: "ready",       label: "ready",       description: "Show ready work" },
      { value: "list",        label: "list",        description: "List issues" },
      { value: "show",        label: "show",        description: "Show an issue: /beads show <id>" },
      { value: "close",       label: "close",       description: "Close an issue: /beads close <id> [reason]" },
      { value: "update",      label: "update",      description: "Update an issue: /beads update <id> ..." },
      { value: "hook",        label: "hook",        description: "Show bd-prime hook state + help" },
      { value: "hook on",     label: "hook on",     description: "Enable bd-prime session hook" },
      { value: "hook off",    label: "hook off",    description: "Disable bd-prime session hook" },
      { value: "hook toggle", label: "hook toggle", description: "Flip bd-prime hook state (on ↔ off)" },
      { value: "hook status", label: "hook status", description: "Show bd-prime hook state" },
      { value: "help",        label: "help",        description: "Show /beads help" },
    ],
    handler: (args: string, ctx: any) => {
      const tokens = tokenize((args ?? "").trim());
      const sub = (tokens[0] ?? "").toLowerCase();
      const rest = tokens.slice(1);

      // Fire-and-forget: start work, return immediately so the chat keeps moving.
      try {
        if (sub === "" || sub === "help" || sub === "?" || sub === "-h" || sub === "--help") {
          notify(ctx, HELP_TEXT, "info");
          return;
        }

        if (sub === "hook") {
          dispatchHook(ctx, rest.join(" "));
          return;
        }

        if (sub === "create") {
          // Run in background — await would block the slash-command handler.
          void dispatchCreate(pi, ctx);
          return;
        }

        if (sub === "ready") {
          runAndInject(pi, ctx, "ready", ["ready", ...rest]);
          return;
        }

        if (sub === "list") {
          runAndInject(pi, ctx, "list", ["list", ...rest]);
          return;
        }

        if (sub === "show") {
          if (!rest.length) { notify(ctx, "/beads show <id>", "warning"); return; }
          runAndInject(pi, ctx, `show ${rest[0]}`, ["show", ...rest]);
          return;
        }

        if (sub === "close") {
          if (!rest.length) { notify(ctx, "/beads close <id> [reason]", "warning"); return; }
          runAndInject(pi, ctx, `close ${rest[0]}`, ["close", ...rest]);
          return;
        }

        if (sub === "update") {
          if (!rest.length) { notify(ctx, "/beads update <id> ...", "warning"); return; }
          runAndInject(pi, ctx, `update ${rest[0]}`, ["update", ...rest]);
          return;
        }

        // Unknown subcommand: pass through to bd.
        runAndInject(pi, ctx, [sub, ...rest].join(" "), [sub, ...rest]);
      } catch (e) {
        notify(ctx, `/beads error: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}
