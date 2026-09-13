import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type CheckpointSession = {
  id: string;
  file: string;
};

export type PrepareCheckpointInput = {
  cwd: string;
  session: CheckpointSession;
  name: string;
  touchedFiles: readonly string[];
  resume: string;
  checkpointsDirectory?: string;
};

export type PreparedCheckpoint = {
  cwd: string;
  project: string;
  sessionId: string;
  sessionFile: string;
  checkpointFile: string;
  changelogFile: string;
  resume: string;
  touchedFiles: readonly string[];
  existing: boolean;
};

function existingCheckpoint(directory: string, sessionId: string): string | undefined {
  if (!existsSync(directory)) return undefined;
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(directory, name))
    .find((file) => readFileSync(file, "utf8").includes(`session_id: ${sessionId}`));
}

export function prepareCheckpoint(input: PrepareCheckpointInput): PreparedCheckpoint {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name)) throw new Error(`Checkpoint name must be kebab-case: ${input.name}`);
  const directory = input.checkpointsDirectory ?? path.join(input.cwd, ".agents/checkpoints");
  const prior = existingCheckpoint(directory, input.session.id);
  return {
    cwd: input.cwd,
    project: path.basename(input.cwd),
    sessionId: input.session.id,
    sessionFile: input.session.file,
    checkpointFile: prior ?? path.join(directory, `${input.name}.md`),
    changelogFile: path.join(input.cwd, "CHANGELOG.md"),
    resume: input.resume,
    touchedFiles: input.touchedFiles,
    existing: Boolean(prior),
  };
}

export type CheckpointContent = {
  description: string;
  context: string;
  decisions: readonly string[];
  currentState: readonly string[];
  lessons: readonly string[];
  nextSteps: readonly string[];
};

export type ChangelogCategory = "Added" | "Changed" | "Fixed" | "Deprecated" | "Removed" | "Notes";

export type ChangelogInput = {
  title: string;
  category: ChangelogCategory;
  bullets: readonly string[];
  date?: string;
};

export type ChangelogResult = {
  file: string;
  section: string;
  created: boolean;
  addedBullets: number;
};

function bulletLines(items: readonly string[]): string[] {
  return items.map((item) => `- ${item.trim()}`).filter((line) => line !== "- ");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function renderCheckpointMarkdown(prepared: PreparedCheckpoint, content: CheckpointContent, created: string): string {
  const sections: string[] = [`## Context\n${content.context.trim()}`];
  for (const [heading, items] of [
    ["## Decisions", content.decisions],
    ["## Current State", content.currentState],
    ["## Lessons", content.lessons],
    ["## Next Steps", content.nextSteps],
  ] as const) {
    if (items.length > 0) sections.push(`${heading}\n${bulletLines(items).join("\n")}`);
  }
  return [
    "---",
    `created: ${created}`,
    `project: ${prepared.project}`,
    `description: ${content.description.trim()}`,
    `session_id: ${prepared.sessionId}`,
    `resume_with: ${prepared.resume}`,
    `checkpoint_file: ${prepared.checkpointFile}`,
    "---",
    "",
    sections.join("\n\n"),
    "",
  ].join("\n");
}

export function writeCheckpointFile(file: string, markdown: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, markdown);
}

export function upsertChangelogEntry(file: string, input: ChangelogInput): ChangelogResult {
  const date = input.date ?? today();
  const heading = `## ${date} ${input.title.trim()}`;
  const bullets = [...new Set(bulletLines(input.bullets))];
  if (bullets.length === 0) throw new Error("Changelog entry needs at least one bullet");
  const existed = existsSync(file);
  const lines = existed ? readFileSync(file, "utf8").split("\n") : ["# Changelog", ""];
  const sectionStart = lines.findIndex((line) => line.trim() === heading);
  if (sectionStart === -1) {
    let insertAt = -1;
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^## (\d{4}-\d{2}-\d{2}) /.exec(lines[index]);
      if (match && match[1] <= date) {
        insertAt = index;
        break;
      }
    }
    if (insertAt === -1) {
      if (!lines.some((line) => line.trim() === "# Changelog")) lines.unshift("# Changelog", "");
      insertAt = lines.length;
    }
    if (insertAt > 0 && lines[insertAt - 1].trim() !== "") lines.splice(insertAt, 0, "");
    lines.splice(insertAt, 0, heading, "", `### ${input.category}`, ...bullets, "");
    writeFileSync(file, lines.join("\n"));
    return { file, section: heading, created: true, addedBullets: bullets.length };
  }
  let sectionEnd = lines.findIndex((line, index) => index > sectionStart && /^## /.test(line));
  if (sectionEnd === -1) sectionEnd = lines.length;
  let categoryStart = -1;
  for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
    if (lines[index].trim() === `### ${input.category}`) {
      categoryStart = index;
      break;
    }
  }
  if (categoryStart === -1) {
    let insertAt = sectionEnd;
    while (insertAt > sectionStart + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
    lines.splice(insertAt, 0, `### ${input.category}`, ...bullets);
    writeFileSync(file, lines.join("\n"));
    return { file, section: heading, created: false, addedBullets: bullets.length };
  }
  let categoryEnd = sectionEnd;
  for (let index = categoryStart + 1; index < sectionEnd; index += 1) {
    if (/^### /.test(lines[index])) {
      categoryEnd = index;
      break;
    }
  }
  const existing = new Set<string>();
  for (let index = categoryStart + 1; index < categoryEnd; index += 1) {
    if (/^- /.test(lines[index].trim())) existing.add(lines[index].trim());
  }
  const fresh = bullets.filter((bullet) => !existing.has(bullet));
  if (fresh.length === 0) return { file, section: heading, created: false, addedBullets: 0 };
  let insertAt = categoryEnd;
  while (insertAt > categoryStart + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
  lines.splice(insertAt, 0, ...fresh);
  writeFileSync(file, lines.join("\n"));
  return { file, section: heading, created: false, addedBullets: fresh.length };
}
