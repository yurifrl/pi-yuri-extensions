# Changelog

## 2026-09-14 Statusline context cap follows /ctx immediately

### Fixed
- The statusline contextLimit segment froze on the session-start cap: `/ctx set` (and the visual picker) updated the config file but the widget kept rendering the old limit until the next session. The cap now flows through a live `ctxLimitSignal` (exported by `extensions/modules/ctx.ts` next to `ctxCompaction`), which the component reads per frame — a change with `/ctx` shows up on the next statusline render, and the indicator's pressure percentage follows the same live value.

## 2026-09-13 LLM tools renamed diff_* to comment_*

### Changed
- Tool surface follows the module rename: `diff_pending` → `comment_pending`, `diff_all` → `comment_all`, `diff_cmux_all` → `comment_cmux_all`, `diff_hunk_all` → `comment_hunk_all`, `diff_get` → `comment_get`, `diff_mark_sent` → `comment_mark_sent`. Labels and descriptions drop the "Diff" prefix; internal cross-references (formatComments footer, docblock) follow.
- `begin-single-feature` skill section now teaches the `comment_*` tools and no longer names Hunk or its CLI (the `hunk-review` skill still owns direct Hunk driving).

## 2026-09-13 diff-watch renamed to comments-watch; comments filterable by regex or file list

### Changed
- Module `diff-watch` renamed to `comments-watch` (`extensions/omp/modules/comments-watch.ts`); commands `/diff-watch` and `/diff-sync` renamed to `/comments-watch` and `/comments-sync`, and the `/dw` + `/ds` aliases removed. Config keys in `MODULE_NAMES`/`DEFAULT_CONFIG` (`extensions/modules/config.ts`), the OMP loader, and the global toggle JSON (`~/.omp/agent/extensions/pi-yuri-extensions.json`) follow the new module name.
- Both commands take an optional filter argument: a regex matched against comment file paths, or a comma-separated file list (exact or path-suffix match — `foo.ts` matches `src/foo.ts`). No filter means all comments for the repo. Filtered-out comments stay unsent and are reconsidered on the next poll/sync; the watch widget and `status` show the active filter, and `off` clears it.
- Sent-pointer state dir `~/.omp/agent/diff-watch/` renamed to `comments-watch/`; existing pointer files migrate automatically on first load, so sessions do not re-submit old comments.

## 2026-09-13 Checkpoints maintain one root CHANGELOG.md

### Fixed
- Sessions were scattering changelog notes into `.agents/checkpoints/` because the checkpoint skill only said "create or update the one matching entry" — no location, no template, no rules. The skill now embeds an explicit changelog contract (repo root only, intention-first entries, minimal code mentions, dedupe over pile-up) and `checkpoint_prepare` returns that root path as `changelogFile`, so Pi and OMP sessions append to one shared history.
- Worse, the model answered `/checkpoint` by calling the runtime's built-in `checkpoint`/`rewind` context tools — those only park conversation context and never touch disk, so neither the checkpoint file nor the changelog was written at all. Two deterministic tools now own the writes: `checkpoint_save` renders frontmatter + Context/Decisions/Current State/Lessons/Next Steps and creates or updates the session's checkpoint file, and `changelog_update` inserts or merges the root `CHANGELOG.md` section (date-ordered newest-first, deduplicates bullets, groups by Added/Changed/Fixed category). The skill calls exactly these two and warns against the built-in pair.
- Even after the tools existed, the name kept losing: OMP ships built-in `checkpoint`/`rewind` context tools, so models grabbed those instead (`goal=` in, nothing written to disk). The whole feature is now snapshot: `/snapshot` command, `snapshot` skill, `snapshot_write` + `changelog_update` tools, module path `extensions/modules/snapshot/`, config key `snapshot` in `MODULE_NAMES`/`DEFAULT_CONFIG` and the global toggle JSONs, storage `.agents/snapshots/` (existing files migrated), frontmatter `snapshot_file`. The built-in pair is blocked at the `tool_call` hook with a redirect message, so a confused model self-corrects instead of silently parking context. `snapshot_prepare` is gone entirely (redundant — `snapshot_write` resolves paths internally).

## 2026-09-08 diff-watch: pull cmux/Hunk diff-review comments into the session

### Added
- `extensions/omp/modules/diff-watch.ts` — reads diff-review comments from two sources and submits new ones into the current OMP session as a followUp message. Sources: cmux's diff viewer (comment stores under `~/Library/Application Support/cmux/diff-comments/<sha256(canonical repo root)[0:24]>.json` — no comments CLI/events on cmux 0.64.x, so the store is read directly) and live Hunk sessions (`hunk session comment list --repo <root> --json`; empty when no session/daemon). Per-source toggles under `modules.diff-watch.sources`.
- `/diff-watch [on|off|status]` (`/dw`) — toggle a 2s poller for the session repo's comments; new comments arrive as one formatted followUp. `/diff-sync [--all]` (`/ds`) — one-shot submit (current repo, or every repo with a store via `--all`).
- Sent pointers per session file + repo (`~/.omp/agent/diff-watch/<session>.json`): a comment is submitted exactly once per session; re-keyed on `session_switch`/`session_branch`.
- LLM tools: `diff_pending` (new, unsent), `diff_all` (everything, `sent` flags, `scope: "all"` across repos), `diff_cmux_all` / `diff_hunk_all` (per-source dumps), `diff_get` (full records incl. cmux `submissionText` diff context, by id), `diff_mark_sent` (advance the pointer manually).
- `"diff-watch"` in `MODULE_NAMES`/`DEFAULT_CONFIG` (`extensions/modules/config.ts`) with `sources: {cmux, hunk}` per-module config; registered in the OMP loader. Disabled by default; enabled in `~/.omp/agent/extensions/pi-yuri-extensions.json`.


## 2026-09-05 Statusline widget renders as a native-style band

### Fixed
- `statusline/view.ts` now renders the row the way omp's native status line does: a `statusLineBg` band ending at the last segment (no full-width fill) with a solid powerline end cap (`useBgAsFg`, dropped on transparent fills), segments joined with ` <sep> ` (spaced powerline-thin arrow, `statusLineSep` fg) instead of bare U+E0B1 with no spacing. `StatuslineTheme` gains `bg()`/`getBgAnsi()`; `statusLineSep` added to the color vocabulary. Prefix/indicator renders inside the band as the first part.

## 2026-09-01 Port @fbr/toolkit into shared + omp modules

### Added
- Shared runtime-neutral modules ported from `@fbr/toolkit` in the omp-marketplace repo. Flat files `extensions/modules/<name>.ts` for `budget`, `ctx`, `exit`, `handoff`, `queue`, `quick`, `respond`, `thinking`; folders only where the module has multiple files (`coderabbit/` + `index.test.ts`, `statusline/` + `view.ts`). `omp/awsLoginConfig.ts` folded into `modules/aws/` next to its only consumer: `aws/` now holds `index.ts`, `awsLoginConfig.ts`, `bedrock-auth.ts`, `index.test.ts` (the test moved from `modules/aws.test.ts`, its self-reference retargeted).
- OMP-only modules: `extensions/omp/modules/continue.ts` (needs the omp auto-compaction event bracket) and `extensions/omp/modules/update.ts` (omp plugin-store paths).
- Runtime-agnostic config store in `extensions/modules/config.ts` (`setConfigStore`/`readSharedConfig`/`writeSharedConfig`): omp points it at `~/.omp/agent/extensions/pi-yuri-extensions.json`, pi at `~/.pi/agent/extensions/pi-yuri-extensions.json`. Modules never touch the filesystem directly.
- Toolkit top-level fields on `YuriExtensionsConfig`: `budgetGates`, `ctxLimit`, `ctxLimitAction`, `continueAfterCompactPrompt`, `statusline` (+ statusline constants/types).
- `tsconfig.json` + `@types/node` dev dep for `bunx tsc -p tsconfig.json` typechecking.

### Changed
- Every module registers individually in its runtime loader (`extensions/omp/index.ts`, `extensions/pi/index.ts`); pi-side toggles default OFF per repo convention, omp-side ON.
- Dual-runtime compatibility shims where the APIs diverge: `truncateToWidth` ellipsis argument, `session_switch`/`session_branch`/`willContinue` guarded as omp-only, `ctx.compact()` thenable-agnostic, unified `input` result shape, `ctx.models` fallback to `modelRegistry.getAvailable()`, `ThinkingLevel` as plain string union.
- User config: `~/.omp/agent/extensions/toolkit.json` merged into `~/.omp/agent/extensions/pi-yuri-extensions.json`; toolkit.json and legacy `~/.omp/agent/fbr-toolkit.json` removed.

### Notes
- Source marketplace plugin left untouched on its feature branch; upstream can keep or drop it independently.

## 2026-08-29 OMP: nudge + notifications from pi-fbr-extensions

### Added
- `extensions/omp/modules/nudge.ts` — top-level `/nudge`: interrupt a stalled run and resend `continue` (ported from discontinued `pi-fbr-extensions`).
- `extensions/omp/modules/notifications.ts` — cmux banners for guardrails prompt/blocked/risk (yolo-gated), AskUserQuestion, run errors, and tool errors; `/notifications` toggle UI; per-event state persisted under `modules.notifications.events` in `~/.omp/agent/extensions/pi-yuri-extensions.json`.
- `nudge` and `notifications` registered in the OMP loader (`extensions/omp/index.ts`) and added to `MODULE_NAMES`/defaults in `extensions/modules/config.ts`.
- `writeOmpConfig`/`CONFIG_PATH` exports in `extensions/omp/config.ts`; `isModuleEnabled` hardened against missing module entries.

### Notes
- `working` was already present on the OMP side as the placeholder module — no copy needed.
- Nudge removed from `@fbr/toolkit` 0.2.0 (dedupe: one owner per command).

## 2026-07-05 Vim File Opener Extension
- Session ID: f8a7b3c1-5e4f-4a2d-9b8e-6c3a7d9f1e2b
- Session File: /Users/yuri/.pi/agent/sessions/--Users-yuri-DotFiles--/2026-07-05T10-00-00-000Z_f8a7b3c1-5e4f-4a2d-9b8e-6c3a7d9f1e2b.jsonl
- Session Name: vim-file-opener-extension
- Context Name: vim-file-opener-extension

### Added
- `extensions/modules/e.ts` — new `/e` command that works like vim's `/e` command but uses Neovim, supporting absolute paths, relative paths, current directory opening, and `@` prefixed paths
- Registered `e` module in `MODULE_LOADERS` map in `extensions/pi-extensions.ts`
- Documentation for `/e` command in README.md

### Changed
- Updated README.md to include `e` in the list of available module keys
- Extended Commands documentation in README.md to describe `/e` usage

## 2026-04-10 Session Summary Widget Above Editor
- Session ID: 3053243f-d4b5-4738-892c-ca1f887f2b76
- Session File: /Users/yuri/.pi/agent/sessions/--Users-yuri-Workdir-Yuri-pi-my-extensions--/2026-04-10T01-07-28-091Z_3053243f-d4b5-4738-892c-ca1f887f2b76.jsonl
- Session Name: 2026-04-09-2243-checkpoint-context-management
- Context Name: 2026-04-09-2243-checkpoint-context-management

### Added
- `extensions/modules/custom-footer.ts` — summary widget above the editor that reads `pi.getSessionName()` (set by pi-session-summary) and renders it with `◇` prefix; polls every 2s for 30s after each agent turn to catch async LLM updates
- `extensions/modules/custom-footer.ts` — `/summary:widget` command accepting `on`, `off`, or no arg (toggle) to show/hide the widget

### Changed
- `~/.pi/agent/session-summary.json` — `showWidget` set to `false` so pi-session-summary doesn't render its own belowEditor widget (the custom-footer widget replaces it above the editor)

## 2026-03-27 Checkpoint Touched-File Tracking and Pi API Fix
- Session ID: c304db5b-6efe-4f3c-9b28-00e1607601d8
- Session File: /Users/yuri/.pi/agent/sessions/--Users-yuri-Workdir-Yuri-pi-my-extensions--/2026-03-27T19-02-35-830Z_c304db5b-6efe-4f3c-9b28-00e1607601d8.jsonl
- Session Name: 2026-03-27-1611-guardrails-slack-notifications
- Context Name: 2026-03-27-1611-guardrails-slack-notifications

### Changed
- `extensions/modules/checkpoint.ts` — fixed `getApiKey` → `getApiKeyAndHeaders` (pi API update); now destructures `{ ok, apiKey, headers }` and passes headers to LLM call
- `extensions/modules/checkpoint.ts` — added `touchedFiles: Set<string>` populated by listening to `write`/`edit` tool call events at module load; resolves relative paths via `ctx.cwd`
- `extensions/modules/checkpoint.ts` — `buildCheckpointPrompt` now accepts `touchedFiles` param; scopes changelog diff instructions to only the files the agent touched in this session

## 2026-03-27 Guardrails Cmux Notifications
- Session ID: fbfdb7e6-4063-499a-a3f1-e67c01f732a6
- Session File: /Users/yuri/.pi/agent/sessions/--Users-yuri-Workdir-Yuri-pi-my-extensions--/2026-03-27T03-26-42-243Z_fbfdb7e6-4063-499a-a3f1-e67c01f732a6.jsonl
- Session Name: 2026-03-27-1128-guardrails-slack-notifications
- Context Name: 2026-03-27-1128-guardrails-slack-notifications

### Added
- `extensions/modules/guardrails-notify.ts` — listens to `guardrails:dangerous` and `guardrails:blocked` events from `@aliou/pi-guardrails` and fires cmux notifications via `pi.exec("cmux", ["notify", ...])`

### Changed
- `~/.pi/agent/settings.json` — moved local extension source before `@aliou/pi-guardrails` in packages array to ensure correct `tool_call` handler registration order

## 2026-03-23 AI Session Naming and Cly Upsert Migration
- Session ID: d821779b-b5b8-48b3-be74-aa075168c287
- Session File: /Users/yuri/.pi/agent/sessions/--Users-yuri-Workdir-Yuri-pi-my-extensions--/2026-03-23T20-07-17-984Z_d821779b-b5b8-48b3-be74-aa075168c287.jsonl
- Session Name: 2026-03-23-1716-cross-agent-context-doc
- Context Name: 2026-03-23-1716-cross-agent-context-doc

### Changed
- `extensions/modules/checkpoint.ts` — replaced `generateContextDescription` with `generateSessionMeta` returning `{ shortName, description }` via two-line AI prompt; maxTokens 20→120
- `extensions/modules/checkpoint.ts` — migrated from `cly agent-session save <name> <id>` to `cly agent-session upsert <id> --name --description` (ID-first API)
- `extensions/modules/checkpoint.ts` — `findSessionInCly` returns full `Entry` instead of just name string; added `Entry` interface matching cly data model
- `extensions/modules/checkpoint.ts` — `findOrCreateSession` returns `{ entry: Entry; created: boolean }`
- Rebuilt `cly` binary from source to include `upsert` command and `--json` flag on save

### Removed
- `~/.agents/skills/ag:checkpoint/` — deleted unused skill, superseded by checkpoint extension

## 2026-03-23 Checkpoint Command and Cly Agent Session Refactor
- Session ID: 52391ab7-00a4-4100-9f8c-6282f43a996e
- Session File: /Users/yuri/.pi/agent/sessions/--Users-yuri-Workdir-Yuri-pi-my-extensions--/2026-03-23T05-00-24-701Z_52391ab7-00a4-4100-9f8c-6282f43a996e.jsonl
- Session Name: pi-2026-03-23-52391ab7
- Context Name: pi-2026-03-23-52391ab7

### Added
- `extensions/modules/checkpoint.ts` — `/checkpoint` command that resolves Pi session ID, find-or-creates session in cly with AI-generated name, then emits prompt for context/summary/changelog
- `extensions/modules/lib/config.ts` — shared config reader for pi-my-extensions toggle system
- `extensions/modules/lib/themeMap.ts` — shared theme mapping utilities
- `extensions/config.ts` — centralized extension config types

### Changed
- `extensions/pi-my-extensions.ts` — added checkpoint module to loader registry
- All extension modules updated to use shared lib imports (`lib/config.ts`, `lib/themeMap.ts`)
- `extensions/modules/cross-agent.ts` — significant refactor for multi-source agent/skill/command discovery

### Removed
- `extensions/modules/save.ts` — replaced by checkpoint
- `extensions/modules/themeMap.ts` — moved to `lib/themeMap.ts`
- Old `.agents/contexts/` files — stale context files from prior sessions
