---
name: ntasks
description: Rules for tracking work in Ntasks, the task list a person shares with their AI agents, through the ntasks MCP server's tools. Use at the start of every session and whenever you choose, start, find or finish work, including a bug, debt, a follow-up or a question for a person that you come across while doing something else, and whenever a step needs a person's decision or approval. Use instead of TODO comments, lists in documents or memory notes.
---

## Ntasks

- Ntasks is the only list of open work. Reach it through the `ntasks` MCP server's tools.
- Call `get_task_guide` before task work, and again when `list_workspaces` returns a different `guideVersion`. The guide holds the workflow and the rules for writing a task.
- Found work (a bug, debt, a follow-up, a question for a person) becomes a task. Search first with `list_tasks` and `query`, leaving out `project` to search every project, then file it with `create_task`. Never record it as a TODO comment, a list in a document or a memory note.
- Call `claim_task` before you build, `comment_on_task` when something changes, and `close_task` with its proof: `commit`, `pr` or `link`.
- A step only a person can do is a task with the label `human`, written for that person. Work that must wait for a person's approval uses `request_human_approval`.
- If the `ntasks` tools are missing, ask the person to connect the server (https://github.com/notice-cx/Ntasks/blob/main/docs/agents.md), and track no work anywhere else until they do.
