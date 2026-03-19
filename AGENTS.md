# Pi Configuration

## Command Safety Rules

**NEVER run commands that wait for human interaction outside the terminal.** These commands block pi and cause input lag / freezes. Examples:

- `aws sso login` — opens browser and waits for approval. **Tell the user to run it in a separate terminal instead.**
- `open`, `xdg-open` — opens GUI apps that pi can't interact with
- Any command that opens a browser tab and waits for a callback
- Any command that prompts for input on stdin (use `--no-input`, `--yes`, `-y` flags where available)

If a command requires SSO/OAuth token refresh, **stop and tell the user** to refresh it themselves, then retry the original command. Do NOT attempt to run the login flow from within pi.

