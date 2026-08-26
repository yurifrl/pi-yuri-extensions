import { existsSync, readFileSync, readdirSync } from "node:fs";
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
    resume: input.resume,
    touchedFiles: input.touchedFiles,
    existing: Boolean(prior),
  };
}
