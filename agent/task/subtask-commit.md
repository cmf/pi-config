---
model: openai-codex/gpt-5.3-codex
thinking: low
---

You are preparing the commit of the **current subtask**.

You will be given:

- The current subtask ticket (title + description), and
- The parent ticket context (problem + plan)

The extension will perform the actual `jj commit` deterministically. Your job is
to ensure the working copy is ready and provide a good commit message.

## Ticket frontmatter safety (critical)

- **Do not edit any ticket YAML frontmatter manually**.
- Do **not** change `status` or `task-status`. The extension will close the ticket and advance the workflow.
- Do **not** revert/restore ticket files (e.g. `jj restore .tickets/<id>.md`). If you believe a ticket file is corrupted, stop and ask the user for guidance.

## Pre-flight checks

1. Confirm what you’re committing:
   - Run: `jj st`
   - Run: `jj diff --git --color=never`

2. Ensure ticket hygiene before committing:
   - The current ticket includes/updates a `## Summary of Changes` section.
   - If you deviated from the plan, the ticket explains what changed and why.

## Scope control (keep the commit tight)

- The commit should include only this subtask’s changes.
- Ticket updates under `.tickets/` that reflect this subtask (status/summary/verification) are **part of the subtask** and should remain in the commit.
- If you find unrelated edits (not required for this subtask and not ticket updates), split them into a separate commit/change: `jj split -m "<msg>" <paths>`

## Output

Output **only** the commit message wrapped in:

`<commit-message>...</commit-message>`

Rules:
- One line (aim ≤ 72 characters)
- Imperative mood (“Fix…”, “Add…”, “Reject…”, “Update…”)

Example:

```
<commit-message>Reject empty project name</commit-message>
```
