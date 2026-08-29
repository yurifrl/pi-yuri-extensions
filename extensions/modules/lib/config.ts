import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";

export const CONFIG_FILENAME = "pi-yuri-extensions.json";

export type PiYuConfig = {
	extensions?: Record<string, boolean>;
	crossAgent?: {
		allowlist?: string[];
		verbose?: boolean;
		agents?: { enabled?: boolean };
		"claude-code"?: { enabled?: boolean };
		recursiveDepth?: {
			skills?: number;
			agents?: number;
			commands?: number;
		};
	};
	awsLogin?: {
		profiles?: string[];
		chromeProfiles?: Record<string, string>;
		defaultChromeProfile?: string;
		browserApp?: string;
	};
	envs?: {
		/** Set to false to disable env sourcing (default: true). */
		enabled?: boolean;
		/** Active profile on startup: "work" | "personal" | "all" (default: "all"). */
		defaultProfile?: string;
	};
	bedrock?: {
		enabled?: boolean;
		/** 1Password item path: "vault/item" (names, not IDs). */
		opItem?: string;
		/** 1Password account id (shorthand or UUID). */
		account?: string;
	};
	memwatch?: {
		intervalMinutes?: number;
		warnMB?: number;
		criticalMB?: number;
	};
};

function uniquePaths(paths: string[]): string[] {
	return Array.from(new Set(paths));
}

export function getPiYuConfigCandidates(cwd: string): string[] {
	const home = homedir();
	return uniquePaths([
		path.join(cwd, ".pi", "extensions", CONFIG_FILENAME),
		path.join(home, ".pi", "agent", "extensions", CONFIG_FILENAME),
		path.join(cwd, ".pi", CONFIG_FILENAME),
		path.join(home, ".pi", CONFIG_FILENAME),
	]);
}

export async function resolvePiYuConfigPath(cwd: string): Promise<string> {
	for (const candidate of getPiYuConfigCandidates(cwd)) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// keep looking
		}
	}

	return path.join(homedir(), ".pi", "agent", "extensions", CONFIG_FILENAME);
}

export async function readPiYuConfigFile(cwd: string): Promise<{ configPath: string; content?: string }> {
	const configPath = await resolvePiYuConfigPath(cwd);

	try {
		return {
			configPath,
			content: await readFile(configPath, "utf8"),
		};
	} catch {
		return { configPath };
	}
}

export async function readPiYuConfig(cwd: string): Promise<{ configPath: string; config: PiYuConfig }> {
	const { configPath, content } = await readPiYuConfigFile(cwd);
	if (!content) return { configPath, config: {} };

	try {
		return { configPath, config: JSON.parse(content) as PiYuConfig };
	} catch {
		return { configPath, config: {} };
	}
}
