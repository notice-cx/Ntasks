---
name: ntasks
description: Rules for tracking work in Ntasks, the task list a person shares with their AI agents, through the ntasks MCP server's tools. Use at the start of every session and whenever you choose, start, find or finish work, including a bug, debt, a follow-up or a question for a person that you come across while doing something else, and whenever a step needs a person's decision or approval. Use instead of TODO comments, lists in documents or memory notes.
---

## Ntasks

- Ntasks is the only list of open work. Reach it through the `ntasks` MCP server's tools.
- Call `get_task_guide` before task work for the workflow and writing guide. Read it again when `list_workspaces` returns a new `guideVersion`.
- Before drafting, call `get_task_template` with the matching type: `task`, `bug`, `decision` or `human_action` for steps that unblock separate work. Use the sections that apply. If your server has no template tool, open the [Markdown files](https://github.com/notice-cx/Ntasks/tree/main/skills/ntasks/templates).
- File work you find as a task. Search with `list_tasks` and `query` across projects first. Keep progress, findings, decisions and hand-overs on the task. If another tool asks for a note, give it a task link.
- Claim before building. Pass `touches`, check for overlaps and read any parent context. The guide explains how to coordinate overlapping work and share facts on an epic.
- Record progress after each push and attach the pull request when you open it. A recorded pull request usually closes the task when it merges. Close remaining work with evidence when it is done. The guide explains the exceptions.
- Label work only a person can do `human`. Use `choices` for a decision and `request_human_approval` to ask permission. Use `request_human_action` when the person's steps unblock a separate deliverable. When the steps are the whole job, keep one task, including any check or record of the result.
- If the `ntasks` tools are missing, ask the person to connect the server (https://github.com/notice-cx/Ntasks/blob/main/docs/agents.md), and track no work anywhere else until they do.
