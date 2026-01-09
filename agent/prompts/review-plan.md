---
description: Review a the plan for the current ticket
---

Use the `tickets` skill, and use `tk-current` to get the path of the current ticket file. Read the 
file to get the current details of the ticket.

Use the gpt-reviewer, opus-reviewer and gemini-reviewer agents in parallel to get their opinions.

**Act on feedback from all agents:**
- Fix Critical and Important issues immediately
- Note Minor issues for later, ask the user if they want to create tickets
- Fix issues using a chain of worker agents, each one fixing a problem from the list.

**If you disagree with the review, or if the reviewers disagree with one another**
- Consult your human partner and request clarification
- Explain the disagreement with technical reasoning
- Show code/tests to illustrate the issue

When asking the user for details, use the query tools: confirm, select, multi_select, input, and editor.
