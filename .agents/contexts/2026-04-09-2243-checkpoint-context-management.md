---
created: 2026-04-10T01:07:28.091Z
project: pi-my-extensions
description: Added session summary widget above editor in custom-footer.ts
context: pi-session-summary integration with custom widget placement
tags: [pi-extension, widget, session-summary, ui]
session_name: Summary widget above editor + toggle command
purpose: Display pi-session-summary's AI-generated summary above the prompt input instead of below the editor
session_id: 3053243f-d4b5-4738-892c-ca1f887f2b76
provider: pi
resume_with: cly agent-session resume --provider pi 2026-04-09-2243-checkpoint-context-management
context_name: 2026-04-09-2243-checkpoint-context-management
context_file: /Users/yuri/Workdir/Yuri/pi-my-extensions/.agents/contexts/2026-04-09-2243-checkpoint-context-management.md
---

## Session
- **Name:** Summary widget above editor + toggle command
- **Purpose:** Show pi-session-summary's AI summary above the editor (default placement) instead of below, controlled by a toggle command
- **Resume:** `cly agent-session resume --provider pi 2026-04-09-2243-checkpoint-context-management`

## Context
The `pi-session-summary` npm package generates one-line AI summaries of coding sessions and can display them as a widget. However, it hardcodes `{ placement: "belowEditor" }` and the only config toggle is `showWidget: boolean`. User wanted the summary above the editor (the default widget position in pi's API).

## Problem
No way to control widget placement in pi-session-summary without patching node_modules.

## Decisions
- **Don't patch node_modules** — reverted an initial edit to the npm package's `index.ts`
- **Keep `showWidget: false`** in `~/.pi/agent/session-summary.json` so the npm package doesn't render its own belowEditor widget
- **Add widget logic to `custom-footer.ts`** — the existing enabled extension that handles UI, rather than creating a new module
- **Read `pi.getSessionName()`** — pi-session-summary sets the session name after its async LLM call; the widget polls every 2s for 30s after `agent_end` to catch the update
- **Widget key `summary-above`** — different from pi-session-summary's `session-summary` key to avoid conflicts
- **`/summary:widget on|off`** command — namespaced with existing `summary:*` commands; no arg toggles, `on`/`off` for explicit control

## Current State
Complete. `extensions/modules/custom-footer.ts` has the summary widget and `/summary:widget` command. Needs `/reload` in pi to activate.

## Next Steps
- Test in a real session to confirm timing/polling catches the async summary update
- Consider persisting the `showSummary` preference across sessions (currently resets to `true` on reload)
