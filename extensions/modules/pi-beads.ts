/**
 * pi-beads — beads (`bd`) integration for pi.
 *
 * Behaviour:
 *   - Runs `bd prime` on session_start and session_before_compact and injects
 *     the output into the conversation (mirrors the Claude Code hook).
 *   - Provides a `/bd` slash command with subcommands:
 *
 *       /bd hook on|off|status         Toggle the bd-prime hook globally
 *       /bd create [title] [k=v ...]   No title: open form overlay. Either way the
 *                                      bead is CREATED by a background agent (big
 *                                      descriptions never touch the command line).
 *       /bd dispatch <title> [k=v ...] Hand bead creation AND its work to a background Agent subagent
 *       /bd dispatches                 Show queued dispatches (boundary mode)
 *       /bd list [args...]             Run `bd list` and inject the output
 *       /bd ready                      Run `bd ready` and inject the output
 *       /bd show <id>                  Run `bd show <id>` and inject the output
 *       /bd close <id> [reason]        Run `bd close` and inject the output
 *       /bd update <id> <args...>      Run `bd update` and inject the output
 *       /bd <anything>                 Pass-through: runs `bd <anything>`
 *     (also: /bdd <title> — shortcut for /bd dispatch)
 *
 *   - All handlers return IMMEDIATELY (fire-and-forget). The chat is never
 *     blocked waiting for `bd` to finish; results are delivered later via
 *     `pi.sendUserMessage(..., { deliverAs: "followUp" })` or `ui.notify`.
 *
 * Toggle config (hook only — extension itself stays loaded):
 *   - Global: ~/.pi/agent/extensions/pi-yuri-extensions.json  → "pi-beads".hook = true|false
 *   - Loader gate (separate): "extensions"."pi-beads" controls whether the
 *     module is loaded at all by the pi-extensions hub. Don't toggle that
 *     from /bd — turning it off would also kill the /bd command.
 *
 * Skips priming silently when:
 *   - `bd` is not on PATH
 *   - cwd has no `.beads/` directory walking up 8 parents
 *   - in-memory `disabled` flag is set (set by `/bd hook off` for current session)
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
import { PI_YU_CONFIG_FILENAME } from "../config.ts";

const EXEC_TIMEOUT_MS = 8_000;
const BD_RUN_TIMEOUT_MS = 30_000;
const GLOBAL_TOGGLE_PATH = join(homedir(), ".pi", "agent", "extensions", PI_YU_CONFIG_FILENAME);

// In-memory override so `/bd hook off` takes effect immediately. Initialised
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
 * message tagged so the assistant knows it came from /bd. Fire-and-forget.
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
// /bd create — pi-tui form overlay
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

      // Global: Enter confirms/submits from ANY field (matches the on-screen
      // hint "Enter confirm"). Title is required — if it's still empty, jump to
      // the Title field so the user can type instead of silently doing nothing.
      // Field-to-field navigation is Tab / Shift-Tab (and arrows on selects).
      if (matchesKey(data, Key.enter)) {
        syncAllValues();
        if (values.title.trim()) { submit(false); return; }
        fieldIndex = 0;
        refresh();
        return;
      }

      // Submit row
      if (isSubmitRow()) {
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
        return;
      }

      // text field: route to its Editor (Enter handled globally above as submit)
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
      add(theme.fg("accent", theme.bold(" /bd create — new issue")));
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

// Turn the form result into a title + bd flag array (excluding the positional
// title). The description is kept as a normal `--description` flag here; the
// dispatch layer splits it back out and routes the big text via a temp file so
// it never rides on the command line.
function formToTitleFlags(form: BdFormResult): { title: string; flags: string[] } {
  const flags = ["--type", form.type, "--priority", form.priority];
  if (form.description.trim()) flags.push("--description", form.description);
  if (form.labels.trim()) flags.push("--labels", form.labels);
  return { title: form.title, flags };
}

// Inline create parser for /bd create: free-text tokens become the title,
// `key=value` tokens become `--key value` flags. Multi-word values must be
// quoted, e.g. description="some longer text".
const CREATE_KEY_ALIASES: Record<string, string> = {
  d: "description", desc: "description", description: "description",
  t: "type", type: "type",
  p: "priority", prio: "priority", priority: "priority",
  l: "labels", label: "labels", labels: "labels",
  a: "assignee", assignee: "assignee",
  s: "status", status: "status",
};

function parseInlineCreate(rest: string[]): { title: string; flags: string[] } {
  const titleParts: string[] = [];
  const flags: string[] = [];
  for (const tok of rest) {
    const m = tok.match(/^([a-zA-Z][\w-]*)=(.*)$/);
    if (m) {
      const key = CREATE_KEY_ALIASES[m[1].toLowerCase()] ?? m[1].toLowerCase();
      flags.push(`--${key}`, m[2]);
    } else {
      titleParts.push(tok);
    }
  }
  return { title: titleParts.join(" ").trim(), flags };
}

// ──────────────────────────────────────────────────────────────────────────────
// /bd create & /bd dispatch — hand bead CREATION to a background Agent subagent
// ──────────────────────────────────────────────────────────────────────────────
//
// The extension NEVER runs `bd create` itself. Large descriptions overflow the
// argv limit (and mangle through shell/arg handling), so instead we inject a
// follow-up message instructing the MAIN agent to launch background `Agent`
// subagents (run_in_background: true) that perform the creation. The big
// description rides inside the follow-up message body (no argv limit there); the
// subagent is told to write it to a temp file and pass `bd create --body-file`,
// so the text never touches the command line.
//
//   - Plain create (/bd create, /bd create <title …>): the subagent just
//     creates the bead and reports its id (work=false).
//   - Dispatch (/bd dispatch, /bdd): the subagent creates the bead AND works it
//     (work=true).
//
// Two modes for the dispatch (work) flow
// (config: ~/.pi/agent/extensions/pi-yuri-extensions.json → "pi-beads".dispatchMode):
//   - "immediate" (default): inject the instruction right away.
//   - "boundary": queue the request and inject at the next agent_end (turn
//     boundary), so dispatch never interrupts an in-flight turn.
// Plain create always injects immediately.

type DispatchMode = "immediate" | "boundary";

function getDispatchMode(): DispatchMode {
  const v = readToggleConfig()?.["pi-beads"]?.dispatchMode;
  return v === "boundary" ? "boundary" : "immediate";
}

// A bead awaiting creation by a background agent.
interface PendingBead {
  title: string;
  description: string | null; // big text — routed via temp file, never argv
  flags: string[];            // remaining bd create flags (no --description)
  work: boolean;              // true = also work the bead after creating it
  cwd: string;
}

// Boundary-mode queue (in-memory, per session) for work=true dispatches.
const pendingQueue: PendingBead[] = [];

// Pull --description/-d out of a flag array so the (possibly huge) text can be
// routed through a temp file instead of the command line.
function splitDescription(flags: string[]): { description: string | null; flags: string[] } {
  const out: string[] = [];
  let description: string | null = null;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f === "--description" || f === "-d") {
      description = flags[i + 1] ?? "";
      i++; // skip the value too
      continue;
    }
    out.push(f);
  }
  return { description, flags: out };
}

/**
 * The follow-up message that tells the main agent to spin up background Agent
 * subagents to CREATE (and optionally work) the given beads. The description
 * text is embedded verbatim so the subagent can write it to a temp file —
 * keeping big text off the command line entirely.
 */
function buildCreateInstruction(items: PendingBead[]): string {
  const anyWork = items.some((i) => i.work);
  const lines: string[] = [
    `<pi-beads-create count="${items.length}">`,
    `Create the following beads issue(s) by dispatching background subagents, then return to whatever you were doing. Do NOT run \`bd create\` yourself in this turn, and NEVER pass a description as a command-line argument — large descriptions overflow the argv limit.`,
    ``,
    `For EACH issue below, call the \`Agent\` tool with run_in_background: true:`,
    `  • subagent_type: "general-purpose"`,
    `  • description: a 3-5 word summary`,
    `  • prompt: instruct the agent to —`,
    `      1. Write the issue's DESCRIPTION (provided verbatim below, between the markers) to a temp file, e.g. /tmp/bd-desc-N.md. Skip this if the description is "(none)".`,
    `      2. Create the bead: \`bd create "<title>" --body-file <tmpfile> <flags> --json\` (omit --body-file when there is no description).`,
    `      3. Read the new bead id from the JSON output.`,
  ];
  if (anyWork) {
    lines.push(`      4. If the issue is marked Work: yes — mark it in_progress (\`bd update <id> --status in_progress\`), do the work, record progress with \`bd update <id> --notes ...\`, and \`bd close <id> --reason ...\` when done. Do NOT git commit or git push — leave changes in the working tree.`);
    lines.push(`      5. End with a 2-4 line summary that includes the new bead id.`);
  } else {
    lines.push(`      4. End with a one-line summary that includes the new bead id.`);
  }
  lines.push(``);
  lines.push(`Launch them in a single message (multiple Agent calls, each run_in_background: true) so they run in parallel. After launching, briefly note the dispatched agent id(s) and resume your prior task. pi reports each subagent's result when it finishes.`);
  lines.push(``);
  items.forEach((it, i) => {
    const n = i + 1;
    lines.push(`───── issue ${n} ─────`);
    lines.push(`Title: ${it.title}`);
    lines.push(`Flags: ${it.flags.join(" ") || "(none)"}`);
    lines.push(`Work: ${it.work ? "yes" : "no"}`);
    lines.push(`Description (verbatim, between the markers — do not include the markers):`);
    lines.push(`<<<BD-DESC-${n}`);
    lines.push(it.description && it.description.trim() ? it.description : "(none)");
    lines.push(`BD-DESC-${n}`);
  });
  lines.push(`</pi-beads-create>`);
  return lines.join("\n");
}

/**
 * Route a bead CREATION request to a background Agent subagent — immediately, or
 * (for work=true dispatches in boundary mode) at the next turn boundary. Never
 * runs `bd create` itself and never blocks the slash-command handler.
 */
function dispatchAgent(pi: ExtensionAPI, ctx: any, title: string, flags: string[], work = true) {
  const cwd = ctxCwd(ctx);
  const { description, flags: rest } = splitDescription(flags);
  const item: PendingBead = { title, description, flags: rest, work, cwd };

  if (work && getDispatchMode() === "boundary") {
    pendingQueue.push(item);
    notify(ctx, `🤖 “${title}” queued — I'll hand creation to a background agent at the next turn boundary.`, "success");
    return;
  }
  notify(ctx, work ? `📮 handing “${title}” to a background agent (create + work) …` : `📮 handing “${title}” to a background agent to create …`, "info");
  injectFollowUp(pi, buildCreateInstruction([item]));
}

/**
 * Boundary mode: at agent_end, hand any queued creation requests (for this cwd)
 * to background agents via a single follow-up instruction, then clear them.
 */
function drainDispatchQueue(pi: ExtensionAPI, cwd: string) {
  const items = pendingQueue.filter((q) => q.cwd === cwd);
  if (!items.length) return;
  for (const it of items) {
    const i = pendingQueue.indexOf(it);
    if (i >= 0) pendingQueue.splice(i, 1);
  }
  injectFollowUp(pi, buildCreateInstruction(items));
}

async function dispatchCreate(pi: ExtensionAPI, ctx: any) {
  if (!ctx?.hasUI) {
    notify(ctx, "/bd create needs an interactive UI. Try `bd create-form` directly.", "warning");
    return;
  }
  const form = await openCreateForm(ctx);
  if (form.cancelled) {
    notify(ctx, "✋ /bd create cancelled.", "info");
    return;
  }
  if (!form.title.trim()) {
    notify(ctx, "/bd create: title is required.", "warning");
    return;
  }
  const { title, flags } = formToTitleFlags(form);
  dispatchAgent(pi, ctx, title, flags, false);
}

// ──────────────────────────────────────────────────────────────────────────────
// /bd hook on|off|status
// ──────────────────────────────────────────────────────────────────────────────

const HOOK_HELP = [
  "/bd hook — control the bd-prime session hook",
  "",
  "  /bd hook            Show current state (alias of status)",
  "  /bd hook status     Show current state",
  "  /bd hook on         Enable globally",
  "  /bd hook off        Disable globally + current session",
  "  /bd hook toggle     Flip current state (on ↔ off)",
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
  "/bd — beads (bd) integration",
  "",
  "  /bd hook [on|off|toggle|status]    Control the bd-prime session hook",
  "  /bd create                         Open a form overlay; a background agent creates the issue",
  "  /bd create <title> [key=value ...] Create via a background agent (free text → title; key=value → bd flags)",
  "                                     e.g. /bd create fix login bug priority=1 description=\"cannot log in\"",
  "  /bd dispatch <title> [key=value ...]  Hand bead creation AND its work to a background",
  "                                        Agent subagent. Non-blocking.",
  "  /bdd <title> [key=value ...]       Shortcut for /bd dispatch.",
  "  /bd dispatches                     Show queued dispatches (boundary mode).",
  "  /bd ready                          Show ready work (`bd ready`)",
  "  /bd list [args...]                 Run `bd list ...`",
  "  /bd show <id>                      Run `bd show <id>`",
  "  /bd close <id> [reason]            Run `bd close <id> [reason]`",
  "  /bd update <id> ...                Run `bd update <id> ...`",
  "  /bd <anything>                     Pass-through: runs `bd <anything>`",
  "",
  "All subcommands run asynchronously — the chat is never blocked.",
].join("\n");

// ──────────────────────────────────────────────────────────────────────────────
// Shared dispatch (the /bd command handler)
// ──────────────────────────────────────────────────────────────────────────────

function dispatch(pi: ExtensionAPI, args: string, ctx: any) {
  const tokens = tokenize((args ?? "").trim());
  const sub = (tokens[0] ?? "").toLowerCase();
  const rest = tokens.slice(1);
  const cmd = "bd";

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
      const { title, flags } = parseInlineCreate(rest);
      if (!title) {
        // No title given → open the interactive form overlay.
        void dispatchCreate(pi, ctx);
        return;
      }
      // Hand creation to a background agent (create only, no work).
      dispatchAgent(pi, ctx, title, flags, false);
      return;
    }

    if (sub === "dispatch") {
      const { title, flags } = parseInlineCreate(rest);
      if (!title) {
        notify(ctx, `/${cmd} dispatch <title> [key=value ...]  — hands creation to a background agent that also works it (non-blocking).`, "warning");
        return;
      }
      dispatchAgent(pi, ctx, title, flags, true);
      return;
    }

    if (sub === "dispatches" || sub === "queue" || sub === "jobs") {
      const cwd = ctxCwd(ctx);
      const queued = pendingQueue.filter((q) => q.cwd === cwd);
      if (queued.length) {
        notify(ctx, `bd dispatch: ${queued.length} bead(s) queued for creation (mode=${getDispatchMode()}). Draining now …`, "info");
        drainDispatchQueue(pi, cwd);
      } else {
        notify(ctx, `bd dispatch: nothing queued (mode=${getDispatchMode()}). Running agents appear in your agent runner's widget.`, "info");
      }
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
      if (!rest.length) { notify(ctx, `/${cmd} show <id>`, "warning"); return; }
      runAndInject(pi, ctx, `show ${rest[0]}`, ["show", ...rest]);
      return;
    }

    if (sub === "close") {
      if (!rest.length) { notify(ctx, `/${cmd} close <id> [reason]`, "warning"); return; }
      runAndInject(pi, ctx, `close ${rest[0]}`, ["close", ...rest]);
      return;
    }

    if (sub === "update") {
      if (!rest.length) { notify(ctx, `/${cmd} update <id> ...`, "warning"); return; }
      runAndInject(pi, ctx, `update ${rest[0]}`, ["update", ...rest]);
      return;
    }

    // Unknown subcommand: pass through to bd.
    runAndInject(pi, ctx, [sub, ...rest].join(" "), [sub, ...rest]);
  } catch (e) {
    notify(ctx, `/${cmd} error: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

const ARGUMENT_COMPLETIONS = [
  { value: "create",      label: "create",      description: "Create a new issue via a background agent (form when no title)" },
  { value: "dispatch",    label: "dispatch",    description: "Hand bead creation + its work to a background Agent subagent: dispatch <title> [key=value ...]" },
  { value: "dispatches",  label: "dispatches",  description: "Show queued dispatches (boundary mode)" },
  { value: "ready",       label: "ready",       description: "Show ready work" },
  { value: "list",        label: "list",        description: "List issues" },
  { value: "show",        label: "show",        description: "Show an issue: show <id>" },
  { value: "close",       label: "close",       description: "Close an issue: close <id> [reason]" },
  { value: "update",      label: "update",      description: "Update an issue: update <id> ..." },
  { value: "hook",        label: "hook",        description: "Show bd-prime hook state + help" },
  { value: "hook on",     label: "hook on",     description: "Enable bd-prime session hook" },
  { value: "hook off",    label: "hook off",    description: "Disable bd-prime session hook" },
  { value: "hook toggle", label: "hook toggle", description: "Flip bd-prime hook state (on ↔ off)" },
  { value: "hook status", label: "hook status", description: "Show bd-prime hook state" },
  { value: "help",        label: "help",        description: "Show help" },
];

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

  // Boundary dispatch mode: hand any queued beads to background agents at the
  // end of a turn — a natural boundary that never interrupts in-flight work.
  // (Immediate mode injects at dispatch time and leaves the queue empty.)
  pi.on("agent_end", async (_event, ctx) => {
    try { drainDispatchQueue(pi, ctxCwd(ctx)); } catch { /* ignore */ }
  });

  pi.registerCommand?.("bd", {
    description: "Beads (bd) integration. /bd create [title], /bd dispatch <title>, /bd hook status, /bd <anything>.",
    getArgumentCompletions: () => ARGUMENT_COMPLETIONS,
    handler: (args: string, ctx: any) => dispatch(pi, args, ctx),
  });

  // /bdd — one-word shortcut for `/bd dispatch`. The entire argument string is
  // the title; key=value tokens become bd flags. Creates a bead and hands it
  // to a background agent without blocking the chat.
  pi.registerCommand?.("bdd", {
    description: "Dispatch: create a bead + hand it to a background agent. /bdd <title> [key=value …]",
    handler: (args: string, ctx: any) => {
      const { title, flags } = parseInlineCreate(tokenize((args ?? "").trim()));
      if (!title) {
        notify(ctx, `/bdd <title> [key=value ...]  — e.g. /bdd refactor the parser priority=1 description="split into modules"`, "warning");
        return;
      }
      try { dispatchAgent(pi, ctx, title, flags); }
      catch (e) { notify(ctx, `/bdd error: ${e instanceof Error ? e.message : String(e)}`, "error"); }
    },
  });
}
