// models: dynamic model discovery for OpenAI-compatible providers.
//
// Instead of hand-listing models in models.json, configure a provider once
// (url + credentials + api) under `modelProviders` in pi-extensions.json, and
// this extension scrapes its `/models` endpoint at startup and registers every
// model it finds (optionally filtered by a regex on the model id).
//
// This is a TOP-LEVEL extension (listed in package.json `pi.extensions`), not a
// toggle module, because pi only awaits the extension *factory* before startup
// — so dynamic registration is available to interactive startup and to
// `pi --list-models`. (Toggle modules load on session_start, which is too late.)
//
// Example pi-extensions.json:
//   "modelProviders": [
//     {
//       "name": "bedrock-mantle",
//       "baseUrl": "https://bedrock-mantle.us-east-1.api.aws/v1",
//       "api": "openai-completions",
//       "apiKey": "!op read op://Private/bedrock-envs/production/AWS_BEARER_TOKEN_BEDROCK",
//       "authHeader": true,
//       "filter": "",                 // regex on model id; empty = all
//       "reasoningFilter": "kimi|glm|gpt-5|qwen3|claude|deepseek|minimax",
//       "defaults": { "contextWindow": 262144, "maxTokens": 32000, "input": ["text"] }
//     }
//   ]

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

type ModelInput = "text" | "image";
type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number };

type ModelDefaults = {
  reasoning?: boolean;
  input?: ModelInput[];
  cost?: Cost;
  contextWindow?: number;
  maxTokens?: number;
};

type ProviderSpec = {
  name: string;
  baseUrl: string;
  api?: string; // default openai-completions
  apiKey?: string; // !command / $ENV / literal — same syntax as models.json
  authHeader?: boolean; // default true (Authorization: Bearer)
  headers?: Record<string, string>;
  filter?: string; // regex: model id must match to be included (default: all)
  reasoningFilter?: string; // regex: matching ids get reasoning:true
  modelsPath?: string; // default "/models"
  defaults?: ModelDefaults;
  cacheTtlSeconds?: number; // how long to reuse the cached discovery (default 12h)
};

const ZERO_COST: Cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Discovery cache. Avoids hitting `op` / the network on every pi startup — the
// reason 1Password prompts each launch. Stores, per provider, the resolved key
// and discovered models, refreshed only when older than the TTL (or on a cold
// cache). 0600 because it holds resolved credentials.
const CACHE_PATH = "/tmp/1pass-load-envs/models-cache.json";
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

type CacheEntry = { ts: number; apiKey: string; models: unknown[] };

function readCacheAll(): Record<string, CacheEntry> {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

function writeCacheEntry(name: string, entry: CacheEntry): void {
  try {
    const all = readCacheAll();
    all[name] = entry;
    mkdirSync(path.dirname(CACHE_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(CACHE_PATH, JSON.stringify(all), { mode: 0o600 });
  } catch {
    // a failed cache write just means the next launch re-discovers
  }
}

// resolveConfigValue mirrors pi's config-value syntax: a leading "!" runs the
// rest as a shell command and uses stdout; "$VAR"/"${VAR}" interpolate env;
// otherwise the value is literal. Used to obtain the key for the /models fetch.
function resolveConfigValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("!")) {
    const shell = process.env.SHELL || "/bin/sh";
    const r = spawnSync(shell, ["-c", value.slice(1)], { encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`apiKey command failed: ${value.slice(1)}: ${(r.stderr || "").trim()}`);
    }
    return r.stdout.trim();
  }
  return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a, b) => process.env[a || b] ?? "");
}

function loadSpecs(): ProviderSpec[] {
  const candidates = [
    path.join(process.cwd(), ".pi", "extensions", "pi-extensions.json"),
    path.join(homedir(), ".pi", "agent", "extensions", "pi-extensions.json"),
    path.join(process.cwd(), ".pi", "pi-extensions.json"),
    path.join(homedir(), ".pi", "pi-extensions.json"),
  ];
  for (const c of candidates) {
    try {
      const cfg = JSON.parse(readFileSync(c, "utf8"));
      if (Array.isArray(cfg.modelProviders)) return cfg.modelProviders as ProviderSpec[];
    } catch {
      // keep looking
    }
  }
  return [];
}

type RawModel = {
  id?: string;
  status?: string;
  context_window?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_tokens?: number;
};

async function fetchModels(spec: ProviderSpec, key: string | undefined) {
  const url = spec.baseUrl.replace(/\/+$/, "") + (spec.modelsPath ?? "/models");
  const headers: Record<string, string> = { ...(spec.headers ?? {}) };
  // The /models endpoint itself needs auth (independent of how chat requests
  // are authed — that's spec.authHeader, passed to registerProvider below).
  if (key) headers["Authorization"] = `Bearer ${key}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  const payload = (await res.json()) as { data?: RawModel[] };

  const idRe = spec.filter ? new RegExp(spec.filter) : null;
  const reasoningRe = spec.reasoningFilter ? new RegExp(spec.reasoningFilter) : null;
  const d = spec.defaults ?? {};

  return (payload.data ?? [])
    .filter((m) => typeof m.id === "string" && m.id.length > 0)
    .filter((m) => !m.status || m.status === "available")
    .filter((m) => !idRe || idRe.test(m.id!))
    .map((m) => ({
      id: m.id!,
      name: m.id!,
      reasoning: reasoningRe ? reasoningRe.test(m.id!) : (d.reasoning ?? false),
      input: d.input ?? ["text"],
      cost: d.cost ?? ZERO_COST,
      // Prefer real per-model limits from /models; fall back to configured defaults.
      contextWindow: m.max_input_tokens ?? m.context_window ?? d.contextWindow ?? 128000,
      maxTokens: m.max_output_tokens ?? m.max_tokens ?? d.maxTokens ?? 4096,
    }));
}

// resolveProvider returns the key + models to register, using the cache when
// fresh (no `op`, no network) and otherwise re-discovering. On a failed refresh
// it falls back to a stale cache rather than dropping the provider.
async function resolveProvider(spec: ProviderSpec): Promise<{ apiKey: string; models: unknown[] } | null> {
  const cached = readCacheAll()[spec.name];
  const ttlMs = (spec.cacheTtlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
  if (cached && Date.now() - cached.ts < ttlMs) {
    return { apiKey: cached.apiKey, models: cached.models };
  }
  try {
    const key = resolveConfigValue(spec.apiKey) ?? "";
    const models = await fetchModels(spec, key);
    if (models.length === 0) throw new Error(`no models matched (filter: ${spec.filter ?? "<all>"})`);
    writeCacheEntry(spec.name, { ts: Date.now(), apiKey: key, models });
    return { apiKey: key, models };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (cached) {
      console.error(`[models] ${spec.name}: refresh failed (${msg}); using stale cache`);
      return { apiKey: cached.apiKey, models: cached.models };
    }
    console.error(`[models] ${spec.name}: ${msg}`);
    return null;
  }
}

export default async function (pi: ExtensionAPI) {
  for (const spec of loadSpecs()) {
    if (!spec?.name || !spec?.baseUrl) continue;
    const resolved = await resolveProvider(spec);
    if (!resolved) continue;
    // Register with the already-resolved key (literal) so pi never re-runs the
    // `!op read` per request either — credentials are fetched only on refresh.
    pi.registerProvider(spec.name, {
      name: spec.name,
      baseUrl: spec.baseUrl,
      api: spec.api ?? "openai-completions",
      apiKey: resolved.apiKey,
      authHeader: spec.authHeader ?? true,
      headers: spec.headers,
      models: resolved.models,
    });
  }
}
