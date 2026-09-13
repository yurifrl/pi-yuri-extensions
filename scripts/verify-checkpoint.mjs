import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareCheckpoint, renderCheckpointMarkdown, upsertChangelogEntry, writeCheckpointFile } from "../extensions/modules/checkpoint/core.ts";

const root = mkdtempSync(path.join(tmpdir(), "checkpoint-"));
const checkpointDir = path.join(root, ".agents", "checkpoints");
mkdirSync(checkpointDir, { recursive: true });

const piCheckpoint = prepareCheckpoint({
  cwd: root,
  session: { id: "pi-session", file: "/sessions/pi.jsonl" },
  name: "checkpoint-skill",
  touchedFiles: [],
  resume: "pi --resume pi-session",
});
assert.equal(piCheckpoint.checkpointFile, path.join(checkpointDir, "checkpoint-skill.md"));
assert.equal(piCheckpoint.changelogFile, path.join(root, "CHANGELOG.md"));
assert.throws(() => prepareCheckpoint({
  cwd: root,
  session: { id: "pi-session", file: "" },
  name: "not valid",
  touchedFiles: [],
  resume: "pi --resume pi-session",
}));

const existing = path.join(checkpointDir, "existing.md");
writeFileSync(existing, "---\nsession_id: omp-session\n---\n");
const ompCheckpoint = prepareCheckpoint({
  cwd: root,
  session: { id: "omp-session", file: "/sessions/omp.jsonl" },
  name: "ignored",
  touchedFiles: [],
  resume: "omp --resume omp-session",
});
assert.equal(ompCheckpoint.changelogFile, path.join(root, "CHANGELOG.md"));
assert.equal(ompCheckpoint.checkpointFile, existing);
assert.equal(ompCheckpoint.resume, "omp --resume omp-session");

const content = {
  description: "Test session",
  context: "Worked on checkpoint tooling.",
  decisions: ["Use deterministic tools"],
  currentState: ["Tools registered"],
  lessons: [],
  nextSteps: ["Dogfood /checkpoint"],
};
const markdown = renderCheckpointMarkdown(piCheckpoint, content, "2026-09-13");
for (const expected of ["---", "created: 2026-09-13", `project: ${path.basename(root)}`, "description: Test session", "session_id: pi-session", "resume_with: pi --resume pi-session", "## Context", "## Decisions", "- Use deterministic tools", "## Current State", "- Tools registered", "## Next Steps", "- Dogfood /checkpoint"]) {
  assert.ok(markdown.includes(expected), `missing: ${expected}`);
}
assert.equal(markdown.includes("## Lessons"), false, "empty sections must be omitted");
writeCheckpointFile(piCheckpoint.checkpointFile, markdown);
assert.equal(readFileSync(piCheckpoint.checkpointFile, "utf8").startsWith("---\n"), true);

const changelog = path.join(root, "CHANGELOG.md");
const first = upsertChangelogEntry(changelog, {
  title: "Checkpoints persist one root changelog",
  category: "Fixed",
  bullets: ["Sessions no longer scatter changelog notes into the checkpoints folder."],
  date: "2026-09-13",
});
assert.equal(first.created, true);
assert.equal(first.addedBullets, 1);
assert.equal(readFileSync(changelog, "utf8"), "# Changelog\n\n## 2026-09-13 Checkpoints persist one root changelog\n\n### Fixed\n- Sessions no longer scatter changelog notes into the checkpoints folder.\n");

const merged = upsertChangelogEntry(changelog, {
  title: "Checkpoints persist one root changelog",
  category: "Fixed",
  bullets: ["Sessions no longer scatter changelog notes into the checkpoints folder.", "Agents get one deterministic save tool instead of improvising writes."],
  date: "2026-09-13",
});
assert.equal(merged.created, false);
assert.equal(merged.addedBullets, 1);
const older = upsertChangelogEntry(changelog, {
  title: "Older delivered work",
  category: "Added",
  bullets: ["Something shipped earlier."],
  date: "2026-09-01",
});
assert.equal(older.created, true);
const text = readFileSync(changelog, "utf8");
assert.ok(text.indexOf("## 2026-09-13 ") < text.indexOf("## 2026-09-01 "), "newest section must sit above older sections");
const changed = upsertChangelogEntry(changelog, {
  title: "Checkpoints persist one root changelog",
  category: "Changed",
  bullets: ["Agents get one deterministic save tool."],
  date: "2026-09-13",
});
assert.equal(changed.addedBullets, 1);
const deduped = upsertChangelogEntry(changelog, {
  title: "Checkpoints persist one root changelog",
  category: "Changed",
  bullets: ["Agents get one deterministic save tool."],
  date: "2026-09-13",
});
assert.equal(deduped.addedBullets, 0);
assert.throws(() => upsertChangelogEntry(changelog, { title: "Empty", category: "Notes", bullets: [] }));
console.log("checkpoint shared behavior verified");
console.log("checkpoint render and changelog upsert verified");

if (process.argv[2] !== "wiring") process.exit(0);

const manifest = JSON.parse(await Bun.file("package.json").text());
const piSkillPath = "./extensions/modules/checkpoint/skills";
assert.deepEqual(manifest.pi.skills, [piSkillPath]);
assert.deepEqual(manifest.omp.skills, [piSkillPath]);
assert.equal(await Bun.file("extensions/modules/checkpoint/skills/checkpoint/SKILL.md").exists(), true);
console.log("checkpoint runtime wiring verified");
