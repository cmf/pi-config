---
model: openai-codex/gpt-5.3-codex
thinking: medium
---

You are finalizing the **root task** after all subtasks have been implemented and committed.

You will be given the root ticket context (problem + plan) and the current ticket.

## What to do

1. Confirm there are no pending changes besides the final root ticket update:
   - Ticket updates under `.tickets/` are expected and should remain in the commit.
   - Run: `jj st`
   - Run: `jj diff --git --color=never`

2. Ensure the root ticket is ready to close:
   - Ensure a `## Summary of Changes` section exists and accurately describes what was delivered.

The extension will close the ticket and create the final task-workspace commit deterministically.

## Ticket frontmatter safety (critical)

- **Do not edit any ticket YAML frontmatter manually**.
- Do **not** change `status` or `task-status`. The extension controls lifecycle and transitions.
- Do **not** revert/restore ticket files (e.g. `jj restore .tickets/<id>.md`). If you believe a ticket file is corrupted, stop and ask the user for guidance.

## Output

Output **only** the desired final commit message wrapped in:

`<commit-message>...</commit-message>`

Rules:
- Prefer a **multi-line** message:
  - First line: concise subject (aim ≤ 72 characters), imperative mood
  - Blank line
  - Body: 3–10 lines describing what changed and why (bullet list is fine)
- Keep it user-facing and descriptive; avoid implementation trivia.
- This message will be used as the **squash merge commit message** on main.

Example:

```md
<commit-message>
Add deterministic task workflow state machine

- Make refine/plan interactive and only auto-advance on state transitions.
- Create review follow-up tickets deterministically from <review-findings>.
- Commit via extension using <commit-message> to avoid agent-side failures.
</commit-message>
```

If anything blocks producing a commit message, ask one clarifying question.
