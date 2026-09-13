import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareSnapshot, renderSnapshotMarkdown, upsertChangelogEntry, writeSnapshotFile } from "../extensions/modules/snapshot/core.ts";

const root = mkdtempSync(path.join(tmpdir(), "snapshot-"));
const snapshotDir = path.join(root, ".agents", "snapshots");
mkdirSync(snapshotDir, { recursive: true });

const piSnapshot = prepareSnapshot({
  cwd: root,
  session: { id: "pi-session", file: "/sessions/pi.jsonl" },
  name: "snapshot-skill",
  touchedFiles: [],
  resume: "pi --resume pi-session",
});
assert.equal(piSnapshot.snapshotFile, path.join(snapshotDir, "snapshot-skill.md"));
assert.equal(piSnapshot.changelogFile, path.join(root, "CHANGELOG.md"));
assert.throws(() => prepareSnapshot({
  cwd: root,
  session: { id: "pi-session", file: "" },
  name: "not valid",
  touchedFiles: [],
  resume: "pi --resume pi-session",
}));

const existing = path.join(snapshotDir, "existing.md");
writeFileSync(existing, "---\nsession_id: omp-session\n---\n");
const ompSnapshot = prepareSnapshot({
  cwd: root,
  session: { id: "omp-session", file: "/sessions/omp.jsonl" },
  name: "ignored",
  touchedFiles: [],
  resume: "omp --resume omp-session",
});
assert.equal(ompSnapshot.changelogFile, path.join(root, "CHANGELOG.md"));
assert.equal(ompSnapshot.snapshotFile, existing);
assert.equal(ompSnapshot.resume, "omp --resume omp-session");

const content = {
  description: "Test session",
  context: "Worked on snapshot tooling.",
  decisions: ["Use deterministic tools"],
  currentState: ["Tools registered"],
  lessons: [],
  nextSteps: ["Dogfood /snapshot"],
};
const markdown = renderSnapshotMarkdown(piSnapshot, content, "2026-09-13");
for (const expected of ["---", "created: 2026-09-13", `project: ${path.basename(root)}`, "description: Test session", "session_id: pi-session", "resume_with: pi --resume pi-session", "## Context", "## Decisions", "- Use deterministic tools", "## Current State", "- Tools registered", "## Next Steps", "- Dogfood /snapshot"]) {
  assert.ok(markdown.includes(expected), `missing: ${expected}`);
}
assert.equal(markdown.includes("## Lessons"), false, "empty sections must be omitted");
writeSnapshotFile(piSnapshot.snapshotFile, markdown);
assert.equal(readFileSync(piSnapshot.snapshotFile, "utf8").startsWith("---\n"), true);

const changelog = path.join(root, "CHANGELOG.md");
const first = upsertChangelogEntry(changelog, {
  title: "Snapshots persist one root changelog",
  category: "Fixed",
  bullets: ["Sessions no longer scatter changelog notes into the snapshots folder."],
  date: "2026-09-13",
});
assert.equal(first.created, true);
assert.equal(first.addedBullets, 1);
assert.equal(readFileSync(changelog, "utf8"), "# Changelog\n\n## 2026-09-13 Snapshots persist one root changelog\n\n### Fixed\n- Sessions no longer scatter changelog notes into the snapshots folder.\n");

const merged = upsertChangelogEntry(changelog, {
  title: "Snapshots persist one root changelog",
  category: "Fixed",
  bullets: ["Sessions no longer scatter changelog notes into the snapshots folder.", "Agents get one deterministic save tool instead of improvising writes."],
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
  title: "Snapshots persist one root changelog",
  category: "Changed",
  bullets: ["Agents get one deterministic save tool."],
  date: "2026-09-13",
});
assert.equal(changed.addedBullets, 1);
const deduped = upsertChangelogEntry(changelog, {
  title: "Snapshots persist one root changelog",
  category: "Changed",
  bullets: ["Agents get one deterministic save tool."],
  date: "2026-09-13",
});
assert.equal(deduped.addedBullets, 0);
assert.throws(() => upsertChangelogEntry(changelog, { title: "Empty", category: "Notes", bullets: [] }));
console.log("snapshot shared behavior verified");
console.log("snapshot render and changelog upsert verified");

if (process.argv[2] !== "wiring") process.exit(0);

const manifest = JSON.parse(await Bun.file("package.json").text());
const piSkillPath = "./extensions/modules/snapshot/skills";
assert.deepEqual(manifest.pi.skills, [piSkillPath]);
assert.deepEqual(manifest.omp.skills, [piSkillPath]);
assert.equal(await Bun.file("extensions/modules/snapshot/skills/snapshot/SKILL.md").exists(), true);
for (const runtime of ["pi", "omp"]) {
  const module = await Bun.file(`extensions/modules/snapshot/${runtime}.ts`).text();
  assert.ok(module.includes('"resources_discover"') && module.includes('"skills"'), `${runtime} snapshot module must register skill discovery`);
  assert.ok(module.includes('"snapshot_write"'), `${runtime} snapshot module must register snapshot_write`);
  assert.ok(module.includes('"rewind"') && module.includes('"checkpoint"'), `${runtime} snapshot module must block the built-in checkpoint/rewind tools`);
}
assert.equal((await Bun.file("extensions/modules/snapshot/omp.ts").text()).includes("snapshot_prepare"), false, "prepare tool must stay removed");
assert.equal((await Bun.file("extensions/modules/snapshot/pi.ts").text()).includes("snapshot_prepare"), false, "prepare tool must stay removed");
console.log("snapshot runtime wiring verified");
