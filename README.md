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
- `minimal`
- `pi-pi`
- `yu-notify`
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
