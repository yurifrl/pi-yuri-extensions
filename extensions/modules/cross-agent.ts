/**
 * Cross-Agent — Load commands, skills, and agents from other AI coding agents
 *
 * Originally adapted from disler/pi-vs-claude-code:extensions/cross-agent.ts
 * (https://github.com/disler/pi-vs-claude-code). Modified for this fork.
 *
 * By default this auto-loads from local .agents, local .claude, and ~/.agents.
 * Additional sources can be allowlisted via config.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { readPiYuConfig } from "./lib/config.ts";

function cyan(s: string): string {
	return `\x1b[38;2;54;249;246m${s}\x1b[39m`;
}
function green(s: string): string {
	return `\x1b[38;2;114;241;184m${s}\x1b[39m`;
}
function yellow(s: string): string {
	return `\x1b[38;2;254;222;93m${s}\x1b[39m`;
}
function dim(s: string): string {
	return `\x1b[38;2;120;100;140m${s}\x1b[39m`;
}

interface Discovered {
	name: string;
	description: string;
	content: string;
}

interface SourceGroup {
	source: string;
	commands: Discovered[];
	skills: string[];
	agents: Discovered[];
	agentsFiles: string[];
}

interface SourceSpec {
	key: string;
	label: string;
	baseDir: string;
	agentsDir?: string;
	scanCommands: boolean;
	scanSkills: boolean;
	scanAgents: boolean;
}

function parseFrontmatter(raw: string): { description: string; body: string; fields: Record<string, string> } {
	const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) return { description: "", body: raw, fields: {} };

	const front = match[1];
	const body = match[2];
	const fields: Record<string, string> = {};
	for (const line of front.split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { description: fields.description || "", body, fields };
}

function expandArgs(template: string, args: string): string {
	const parts = args.split(/\s+/).filter(Boolean);
	let result = template;
	result = result.replace(/\$ARGUMENTS|\$@/g, args);
	for (let i = 0; i < parts.length; i++) {
		result = result.replaceAll(`$${i + 1}`, parts[i]);
	}
	return result;
}

function unique<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}

function safeExistsDir(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function walkEntries(root: string, maxDepth: number): string[] {
	if (!safeExistsDir(root)) return [];
	const results: string[] = [];

	function walk(dir: string, depth: number) {
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = join(dir, entry);
			results.push(fullPath);
			if (depth < maxDepth) {
				try {
					if (statSync(fullPath).isDirectory()) walk(fullPath, depth + 1);
				} catch {}
			}
		}
	}

	walk(root, 0);
	return results;
}

function normalizeCommandName(name: string): string {
	return name.trim().replace(/^['"]+|['"]+$/g, "");
}

function commandNameFromPath(commandsDir: string, filePath: string, _raw: string): string {
	const rel = relative(commandsDir, filePath).replace(/\\/g, "/");
	const withoutExt = rel.replace(/\.md$/, "");
	return normalizeCommandName(withoutExt.replace(/\//g, ":"));
}

function scanCommands(dir: string, maxDepth = 0): Discovered[] {
	const items: Discovered[] = [];

	function walk(currentDir: string, depth: number) {
		let entries: string[] = [];
		try {
			entries = readdirSync(currentDir);
		} catch {
			return;
		}

		for (const entry of entries) {
			const filePath = join(currentDir, entry);
			try {
				const stats = statSync(filePath);
				if (stats.isDirectory()) {
					if (depth < maxDepth) walk(filePath, depth + 1);
					continue;
				}
				if (!stats.isFile()) continue;
				if (!filePath.endsWith(".md")) continue;
				if (filePath.endsWith(".md.bak")) continue;

				const raw = readFileSync(filePath, "utf-8");
				const { description, body } = parseFrontmatter(raw);
				items.push({
					name: commandNameFromPath(dir, filePath, raw),
					description: description || body.split("\n").find((l) => l.trim())?.trim() || "",
					content: body,
				});
			} catch {}
		}
	}

	walk(dir, 0);
	return items;
}

function scanSkills(dir: string, maxDepth = 0): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const entryPath of walkEntries(dir, maxDepth)) {
		try {
			const stats = statSync(entryPath);
			if (!stats.isDirectory()) continue;

			const skillFile = join(entryPath, "SKILL.md");
			if (!existsSync(skillFile) || !statSync(skillFile).isFile()) continue;

			const name = basename(entryPath);
			if (!seen.has(name)) {
				seen.add(name);
				names.push(name);
			}
		} catch {}
	}
	return names;
}

function scanAgents(dir: string, maxDepth = 0): Discovered[] {
	const items: Discovered[] = [];
	for (const filePath of walkEntries(dir, maxDepth)) {
		if (!filePath.endsWith(".md")) continue;
		if (basename(filePath) === "AGENTS.md") continue;
		try {
			if (!statSync(filePath).isFile()) continue;
			const raw = readFileSync(filePath, "utf-8");
			const { fields } = parseFrontmatter(raw);
			items.push({
				name: fields.name || basename(filePath, ".md"),
				description: fields.description || "",
				content: raw,
			});
		} catch {}
	}
	return items;
}

function scanAgentsFiles(baseDir: string): string[] {
	const candidates = [join(baseDir, "AGENTS.md"), join(baseDir, ".agents", "AGENTS.md")];
	return candidates.filter((filePath) => existsSync(filePath));
}

function collectAncestorAgentsSkillDirs(cwd: string, home: string): string[] {
	const dirs: string[] = [];
	const homeResolved = resolve(home);
	let current = resolve(cwd);

	while (true) {
		dirs.push(join(current, ".agents", "skills"));
		const parent = dirname(current);
		if (parent === current) break;
		if (current === homeResolved) break;
		current = parent;
	}

	return unique(dirs);
}

function collectPiCoreLoadedSkillNames(cwd: string, home: string): Set<string> {
	const names = new Set<string>();
	const dirs = [
		join(cwd, ".pi", "skills"),
		...collectAncestorAgentsSkillDirs(cwd, home),
		join(home, ".pi", "agent", "skills"),
		join(home, ".agents", "skills"),
	];

	for (const dir of unique(dirs)) {
		for (const name of scanSkills(dir, 8)) {
			names.add(name);
			names.add(`skill:${name}`);
			names.add(`/skill:${name}`);
		}
	}

	return names;
}

function defaultSources(cwd: string, home: string): SourceSpec[] {
	return [
		{ key: "local-agents", label: ".agents", baseDir: join(cwd, ".agents"), scanCommands: true, scanSkills: true, scanAgents: true },
		{ key: "local-claude", label: ".claude", baseDir: join(cwd, ".claude"), scanCommands: true, scanSkills: true, scanAgents: true },
		{ key: "global-agents", label: "~/.agents", baseDir: join(home, ".agents"), scanCommands: true, scanSkills: true, scanAgents: true },
	];
}

function extraSourcesFromAllowlist(cwd: string, home: string, allowlist: string[]): SourceSpec[] {
	const specs: SourceSpec[] = [];
	for (const item of allowlist) {
		const key = item.trim();
		if (!key) continue;
		if (key === ".claude") continue;
		else if (key === "~/.claude") specs.push({ key, label: "~/.claude", baseDir: join(home, ".claude"), scanCommands: true, scanSkills: true, scanAgents: true });
		else if (key === ".gemini") specs.push({ key, label: ".gemini", baseDir: join(cwd, ".gemini"), scanCommands: true, scanSkills: true, scanAgents: true });
		else if (key === "~/.gemini") specs.push({ key, label: "~/.gemini", baseDir: join(home, ".gemini"), scanCommands: true, scanSkills: true, scanAgents: true });
		else if (key === ".codex") specs.push({ key, label: ".codex", baseDir: join(cwd, ".codex"), scanCommands: true, scanSkills: true, scanAgents: true });
		else if (key === "~/.codex") specs.push({ key, label: "~/.codex", baseDir: join(home, ".codex"), scanCommands: true, scanSkills: true, scanAgents: true });
		else if (key === ".pi/agents") specs.push({ key, label: ".pi/agents", baseDir: join(cwd, ".pi"), agentsDir: join(cwd, ".pi", "agents"), scanCommands: false, scanSkills: false, scanAgents: true });
	}
	return specs;
}

function discoverSourceGroup(spec: SourceSpec, depths: { commands: number; skills: number; agents: number }, excludedSkills: Set<string>, seenCrossAgentSkills: Set<string>, loadedAgentsFiles: string[], loadedAgentsContent: string[]): SourceGroup | null {
	const commands = spec.scanCommands ? scanCommands(join(spec.baseDir, "commands"), depths.commands) : [];
	const skills = spec.scanSkills
		? scanSkills(join(spec.baseDir, "skills"), depths.skills).filter((name) => {
			const variants = [name, `skill:${name}`, `/skill:${name}`];
			if (variants.some((variant) => excludedSkills.has(variant) || seenCrossAgentSkills.has(variant))) return false;
			for (const variant of variants) seenCrossAgentSkills.add(variant);
			return true;
		})
		: [];
	const agents = spec.scanAgents ? scanAgents(spec.agentsDir || join(spec.baseDir, "agents"), depths.agents) : [];
	const agentsFiles = scanAgentsFiles(spec.baseDir);

	for (const filePath of agentsFiles) {
		try {
			loadedAgentsFiles.push(filePath);
			loadedAgentsContent.push(readFileSync(filePath, "utf-8"));
		} catch {}
	}

	if (!commands.length && !skills.length && !agents.length && !agentsFiles.length) return null;
	return { source: spec.label, commands, skills, agents, agentsFiles };
}

function renderNotification(groups: SourceGroup[], home: string): string {
	const contextFiles = groups.flatMap((g) => g.agentsFiles);
	const lines: string[] = [];

	if (contextFiles.length) {
		lines.push(yellow("[Context]"));
		for (const filePath of contextFiles) {
			lines.push(`  ${dim(filePath.replace(home, "~"))}`);
		}
		lines.push("");
	}

	lines.push(yellow("[Cross-agent]"));
	for (const g of groups) {
		const counts: string[] = [];
		if (g.skills.length) counts.push(`${g.skills.length} skill${g.skills.length > 1 ? "s" : ""}`);
		if (g.commands.length) counts.push(`${g.commands.length} command${g.commands.length > 1 ? "s" : ""}`);
		if (g.agents.length) counts.push(`${g.agents.length} agent${g.agents.length > 1 ? "s" : ""}`);

		if (counts.length === 0) continue;
		lines.push(`  ${dim(g.source)}${dim(" — ")}${counts.join(dim(", "))}`);

		if (g.commands.length) {
			lines.push(`    ${dim("commands:")}`);
			for (const cmd of g.commands) lines.push(`      ${yellow("/")}${cyan(cmd.name)}`);
		}
		if (g.skills.length) {
			lines.push(`    ${dim("skills:")}`);
			for (const skill of g.skills) lines.push(`      ${yellow("/skill:")}${cyan(skill)}`);
		}
		if (g.agents.length) {
			lines.push(`    ${dim("agents:")}`);
			for (const agent of g.agents) lines.push(`      ${yellow("@")}${green(agent.name)}`);
		}
	}

	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	let loadedAgentsContent: string[] = [];

	pi.registerFlag("cross-agent-verbose", {
		description: "Print cross-agent discovery details on startup",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (_event, ctx) => {
		const { config } = await readPiYuConfig(ctx.cwd);
		const home = homedir();
		const cwd = ctx.cwd;
		const allowlist = config.crossAgent?.allowlist || [];
		const configVerbose = config.crossAgent?.verbose === true;
		const envVerbose = ["1", "true", "yes", "on"].includes((process.env.PI_CROSS_AGENT_VERBOSE || "").toLowerCase());
		const flagVerbose = pi.getFlag("cross-agent-verbose") === true;
		const shouldPrintStartup = flagVerbose || envVerbose || configVerbose;
		const configuredCommandDepth = config.crossAgent?.recursiveDepth?.commands;
		const configuredSkillDepth = config.crossAgent?.recursiveDepth?.skills;
		const configuredAgentDepth = config.crossAgent?.recursiveDepth?.agents;
		const depths = {
			commands: typeof configuredCommandDepth === "number" && configuredCommandDepth > 0 ? configuredCommandDepth : 4,
			skills: typeof configuredSkillDepth === "number" && configuredSkillDepth >= 0 ? configuredSkillDepth : 1,
			agents: typeof configuredAgentDepth === "number" && configuredAgentDepth >= 0 ? configuredAgentDepth : 1,
		};
		const excludedSkills = collectPiCoreLoadedSkillNames(cwd, home);
		const seenCrossAgentSkills = new Set<string>();
		loadedAgentsContent = [];
		const loadedAgentsFiles: string[] = [];
		const groups: SourceGroup[] = [];
		const specs = [...defaultSources(cwd, home), ...extraSourcesFromAllowlist(cwd, home, allowlist)];

		for (const spec of specs) {
			const group = discoverSourceGroup(spec, depths, excludedSkills, seenCrossAgentSkills, loadedAgentsFiles, loadedAgentsContent);
			if (group) groups.push(group);
		}

		const seenCmds = new Set<string>();
		for (const g of groups) {
			for (const cmd of g.commands) {
				if (seenCmds.has(cmd.name)) continue;
				seenCmds.add(cmd.name);
				pi.registerCommand(cmd.name, {
					description: `[${g.source}] ${cmd.description}`.slice(0, 120),
					handler: async (args) => {
						pi.sendUserMessage(expandArgs(cmd.content, args || ""));
					},
				});
			}
		}

		if (groups.length === 0) return;

		if (shouldPrintStartup && ctx.hasUI) {
			setTimeout(() => {
				ctx.ui.notify(renderNotification(groups, home), "info");
			}, 100);
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (loadedAgentsContent.length === 0) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${loadedAgentsContent.join("\n\n")}`,
		};
	});
}
