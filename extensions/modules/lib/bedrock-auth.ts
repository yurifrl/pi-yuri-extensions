type RuntimeAuthStorage = {
  setRuntimeApiKey(provider: string, apiKey: string): void;
  removeRuntimeApiKey(provider: string): void;
};

export function syncBedrockRuntimeApiKey(authStorage: RuntimeAuthStorage | undefined, token: string | undefined): void {
  if (!authStorage?.setRuntimeApiKey) return;
  if (token) authStorage.setRuntimeApiKey("amazon-bedrock", token);
  else authStorage.removeRuntimeApiKey("amazon-bedrock");
}
