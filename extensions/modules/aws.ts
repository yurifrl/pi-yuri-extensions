import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPiYuConfig } from "./lib/config.ts";
import { readOmpAwsLogin } from "../omp/awsLoginConfig.ts";

/**
 * awsLogin config resolution:
 *   Pi side — `awsLogin` block in pi-yuri-extensions.json (existing behavior).
 *   OMP side — `modules.aws` block in ~/.omp/agent/extensions/pi-yuri-extensions.json,
 *              falling back to the pi global config's `awsLogin` block.
 */
async function loadAwsLogin(cwd: string): Promise<AwsLoginConfig> {
  const { config } = await readPiYuConfig(cwd);
  const fromPi = config.awsLogin;
  if (fromPi && (fromPi.profiles?.length ?? 0) > 0) return fromPi;
  return readOmpAwsLogin() ?? fromPi ?? {};
}

type AwsLoginConfig = {
  profiles?: string[];
  chromeProfiles?: Record<string, string>;
  defaultChromeProfile?: string;
  browserApp?: string;
};


type State = "pending" | "focus" | "running" | "ok" | "error";
type Row = { profile: string; chrome?: string; state: State; detail?: string; elapsedMs?: number };

const DEFAULT_BROWSER_APP = "Google Chrome";
const WIDGET_KEY = "aws-login";

const GLYPH: Record<State, string> = {
  pending: "○",
  focus: "🪟",
  running: "⟳",
  ok: "✓",
  error: "✕",
};

const STATE_COLOR: Record<State, "dim" | "accent" | "warning" | "success" | "error"> = {
  pending: "dim",
  focus: "accent",
  running: "accent",
  ok: "success",
  error: "error",
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("aws", {
    description: "aws: /aws login [profiles...]",
    getArgumentCompletions: () => [
      {
        value: "login",
        label: "login",
        description: "Run `aws sso login` for configured AWS profiles",
      },
    ],
    handler: async (args, ctx) => {
      const awsCfg = await loadAwsLogin(ctx.cwd ?? process.cwd());

      const raw = (args ?? "").trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "").toLowerCase();

      if (!sub || sub !== "login") {
        ctx.ui.notify?.("aws: usage — /aws login [profiles...]", "info");
        return;
      }

      const profileArgs = parts.slice(1);
      const profiles = profileArgs.length > 0 ? profileArgs : awsCfg.profiles ?? [];

      if (profiles.length === 0) {
        ctx.ui.notify?.("aws: no profiles configured (set awsLogin.profiles or pass profiles)", "error");
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        return;
      }

      const chromeProfiles = awsCfg.chromeProfiles ?? {};
      const defaultChrome = awsCfg.defaultChromeProfile;
      const browserApp = awsCfg.browserApp ?? DEFAULT_BROWSER_APP;

      const rows: Row[] = profiles.map((p) => ({
        profile: p,
        chrome: chromeProfiles[p] ?? defaultChrome,
        state: "pending",
      }));

      ctx.ui.setWidget(
        WIDGET_KEY,
        (_tui, theme) => {
          const container = new Container();
          const header = new Text("", 1, 0);
          const body = new Text("", 1, 0);
          container.addChild(header);
          container.addChild(body);

          return {
            render(width: number): string[] {
              const rule = theme.fg("dim", "─".repeat(Math.max(width, 4)));
              const title =
                theme.fg("accent", "☁ AWS Login  ") +
                theme.fg("dim", `· ${browserApp}`);
              header.setText(truncateToWidth(title, width - 4));

              const lines = rows.map((r) => {
                const color = STATE_COLOR[r.state];
                const glyph = theme.fg(color, GLYPH[r.state]);
                const name = theme.fg(color, r.profile.padEnd(10));
                const chrome = theme.fg("dim", r.chrome ? `[${r.chrome}]` : "");
                const detail = r.detail ? "  " + theme.fg("dim", r.detail) : "";
                const elapsed =
                  r.elapsedMs !== undefined ? "  " + theme.fg("dim", `${(r.elapsedMs / 1000).toFixed(1)}s`) : "";
                return truncateToWidth(`${glyph} ${name} ${chrome}${detail}${elapsed}`, width - 4);
              });
              body.setText(lines.join("\n"));

              return [rule, ...container.render(width), rule];
            },
            invalidate() {
              container.invalidate();
            },
          };
        },
        { placement: "belowEditor" },
      );

      const refresh = () => { (ctx.ui as { requestRender?: () => void }).requestRender?.(); };
      const errors: string[] = [];
      const ok: string[] = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        row.state = "running";
        row.detail = "requesting SSO url…";
        refresh();
        const t0 = Date.now();

        try {
          await runAwsSsoLogin(row.profile, row.chrome, browserApp, (detail) => {
            row.detail = detail;
            refresh();
          });
          row.elapsedMs = Date.now() - t0;
          row.state = "ok";
          row.detail = "logged in";
          ok.push(row.profile);
        } catch (err: unknown) {
          row.elapsedMs = Date.now() - t0;
          row.state = "error";
          row.detail = err instanceof Error ? err.message : String(err);
          errors.push(`${row.profile}: ${row.detail}`);
        }
        refresh();
      }

      await new Promise((r) => setTimeout(r, 1500));
      ctx.ui.setWidget(WIDGET_KEY, undefined);

      if (errors.length > 0) {
        ctx.ui.notify(
          `AWS login finished with errors.\n✅ ${ok.join(", ") || "none"}\n❌ ${errors.join("\n")}`,
          "error",
        );
      } else {
        ctx.ui.notify(`✅ AWS SSO login: ${ok.join(", ")}`, "info");
      }
    },
  });
}

// ── SSO login helpers ───────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/\S+/;

function writeBrowserWrapper(browserApp: string, chromeProfile: string | undefined): string {
  const dir = mkdtempSync(path.join(tmpdir(), "aws-login-browser-"));
  const script = path.join(dir, "open-chrome.sh");
  const profileArg = chromeProfile ? `--profile-directory="${chromeProfile}"` : "";
  const body = `#!/bin/sh\nexec /usr/bin/open -na "${browserApp}" --args ${profileArg} "$1"\n`;
  writeFileSync(script, body, "utf8");
  chmodSync(script, 0o755);
  return script;
}

function runAwsSsoLogin(
  profile: string,
  chromeProfile: string | undefined,
  browserApp: string,
  onStatus: (detail: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const wrapper = writeBrowserWrapper(browserApp, chromeProfile);

    const child = spawn("aws", ["sso", "login", "--profile", profile], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BROWSER: wrapper },
    });

    let buffer = "";
    let errBuffer = "";
    let sawUrl = false;

    const handleChunk = (data: Buffer) => {
      buffer += data.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!sawUrl) {
          const match = line.match(URL_REGEX);
          if (match && match[0].includes("oidc")) {
            sawUrl = true;
            onStatus(`opened in ${browserApp}${chromeProfile ? ` (${chromeProfile})` : ""}, waiting for approval…`);
          }
        }
        if (/Successfully logged into/i.test(line)) onStatus("finalizing…");
      }
    };

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", (d) => { errBuffer += d.toString("utf8"); handleChunk(d); });

    const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("timed out after 5m")); }, 300_000);

    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else {
        const msg = (errBuffer || buffer || "").trim().split("\n").pop() || `exit ${code}`;
        reject(new Error(msg));
      }
    });
  });
}
