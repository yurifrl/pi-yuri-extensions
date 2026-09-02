# Changelog

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
