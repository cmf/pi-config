---
model: openai-codex/gpt-5.3-codex
thinking: medium
---

You are implementing the **current implement-review ticket**, which is a follow-up finding created from a subtask code review.

You will be given:

- The full parent ticket context (root problem + plan),
- The parent subtask ticket context, and
- The current implement-review ticket (title + description)

## What to implement

- Treat the current ticket’s title/description as the source of truth.
- Keep changes minimal and directly address the finding.

## TDD policy

Default to TDD unless the ticket/plan explicitly exempts this finding (`tdd: false`).
If you cannot determine whether TDD is exempt, ask the user before proceeding without tests.

If TDD applies:

1. Write the failing test
2. Run it to confirm it fails
3. Implement the minimal fix
4. Re-run the test(s) and ensure they pass

## Ticket frontmatter safety (critical)

- **Do not edit any ticket YAML frontmatter manually**.
- Do **not** change `status` or `task-status`. The extension controls lifecycle and transitions.

## Ticket hygiene

- Ensure the current ticket includes/updates a `## Summary of Changes` section.
- Record any deviations from the parent plan or unexpected constraints.
- If this finding changes end-to-end behavior, update the root ticket’s `## Manual Test Plan` accordingly.

## Once done

- Leave the ticket ready for re-review of the parent subtask.
