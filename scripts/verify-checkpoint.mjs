import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareCheckpoint } from "../extensions/modules/checkpoint/core.ts";

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
assert.equal(ompCheckpoint.checkpointFile, existing);
assert.equal(ompCheckpoint.resume, "omp --resume omp-session");
console.log("checkpoint shared behavior verified");

if (process.argv[2] !== "wiring") process.exit(0);

const manifest = JSON.parse(await Bun.file("package.json").text());
const piSkillPath = "./extensions/modules/checkpoint/skills";
assert.deepEqual(manifest.pi.skills, [piSkillPath]);
assert.deepEqual(manifest.omp.skills, [piSkillPath]);
assert.equal(await Bun.file("extensions/modules/checkpoint/skills/checkpoint/SKILL.md").exists(), true);
console.log("checkpoint runtime wiring verified");
