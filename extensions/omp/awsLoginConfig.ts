import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * OMP-side awsLogin config for the shared aws module.
 *
 * Priority:
 *   1. `modules.aws` block in ~/.omp/agent/extensions/pi-yuri-extensions.json
 *   2. `awsLogin` block in ~/.pi/agent/extensions/pi-yuri-extensions.json
 *      (the same block the pi side reads, so both runtimes share one source)
 */

export type AwsLoginConfig = {
  profiles?: string[];
  chromeProfiles?: Record<string, string>;
  defaultChromeProfile?: string;
  browserApp?: string;
};

const OMP_CONFIG_PATH = path.join(homedir(), ".omp", "agent", "extensions", "pi-yuri-extensions.json");
const PI_GLOBAL_CONFIG_PATH = path.join(homedir(), ".pi", "agent", "extensions", "pi-yuri-extensions.json");

function normalize(raw: unknown): AwsLoginConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: AwsLoginConfig = {};
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.profiles) && obj.profiles.every((p) => typeof p === "string")) {
    out.profiles = obj.profiles as string[];
  }
  if (typeof obj.chromeProfiles === "object" && obj.chromeProfiles !== null) {
    const cp: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.chromeProfiles as Record<string, unknown>)) {
      if (typeof v === "string") cp[k] = v;
    }
    out.chromeProfiles = cp;
  }
  if (typeof obj.defaultChromeProfile === "string") out.defaultChromeProfile = obj.defaultChromeProfile;
  if (typeof obj.browserApp === "string") out.browserApp = obj.browserApp;
  return out;
}

function readJson(pathname: string): unknown {
  if (!existsSync(pathname)) return undefined;
  try {
    return JSON.parse(readFileSync(pathname, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function readOmpAwsLogin(): AwsLoginConfig | undefined {
  const omp = normalize(readJson(OMP_CONFIG_PATH));
  if (omp && (omp.profiles?.length ?? 0) > 0) return omp;
  const pi = normalize(readJson(PI_GLOBAL_CONFIG_PATH));
  return pi && (pi.profiles?.length ?? 0) > 0 ? pi : omp ?? pi;
}
