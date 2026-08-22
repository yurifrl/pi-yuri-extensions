type RuntimeAuthStorage = {
  setRuntimeApiKey(provider: string, apiKey: string): void;
  removeRuntimeApiKey(provider: string): void;
};

export type ProviderKeyMapping = { envVar: string; provider: string };

/** Well-known env vars that map to pi provider runtime API keys. */
export const PROVIDER_KEY_MAPPINGS: ProviderKeyMapping[] = [
  { envVar: "AWS_BEARER_TOKEN_BEDROCK", provider: "amazon-bedrock" },
  { envVar: "AWS_BEARER_TOKEN_BEDROCK_MANTLE", provider: "amazon-bedrock" },
  { envVar: "OPENAI_API_KEY", provider: "openai" },
  { envVar: "GEMINI_API_KEY", provider: "google" },
  { envVar: "DEEPSEEK_API_KEY", provider: "deepseek" },
  { envVar: "OPENROUTER_API_KEY", provider: "openrouter" },
  { envVar: "CEREBRAS_API_KEY", provider: "cerebras" },
  { envVar: "NVIDIA_API_KEY", provider: "nvidia" },
];

/** Sync all known provider keys from a vars map into pi's runtime auth. */
export function syncProviderKeys(authStorage: RuntimeAuthStorage | undefined, vars: Record<string, string>): void {
  if (!authStorage?.setRuntimeApiKey) return;
  for (const { envVar, provider } of PROVIDER_KEY_MAPPINGS) {
    const val = vars[envVar];
    if (val) authStorage.setRuntimeApiKey(provider, val);
  }
}

/** Legacy single-key sync (kept for backward compat). */
export function syncBedrockRuntimeApiKey(authStorage: RuntimeAuthStorage | undefined, token: string | undefined): void {
  if (!authStorage?.setRuntimeApiKey) return;
  if (token) authStorage.setRuntimeApiKey("amazon-bedrock", token);
  else authStorage.removeRuntimeApiKey("amazon-bedrock");
}
