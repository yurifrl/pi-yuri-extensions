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

Write for humans, not the diff. Every entry leads with intention: the problem solved, the capability gained, or the behavior that changed for whoever uses this project. Someone who never opened the code should understand what improved. The changelog is a curated summary, not a commit log.

Template — one `##` section per delivered unit of work, newest first directly under the heading:

    # Changelog

    ## YYYY-MM-DD Outcome in a few words

    ### Added
    - Large exports no longer time out: reports stream as they build instead of being held in memory.

    ### Changed
    - `/checkpoint` now targets the repo-root changelog, so every runtime appends to one shared history.

    ### Fixed
    - Statusline band follows the theme again after idle instead of keeping stale colors.

Maintenance patterns:

- **Intention first.** Lead with what the reader gains or what stopped breaking — "dashboard no longer freezes during large reports", not "fixed async loop timing". Name the capability, the symptom gone, or the friction removed.
- **Minimal code mentions.** At most one file/command/module reference per entry, and only when it anchors the change for the reader (a command, a config key, a new module). Never enumerate every touched file — git history owns that.
- **Curate.** One entry per delivered unit of work: merge related edits into a single bullet, drop internal-only churn (refactors, formatting, test plumbing) unless it changes observable behavior.
- **Update, don't pile up.** Scan existing sections for one covering the same scope (same feature/module); extend or correct that entry instead of adding a duplicate section.
- **Taxonomy.** `Added` = new capability, `Changed` = behavior or contract changed, `Fixed` = misbehavior gone, `Deprecated`/`Removed` = things retiring. Breaking changes are called out explicitly with what replaces them.
- **Truthful.** Only delivered work present in the tree. No plans, future intent, or session narration.
- **Placement.** Insert new sections directly after `# Changelog` (newest first); leave older sections untouched except to dedupe.
