---
created: 2026-03-27T03:49:00Z
project: pi-my-extensions
description: Built guardrails-notify extension to surface pi-guardrails events as cmux notifications
context: pi-guardrails event integration, cmux notify API, extension load ordering
tags: [guardrails, notifications, cmux, extensions]
session_name: 2026-03-27-1128-guardrails-slack-notifications
purpose: Wire pi-guardrails dangerous/blocked events to visible cmux notifications using pi.exec("cmux", ["notify", ...])
session_id: fbfdb7e6-4063-499a-a3f1-e67c01f732a6
provider: pi
resume_with: cly agent-session resume --provider pi 2026-03-27-1128-guardrails-slack-notifications
context_name: 2026-03-27-1128-guardrails-slack-notifications
context_file: /Users/yuri/Workdir/Yuri/pi-my-extensions/.agents/contexts/2026-03-27-1128-guardrails-slack-notifications.md
---

## Session

- **Name:** 2026-03-27-1128-guardrails-slack-notifications
- **Purpose:** Build a pi extension that notifies when guardrails intercepts dangerous or blocked commands
- **Session ID:** fbfdb7e6-4063-499a-a3f1-e67c01f732a6
- **Resume:** `cly agent-session resume --provider pi 2026-03-27-1128-guardrails-slack-notifications`

## Context

- Repo: `/Users/yuri/Workdir/Yuri/pi-my-extensions`
- Extension: `extensions/modules/guardrails-notify.ts`
- Already registered in `extensions/pi-my-extensions.ts` and enabled in `~/.pi/agent/settings.json`
- `@aliou/pi-guardrails` is installed as an npm package and loaded via settings.json

## Problem

`ctx.ui.notify()` is the official pi notification API but is a no-op in websocket/RPC transport mode (cmux). The RPC mode sends an `extension_ui_request` over websocket but pi-cmux has no handler for it — the message is silently dropped.

Additionally, extension load order matters: guardrails registers its `tool_call` hook first (it's an npm package loaded before local extensions). It emits `guardrails:dangerous` synchronously inside that hook. Our `tool_call` handler runs after, so capturing ctx from `tool_call` arrived too late.

## Decisions

1. **Don't use `terminal-notifier`** — user constraint, must use pi APIs only
2. **Don't fight `ctx.ui.notify`** — it's broken in RPC mode; cmux doesn't handle `extension_ui_request`
3. **Use `pi.exec("cmux", ["notify", ...])`** — cmux has a native `notify` command; `pi.exec` is the official pi API for running external commands; same pattern used by pi-cmux internally
4. **Reorder packages in settings.json** — moved local extension source before `@aliou/pi-guardrails` so our `tool_call` handler registers first (needed for ctx capture approach, now moot since we use `pi.events` directly without needing ctx)

## Current State

Working. `guardrails-notify.ts` listens to `guardrails:dangerous` and `guardrails:blocked` events and calls `pi.exec("cmux", ["notify", ...])`. Confirmed working: cmux notification appears when `sudo` is run.

File is clean, no debug logging.

## Next Steps

- Optionally handle `guardrails:blocked` differently (e.g. different sound/urgency) if cmux notify supports it
- Consider reverting package order in settings.json if the reorder causes any side effects (it's not needed for the current implementation)
