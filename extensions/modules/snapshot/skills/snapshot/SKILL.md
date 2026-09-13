---
name: snapshot
description: "Save durable, AI-readable session context and a truthful changelog entry."
---
# Snapshot

Use this command to preserve the session for a later agent in either Pi or OMP. Optional command guidance is extra context, not a directive to expand scope.

1. Derive a concise kebab-case snapshot name, a one-sentence session description, and distill the session into bullets.
2. Call the `snapshot_write` tool with `name`, `description`, `context` (one paragraph), and the `decisions`, `currentState`, `lessons`, `nextSteps` bullet arrays. The tool writes or updates the session's snapshot file on disk — do not write that file by hand.
3. Call the `changelog_update` tool once with `title`, `category`, and intention-first `bullets` (see the contract below). Call it again only for additional distinct delivered work.
4. Print a self-contained current-state summary and short chronological timeline.

The runtime's built-in `checkpoint` / `rewind` context tools are blocked by this module — they only park conversation context and write nothing to disk. Session snapshots and the changelog are saved exclusively by `snapshot_write` and `changelog_update`.

A snapshot is working memory, not a transcript. Retain decisions, constraints, evidence, and open work needed to resume safely. Do not create additional workflows or exit the current agent runtime.

The changelog is maintained through the `changelog_update` tool, which writes the repo root `CHANGELOG.md` (`<cwd>/CHANGELOG.md`). Never create or edit a `CHANGELOG.md` inside the snapshots folder (`.agents/snapshots/`) or any other nested directory; snapshot files never contain changelog entries.

Write for humans, not the diff. Every entry leads with intention: the problem solved, the capability gained, or the behavior that changed for whoever uses this project. Someone who never opened the code should understand what improved. The changelog is a curated summary, not a commit log.

Template — one `##` section per delivered unit of work, newest first directly under the heading:

    # Changelog

    ## YYYY-MM-DD Outcome in a few words

    ### Added
    - Large exports no longer time out: reports stream as they build instead of being held in memory.

    ### Changed
    - `/snapshot` now targets the repo-root changelog, so every runtime appends to one shared history.

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
