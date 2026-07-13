import { expect, test } from "bun:test";

const bedrockAuth = await import("./lib/bedrock-auth.ts").catch(() => ({}));

test("mirrors the Bedrock token into runtime auth", () => {
  const calls: string[][] = [];
  const authStorage = {
    setRuntimeApiKey: (...args: string[]) => calls.push(args),
    removeRuntimeApiKey: () => {},
  };

  expect(typeof bedrockAuth.syncBedrockRuntimeApiKey).toBe("function");
  bedrockAuth.syncBedrockRuntimeApiKey(authStorage, "token");

  expect(calls).toEqual([["amazon-bedrock", "token"]]);
});

test("removes stale Bedrock runtime auth when no token is available", () => {
  const calls: string[] = [];
  const authStorage = {
    setRuntimeApiKey: () => {},
    removeRuntimeApiKey: (provider: string) => calls.push(provider),
  };

  bedrockAuth.syncBedrockRuntimeApiKey(authStorage, undefined);

  expect(calls).toEqual(["amazon-bedrock"]);
});

test("does not expose a Bedrock SSO token bypass", async () => {
  const source = await Bun.file(new URL("./aws.ts", import.meta.url)).text();

  expect(source).not.toContain("BEDROCK_SSO");
  expect(source).not.toContain("token disabled");
});
