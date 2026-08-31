# pi-yuri-extensions

Your personal **pi package hub**.

- Pi-side modules are **toggleable**, OFF by default; OMP-side modules are ON by default
- Pi config: `.pi/extensions/pi-yuri-extensions.json` (project) or `~/.pi/agent/extensions/pi-yuri-extensions.json` (global) — `extensions` map
- OMP config: `~/.omp/agent/extensions/pi-yuri-extensions.json` — `modules` map

## Shared runtime architecture

The package has one feature vocabulary across Pi and OMP: `checkpoint`, `envs`, `editor`, and `session-id`. The filesystem mirrors the integration boundary: `extensions/pi/` contains Pi-only entrypoints, `extensions/omp/` contains OMP-only entrypoints, and `extensions/modules/` owns reusable feature packages.

Checkpoint is the model feature: `extensions/modules/checkpoint/core.ts` is runtime-neutral, `pi.ts` and `omp.ts` translate only their own runtime APIs, and `skills/checkpoint/SKILL.md` is the shared workflow. Pi loads `extensions/pi/index.ts`; OMP loads `extensions/omp/index.ts`.

Configure OMP modules in `~/.omp/agent/extensions/pi-yuri-extensions.json`; omitted modules use the defaults:

```json
{
  "modules": {
    "checkpoint": { "enabled": true },
    "editor": { "enabled": true },
    "envs": { "enabled": true },
    "save": { "enabled": true },
    "working": { "enabled": true, "graceSeconds": 10, "stillAfterSeconds": 45, "debug": false },
    "nudge": { "enabled": true },
    "notifications": {
      "enabled": true,
      "events": {
        "promptedInput": true,
        "dangerousCommand": false,
        "blockedCommand": false,
        "question": true,
        "agentError": false,
        "toolError": false
      }
    }
  }
}
```

### OMP module options

| Module | Key | Default | Meaning |
| --- | --- | --- | --- |
| all | `enabled` | `true` | Master toggle for the module. |
| `working` | `graceSeconds` | `10` | Seconds of silence before the elapsed timer starts. |
| `working` | `stillAfterSeconds` | `45` | Seconds of silence before the label flips to "Still working…". |
| `working` | `debug` | `false` | Log event/timer diagnostics to the omp log. |
| `notifications` | `events.<id>` | per event | Per-event banner on/off. Event ids: `promptedInput`, `dangerousCommand` (yolo only), `blockedCommand`, `question`, `agentError`, `toolError`. |

`nudge`, `envs`, `editor`, and `session-id` take no options. `envs` profile switching is runtime-only via `/envs work|personal|all|status`.

## Install

```bash
npm install
pi install .
```

(or `pi install -l .` for project-local settings)

Pi auto-loads the package entrypoint (registered in `~/.pi/agent/settings.jsonc` → `packages`), which reads the config and dynamically imports each enabled module from `extensions/pi/index.ts`.

On `session_start`, `pi-yuri-extensions` reads config from:

- project: `.pi/extensions/pi-yuri-extensions.json`
- global: `~/.pi/agent/extensions/pi-yuri-extensions.json`
- legacy fallback: `.pi/pi-yuri-extensions.json`

Project config takes precedence over global config when both exist.

## Toggle config

Example:

```json
{
  "extensions": {
    "memwatch": true,
    "git": true,
    "checkpoint": false
  }
}
```


## Available module keys

Pi-side toggles (`extensions` map, all OFF by default):

- `aws`
- `checkpoint`
- `copy-slack`
- `draft`
- `e`
- `git`
- `greetings`
- `helpy`
- `memwatch`
- `session-id`
- `yes`

OMP-side modules (`modules` map, all ON by default):

- `checkpoint`
- `editor`
- `envs`
- `nudge`
- `notifications`
- `save`
- `session-id`
- `working`

## Commands

Use:

```bash
/pi-yuri-extensions
```

It prints current toggle status and config path.

OMP-side commands (loaded by default): `/nudge`, `/notifications`, `/envs`, `/checkpoint`, `/save`.

### `checkpoint` (Pi + OMP)

Enable the `checkpoint` module, then:

```bash
/checkpoint
/checkpoint --compact
```

Implemented as a Pi-native launcher, so it does not depend on shell-only variables like `$PPID`. Its adapter, implementation, and bundled `skills/checkpoint/SKILL.md` workflow live together in `extensions/modules/checkpoint/`; `checkpoint_prepare` resolves session metadata, a reusable checkpoint path, touched files, and runtime-specific resume metadata.

### `e` (Pi)

```bash
/e [filepath]
```

Opens a file in Neovim, similar to vim's `/e` command:

- `/e filepath` — opens the specified file
- `/e .` — opens the current directory
- `/e` — opens the current directory (default)
- `/e @filepath` — same as `filepath`, `@` prefix is optional

Supports absolute paths, relative paths, and current directory opening.

### `envs` (OMP)

```bash
/envs work|personal|all|status
```

Applies `WORK_`/`PERSONAL_`/`ALL_`-prefixed environment variables (stripping the prefix) plus `GENERAL_*` always. `status` shows the active profile and applied variable count.

### `nudge` (OMP)

```bash
/nudge
```

Interrupts a stalled run and queues `continue`.

### `save` (Pi + OMP)

```bash
/save [name] [description="..."]
```

Registers the current session with `cly agent-session` (`cly as save`). Prefills
the session id from the runtime session manager (with a filesystem fallback) and
uses the session summary as the name. Positional text overrides the name;
`description="..."` overrides the description. Fully handled by the extension —
it never sends a message to the agent.

Also applies `$CLY_SESSION_NAME` (set by `cly pi -n NAME`) as the session display
name on `session_start` when it differs from the current name.

### `notifications` (OMP)

```bash
/notifications [<id> on|off | all on|off | test <id>]
```

Bare opens an interactive per-event picker. Fires cmux banners for guardrails prompts/blocks (yolo-gated for risk), AskUserQuestion, run errors, and tool errors.

## Notes

- Bundled support resources are included under `.pi/`:
  - agents
  - themes
  - skills
  - damage-control rules
