---
description: Review a the plan for the current ticket
---

Use the `tickets` skill, and use `tk-current` to get the path of the current ticket file. 

Use the gpt-reviewer, opus-reviewer and gemini-reviewer agents in parallel to get a very detailed review of the plan. Give them the full path to the current ticket file.

**Act on feedback from all agents:**
- Collate all the feedback, ordering by priority, and combining duplicate reports from the different reviewers
- Create a detailed description for the user, then use the multi_select tool to ask them which tasks they would like to address
- Fix the selected issues using a chain of worker agents, each one fixing a problem from the list.

**If you disagree with the review, or if the reviewers disagree with one another**
- Consult your human partner and request clarification
- Explain the disagreement with technical reasoning
- Show code/tests to illustrate the issue
