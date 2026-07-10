# pi-extensions

Your personal **pi package hub**.

- Main extension name: **pi-extensions**
- All bundled extensions are **toggleable**
- All toggles are **OFF by default**
- Enable/disable modules in config: `.pi/extensions/pi-extensions.json` (project) or `~/.pi/agent/extensions/pi-extensions.json` (global)

## Install

```bash
npm install
pi install .
```

(or `pi install -l .` for project-local settings)

## How toggles work

Only `extensions/pi-extensions.ts` is auto-loaded by pi.

On `session_start`, `pi-extensions` reads config from:

- project: `.pi/extensions/pi-extensions.json`
- global: `~/.pi/agent/extensions/pi-extensions.json`
- legacy fallback: `.pi/pi-extensions.json`

Project config takes precedence over global config when both exist.

## Toggle config

Example:

```json
{
  "extensions": {
    "yu-notify": true,
    "minimal": true,
    "tool-counter": false
  }
}
```

Any omitted key defaults to `false`.

## Notification backend config (`yu-notify`)

`yu-notify` supports configurable desktop notification transport via `.pi/extensions/pi-extensions.json` (project) or `~/.pi/agent/extensions/pi-extensions.json` (global):

```json
{
  "extensions": {
    "yu-notify": true
  },
  "notify": {
    "backend": "notifier",
    "oscProtocol": "auto"
  }
}
```

Options:

- `notify.backend`: `"notifier"` (default), `"osc"`, `"auto"`
- `notify.oscProtocol`: `"auto"` (default), `"777"`, `"9"`, `"99"`

Notes:

- Default stays `notifier` (uses `terminal-notifier` on macOS).
- Set `backend: "osc"` to force OSC notifications.
- `auto` tries notifier first, then falls back to OSC.

## Available module keys

- `agent-chain`
- `agent-loop`
- `agent-team`
- `agents-mcp-loader`
- `checkpoint`
- `confirm-notify`
- `cross-agent`
- `damage-control`
- `e`
- `minimal`
- `pi-pi`
- `greetings`
- `yu-notify`
- `idle-watch`
- `pure-focus`
- `purpose-gate`
- `session-replay`
- `subagent-widget`
- `system-select`
- `theme-cycler`
- `tilldone`
- `tool-counter`
- `tool-counter-widget`
- `what`

## Commands

Use:

```bash
/pi-extensions
```

It prints current toggle status and config path.

Enable the `what` module in `.pi/extensions/pi-extensions.json` (or `~/.pi/agent/extensions/pi-extensions.json` globally), then use:

```bash
/what
/what 3
```

`/what` is a deterministic extension command. It does not call the LLM.

- `/what` opens a Pi prompt browser UI with numbered, truncated previews
- `/what <number>` opens that full prompt directly from the current session history

If you enable the `checkpoint` module, you also get:

```bash
/checkpoint
/checkpoint --compact
```

`/checkpoint` is implemented by the extension as a Pi-native launcher, so it does not depend on shell-only variables like `$PPID`.
It resolves the current Pi session from extension context (`ctx.sessionManager`) with a filesystem fallback, then sends a structured user message telling Pi to run the workflow from `~/.agents/skills/ag:checkpoint/SKILL.md` while injecting the real Pi session id as the change id and requiring session save/name/purpose output.

If you enable the `e` module, you also get:

```bash
/e [filepath]
```

`/e` opens a file in Neovim, similar to vim's `/e` command:

- `/e filepath` - Opens the specified file
- `/e .` - Opens the current directory
- `/e` - Opens the current directory (default)
- `/e @filepath` - Opens the specified file (same as `filepath`, `@` prefix is optional)

Supports absolute paths, relative paths, and current directory opening.

## Idle watcher (`idle-watch`)

Detects when pi has been in the same session state for too long and fires a cmux notification:

- **working** too long — pi has been churning on a turn for longer than the threshold (stuck tool, runaway loop, slow LLM).
- **idle** too long — pi finished working long ago and no new prompt arrived (user walked away).

Detection uses `ctx.isIdle()` (equivalent to the TUI "Working..." indicator) by default; events (`agent_start`/`agent_end`) are opt-in as a second signal.

### Config

Add an `idle-watch` block to `.pi/extensions/pi-extensions.json` (project) or `~/.pi/agent/extensions/pi-extensions.json` (global):

```json
{
  "extensions": { "idle-watch": true },
  "idle-watch": {
    "enabled": true,
    "tickSeconds": 30,
    "detection": { "events": false, "workingIndicator": true },
    "states": {
      "working": { "enabled": true, "threshold": "10m", "backoff": false },
      "idle":    { "enabled": true, "threshold": "15m", "backoff": false }
    },
    "heartbeat": { "enabled": true, "path": "~/.pi/state/idle-{pid}.json" }
  }
}
```

`backoff` values per state:

- `false` (default) — fire once when threshold crosses, silent until state changes.
- `true` — use default schedule `["5m", "15m", "30m"]`.
- array of duration strings — custom schedule, values are gaps *between* notifications.

### Notification templates

Each state accepts optional `title` and `body` templates. If unset, sensible defaults are used. Available tokens:

- `{state}` — `working` or `idle`
- `{elapsed}` — formatted duration (e.g. `12m30s`)
- `{sessionName}` — result of `pi.getSessionName()` (the `◇ ...` summary line), empty if unset
- `{cwd}` — working directory
- `{pid}` — pi process pid

Example: include the session summary in the body so you can tell sessions apart from the notification alone.

```json
"idle-watch": {
  "states": {
    "working": {
      "title": "⏳ {sessionName}",
      "body":  "working for {elapsed}"
    },
    "idle": {
      "title": "💤 {sessionName}",
      "body":  "idle for {elapsed} — come back?"
    }
  }
}
```

### `/idle` command

All overrides are session-only (wiped on pi restart):

```
/idle                              status + effective config
/idle on | off                     enable / disable this session
/idle working <dur>                override working threshold
/idle idle <dur>                   override idle threshold
/idle backoff on | off             toggle backoff for both states
/idle backoff <state> on|off|<csv> per-state backoff, e.g. /idle backoff working 2m,5m,15m
/idle reset                        clear fire counters
```

### Heartbeat

When `heartbeat.enabled` is true, the module writes `~/.pi/state/idle-{pid}.json` on every transition and tick:

```json
{
  "pid": 12345,
  "session": "zellij-session-or-unknown",
  "cwd": "/path",
  "state": "idle",
  "enteredStateAt": 1735582123000,
  "lastTickAt": 1735582153000,
  "cleanExit": false
}
```

External watchers (cron, fish function, supervisor) can detect a hung pi with the heuristic:

```
now - lastTickAt > tickSeconds * 3  &&  !cleanExit
```

## Notes

- `yu-notify` is your zellij notification module (renamed from zellij-notify), implemented in TypeScript (no Python helper).
- `yu-notify` is hook-driven, not slash-command-driven.
- It notifies only when the agent run stops/returns to idle (waiting for user input), with session/tab context (`[session] tab`).
- It also appends a status icon (emoji/symbol) to the end of the active zellij tab name (without duplicates).
- Bundled support resources are included under `.pi/`:
  - agents
  - themes
  - skills
  - damage-control rules
