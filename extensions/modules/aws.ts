import { DynamicBorder, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type PiYuConfig, readPiYuConfig } from "./lib/config.ts";

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

// ── Bedrock API key (bearer token) management ───────────────────────────────
//
// pi's Bedrock provider reads AWS_BEARER_TOKEN_BEDROCK per request. Setting it
// from inside the extension (at session_start, and via `/aws bedrock`) means
// pi uses a dedicated, Bedrock-scoped API key for LLM calls no matter how pi
// was launched — while AWS_PROFILE is left untouched, so every other AWS call
// in the process keeps using the ambient SSO credentials.
//
// The tokens live in a 1Password item with one section per environment
// (production, staging, ...), each holding a *_BEARER_TOKEN_BEDROCK field. A
// profile IS a section name; a top-level DEFAULT field names the default
// section. A small 0600 cache avoids paying `op` latency on every launch.

const BEDROCK_TOKEN_VAR = "AWS_BEARER_TOKEN_BEDROCK";
const BEDROCK_TOKEN_LEAF = "BEARER_TOKEN_BEDROCK"; // suffix shared by all *_BEARER_TOKEN_BEDROCK labels
const BEDROCK_DEFAULT_FIELD = "DEFAULT"; // item field whose value names the default section/profile
const BEDROCK_FALLBACK_PROFILE = "production"; // used only if the DEFAULT field is absent
const BEDROCK_SSO = "sso"; // pseudo-profile: disable the token, fall back to ambient SSO
// Hardcoded /tmp (not os.tmpdir(), which is /var/folders/... on macOS) to match
// the user's existing /tmp/1pass-load-envs convention.
const BEDROCK_CACHE = "/tmp/1pass-load-envs/bedrock.json";

const DEFAULT_BEDROCK_ITEM = "3qbhk522hjhy4dflejwut4fnmu";
const DEFAULT_BEDROCK_VAULT = "m5pemp735fkklqqlymzq6ik6ae";
const DEFAULT_BEDROCK_ACCOUNT = "4IUZXN3PLFCM7H2JTJWWT5KYSQ";

type OpField = { label?: string; value?: string; section?: { label?: string } };
type OpItem = { fields?: OpField[] };
type BedrockCfg = { item: string; vault: string; account: string };
type BedrockCache = { profile: string; token: string };

export default function (pi: ExtensionAPI) {
  // On load (session_start), give pi's Bedrock provider its dedicated API key
  // without an external wrapper. Cache-first, so startup is not blocked.
  bootstrapBedrockToken();

  // Re-apply right before every provider request so the token is guaranteed
  // present even if a request fires before startup injection settles.
  pi.on?.("before_provider_request", () => ensureTokenApplied());

  pi.registerCommand("aws", {
    description: "aws: /aws login [profiles...] | /aws bedrock [prd|stg|sso]",
    getArgumentCompletions: () => [
      {
        value: "login",
        label: "login",
        description: "Run `aws sso login` for configured AWS profiles, focusing the right Chrome profile first",
      },
      {
        value: "bedrock",
        label: "bedrock",
        description: "Switch the Bedrock API key (prd/stg/sso) pi uses for LLM calls; no arg follows the DEFAULT field",
      },
    ],
    handler: async (args, ctx) => {
      const cwd = typeof ctx.cwd === "function" ? ctx.cwd() : ctx.cwd ?? process.cwd();
      const { config } = await readPiYuConfig(cwd);
      const awsCfg = config.awsLogin ?? {};

      const raw = (args ?? "").trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "").toLowerCase();

      if (!sub) {
        ctx.ui.notify?.("aws: usage — /aws login [profile ...] | /aws bedrock [prd|stg|sso]", "info");
        return;
      }
      if (sub === "bedrock") {
        await runBedrockSwitch(parts.slice(1), ctx, config);
        return;
      }
      if (sub !== "login") {
        ctx.ui.notify?.(`aws: unknown subcommand '${sub}'. Try /aws login or /aws bedrock.`, "error");
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

      let widgetInvalidate: (() => void) | undefined;

      ctx.ui.setWidget(
        WIDGET_KEY,
        (_tui, theme) => {
          const container = new Container();
          const borderFn = (s: string) => theme.fg("dim", s);
          container.addChild(new DynamicBorder(borderFn));
          const header = new Text("", 1, 0);
          const body = new Text("", 1, 0);
          container.addChild(header);
          container.addChild(body);
          container.addChild(new DynamicBorder(borderFn));

          return {
            render(width: number): string[] {
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

              return container.render(width);
            },
            invalidate() {
              container.invalidate();
              widgetInvalidate?.();
            },
          };
        },
        { placement: "belowEditor" },
      );

      const refresh = () => {
        // Re-set the widget to force a re-render of current state.
        ctx.ui.invalidate?.();
      };

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

      // Leave the widget up briefly so the final state is visible, then clear.
      await new Promise((r) => setTimeout(r, 1500));
      ctx.ui.setWidget(WIDGET_KEY, undefined);

      if (errors.length > 0) {
        ctx.ui.notify(
          `AWS login finished with errors.\n✅ ${ok.join(", ") || "none"}\n❌ ${errors.join("\n")}`,
          "error",
        );
      } else {
        ctx.ui.notify(`✅ AWS SSO login: ${ok.join(", ")}`, "success");
      }
    },
  });
}

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
      env: {
        ...process.env,
        BROWSER: wrapper,
      },
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
            onStatus(
              `opened in ${browserApp}${chromeProfile ? ` (${chromeProfile})` : ""}, waiting for approval…`,
            );
          }
        }
        if (/Successfully logged into/i.test(line)) {
          onStatus("finalizing…");
        }
      }
    };

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", (d) => {
      errBuffer += d.toString("utf8");
      handleChunk(d);
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("timed out after 5m"));
    }, 300_000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
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

// ── Bedrock helpers ─────────────────────────────────────────────────────────

function bedrockCfg(config: PiYuConfig): BedrockCfg {
  const b = config.bedrock ?? {};
  return {
    item: b.item ?? DEFAULT_BEDROCK_ITEM,
    vault: b.vault ?? DEFAULT_BEDROCK_VAULT,
    account: b.account ?? DEFAULT_BEDROCK_ACCOUNT,
  };
}

// runOp invokes the 1Password CLI and resolves its stdout. Used non-interactively
// (the desktop app session authorizes reads), so it never blocks on a prompt.
function runOp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("op", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `op exit ${code}`))));
  });
}

async function fetchBedrockItem(cfg: BedrockCfg): Promise<OpItem> {
  const raw = await runOp(["item", "get", cfg.item, "--vault", cfg.vault, "--account", cfg.account, "--format", "json"]);
  return JSON.parse(raw) as OpItem;
}

// defaultProfile returns the section named by the item's top-level DEFAULT
// field (e.g. "production"), or the fallback if that field is absent.
function defaultProfile(item: OpItem): string {
  for (const f of item.fields ?? []) {
    if (!f.section && f.label?.toUpperCase() === BEDROCK_DEFAULT_FIELD && f.value) return f.value;
  }
  return BEDROCK_FALLBACK_PROFILE;
}

// bearerTokenFor returns the Bedrock token for a profile, where a profile IS a
// 1Password section name (e.g. "production"). The token is that section's
// *_BEARER_TOKEN_BEDROCK field — matched by suffix so a stray label typo
// (WS_... vs AWS_...) still resolves.
function bearerTokenFor(item: OpItem, profile: string): string | null {
  for (const f of item.fields ?? []) {
    if (
      f.section?.label?.toLowerCase() === profile.toLowerCase() &&
      f.label?.toUpperCase().endsWith(BEDROCK_TOKEN_LEAF) &&
      f.value
    ) {
      return f.value;
    }
  }
  return null;
}

// resolveToken fetches the item and returns the token for a profile. An empty
// profile (or "default") follows the DEFAULT field.
async function resolveToken(profile: string, cfg: BedrockCfg): Promise<BedrockCache> {
  const item = await fetchBedrockItem(cfg);
  let key = profile;
  if (!key || key.toLowerCase() === "default") key = defaultProfile(item);
  const token = bearerTokenFor(item, key);
  if (!token) throw new Error(`profile "${key}": no ${BEDROCK_TOKEN_VAR} field in 1Password item`);
  return { profile: key, token };
}

function readCache(): BedrockCache | null {
  try {
    const c = JSON.parse(readFileSync(BEDROCK_CACHE, "utf8")) as BedrockCache;
    if (c && typeof c.profile === "string" && typeof c.token === "string") return c;
  } catch {
    // missing/corrupt cache -> treat as cold
  }
  return null;
}

function writeCache(c: BedrockCache): void {
  try {
    mkdirSync(path.dirname(BEDROCK_CACHE), { recursive: true, mode: 0o700 });
    writeFileSync(BEDROCK_CACHE, JSON.stringify(c), { mode: 0o600 });
  } catch {
    // best effort; a failed cache write just means the next launch re-fetches
  }
}

// applyToken sets or clears AWS_BEARER_TOKEN_BEDROCK in this process so pi's
// Bedrock provider picks it up. Never touches AWS_PROFILE.
function applyToken(token: string | null): void {
  if (token) process.env[BEDROCK_TOKEN_VAR] = token;
  else delete process.env[BEDROCK_TOKEN_VAR];
}

// In-memory token: undefined = not loaded, null = disabled (sso/none), string = active.
let bedrockToken: string | null | undefined;

// ensureTokenApplied makes process.env reflect the current token. On first call
// it loads from the cache (sync). Cheap and idempotent — safe to call before
// every provider request, which defeats any extension-load race (pi reads
// AWS_BEARER_TOKEN_BEDROCK per request, so this guarantees it is set in time).
function ensureTokenApplied(): void {
  if (bedrockToken === undefined) {
    const c = readCache();
    bedrockToken = c ? c.token || null : null;
  }
  applyToken(bedrockToken);
}

// bootstrapBedrockToken runs at extension load: apply the cached token instantly
// (sso/empty => leave unset), or on a cold cache fetch the DEFAULT profile in
// the background without blocking startup.
function bootstrapBedrockToken(): void {
  const cached = readCache();
  if (cached) {
    bedrockToken = cached.token || null;
    applyToken(bedrockToken);
    return;
  }
  void resolveToken("", bedrockCfg({}))
    .then((c) => {
      bedrockToken = c.token;
      applyToken(bedrockToken);
      writeCache(c);
    })
    .catch(() => {
      // no token available -> pi falls back to the ambient credential chain
    });
}

// runBedrockSwitch handles `/aws bedrock [profile]`: re-resolve from 1Password,
// update this process's env + the cache, and report the active profile.
async function runBedrockSwitch(args: string[], ctx: any, config: PiYuConfig): Promise<void> {
  const profile = (args[0] ?? "").trim();
  if (profile.toLowerCase() === BEDROCK_SSO) {
    bedrockToken = null;
    applyToken(null);
    writeCache({ profile: BEDROCK_SSO, token: "" });
    ctx.ui.notify?.("aws bedrock: token disabled — Bedrock uses ambient SSO", "info");
    return;
  }
  try {
    const c = await resolveToken(profile, bedrockCfg(config));
    bedrockToken = c.token;
    applyToken(c.token);
    writeCache(c);
    ctx.ui.notify?.(`aws bedrock: using ${c.profile} token (AWS_BEARER_TOKEN_BEDROCK set)`, "success");
  } catch (e) {
    ctx.ui.notify?.(`aws bedrock: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}
