# Pi Configuration

## Command Safety Rules

**NEVER run commands that wait for human interaction outside the terminal.** These commands block pi and cause input lag / freezes. Examples:

- `aws sso login` — opens browser and waits for approval. **Tell the user to run it in a separate terminal instead.**
- `open`, `xdg-open` — opens GUI apps that pi can't interact with
- Any command that opens a browser tab and waits for a callback
- Any command that prompts for input on stdin (use `--no-input`, `--yes`, `-y` flags where available)

If a command requires SSO/OAuth token refresh, **stop and tell the user** to refresh it themselves, then retry the original command. Do NOT attempt to run the login flow from within pi.

## Extension Setup

Extensions from this project must be enabled globally in `~/.pi/agent/settings.json` under the `packages` array. Add a local source entry pointing to this repo and use `+`/`!` prefixes to control which extension modules are loaded:

```json
{
  "source": "./extensions/pi-extensions",
  "extensions": [
    "!extensions/modules/*",
    "+extensions/modules/agents-mcp-loader.ts",
    "+extensions/modules/agent-loop.ts"
  ]
}
```

The `!extensions/modules/*` line disables all modules by default, then individual `+` lines opt in specific ones. The main entry point (`extensions/pi-extensions.ts`) and its always-on commands (`/update`, `/pi-extensions`) are loaded automatically.

