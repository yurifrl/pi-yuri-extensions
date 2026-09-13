---
name: checkpoint
description: "Save durable, AI-readable session context and a truthful changelog entry."
---
# Checkpoint

Use this command to preserve the session for a later agent in either Pi or OMP. Optional command guidance is extra context, not a directive to expand scope.

1. Derive a concise kebab-case checkpoint name and one-sentence session description.
2. Call `checkpoint_prepare`.
3. Write or update the returned `checkpointFile` with YAML frontmatter:
   - `created`
   - `project`
   - `description`
   - `session_id`
   - `resume_with`
   - `checkpoint_file`
4. Follow the frontmatter with concise sections: Context, Decisions, Current State, Lessons, and Next Steps.
5. Maintain the root `CHANGELOG.md` per the contract below.
6. Print a self-contained current-state summary and short chronological timeline.

A checkpoint is working memory, not a transcript. Retain decisions, constraints, evidence, and open work needed to resume safely. Do not create additional workflows or exit the current agent runtime.

## CHANGELOG.md contract

The changelog lives at the repo root — the exact `changelogFile` path returned by `checkpoint_prepare` (e.g. `<repo>/CHANGELOG.md`). Never create or edit a `CHANGELOG.md` inside the checkpoints folder (`.agents/checkpoints/`) or any other nested directory; checkpoint files never contain changelog entries. If the file does not exist, create it with the `# Changelog` heading.

Template — one `##` section per delivered unit of work, newest first directly under the heading:

    # Changelog

    ## YYYY-MM-DD Title Case Summary

    ### Added
    - `path/to/file` — what was added and why. Commit `abc1234`, pushed.

    ### Changed
    - `path/to/file` — what changed and why.

    ### Fixed
    - `path/to/file` — what was broken and the fix.

Maintenance patterns:

- **Update, don't pile up.** Before adding a section, scan existing sections for one covering the same scope (same files/module/feature); extend or correct that entry's bullets instead of adding a duplicate section. New section only for genuinely new work.
- **Taxonomy.** `Added` = new capability or files, `Changed` = behavior/contract changes to existing things, `Fixed` = bug fixes. `Notes` for context fitting none of these.
- **Bullet format.** `- \`primary path\` — concise what + why`, one bullet per file or logical unit. Mention the commit hash when committed.
- **Truthful.** Only delivered work present in the tree. No plans, intentions, or session narration. Keep checkpoint sections (Context/Decisions/…) out of the changelog.
- **Placement.** Insert new sections immediately after `# Changelog` (newest first); leave older sections untouched except to dedupe.
