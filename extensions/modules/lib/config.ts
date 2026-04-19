import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";

export const PI_YU_CONFIG_FILENAME = "pi-extensions.json";

export type PiYuConfig = {
	extensions?: Record<string, boolean>;
	crossAgent?: {
		allowlist?: string[];
		recursiveDepth?: {
			skills?: number;
			agents?: number;
			commands?: number;
		};
	};
};

function uniquePaths(paths: string[]): string[] {
	return Array.from(new Set(paths));
}

export function getPiYuConfigCandidates(cwd: string): string[] {
	const home = homedir();
	return uniquePaths([
		path.join(cwd, ".pi", "extensions", PI_YU_CONFIG_FILENAME),
		path.join(home, ".pi", "agent", "extensions", PI_YU_CONFIG_FILENAME),
		path.join(cwd, ".pi", PI_YU_CONFIG_FILENAME),
		path.join(home, ".pi", PI_YU_CONFIG_FILENAME),
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

	return path.join(homedir(), ".pi", "agent", "extensions", PI_YU_CONFIG_FILENAME);
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
