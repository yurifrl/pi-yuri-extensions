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
5. Update the one matching `CHANGELOG.md` entry for meaningful delivered or changed work. Keep it truthful and deduplicated.
6. Print a self-contained current-state summary and short chronological timeline.

A checkpoint is working memory, not a transcript. Retain decisions, constraints, evidence, and open work needed to resume safely. Do not create additional workflows or exit the current agent runtime.
