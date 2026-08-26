# pi-yuri-extensions

Your personal **pi package hub**.

- Main extension name: **pi-yuri-extensions**
- All bundled extensions are **toggleable**
- All toggles are **OFF by default**
- Enable/disable modules in config: `.pi/extensions/pi-yuri-extensions.json` (project) or `~/.pi/agent/extensions/pi-yuri-extensions.json` (global)

## Shared runtime architecture

The package has one feature vocabulary across Pi and OMP: `checkpoint`, `envs`, `editor`, and `session-id`. The filesystem mirrors the integration boundary: `extensions/pi/` contains Pi-only entrypoints, `extensions/omp/` contains OMP-only entrypoints, and `extensions/modules/` owns reusable feature packages.

Checkpoint is the model feature: `extensions/modules/checkpoint/core.ts` is runtime-neutral, `pi.ts` and `omp.ts` translate only their own runtime APIs, and `skills/checkpoint/SKILL.md` is the shared workflow. Pi loads `extensions/pi/index.ts`; OMP loads `extensions/omp/index.ts`.

Configure OMP modules in `~/.omp/agent/extensions/pi-yuri-extensions.json`; omitted modules use the defaults:

```json
{
  "modules": {
    "checkpoint": { "enabled": true },
    "editor": { "enabled": false }
  }
}
```

## Install

```bash
npm install
pi install .
```

(or `pi install -l .` for project-local settings)

## How toggles work

Only `extensions/pi-yuri-extensions.ts` is auto-loaded by pi.

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

Any omitted key defaults to `false`.

## Available module keys

- `checkpoint`
- `cross-agent`
- `e`
- `greetings`
- `git`
- `memwatch`
- `pi-beads`
- `aws`
- `copy-slack`
- `draft`
- `session-id`
- `helpy`
- `yes`

## Commands

Use:

```bash
/pi-yuri-extensions
```

It prints current toggle status and config path.

Enable the `what` module in `.pi/extensions/pi-yuri-extensions.json` (or `~/.pi/agent/extensions/pi-yuri-extensions.json` globally), then use:

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

`/checkpoint` is implemented by the extension as a Pi-native launcher, so it does not depend on shell-only variables like `$PPID`. Its adapter, implementation, and bundled `skills/checkpoint/SKILL.md` workflow live together in `extensions/modules/checkpoint/`; `checkpoint_prepare` resolves session metadata, a reusable checkpoint path, touched files, and runtime-specific resume metadata.


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

## Notes

- Bundled support resources are included under `.pi/`:
  - agents
  - themes
  - skills
  - damage-control rules
