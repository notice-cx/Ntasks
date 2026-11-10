---
name: ntasks
description: Rules for tracking work in Ntasks, the task list a person shares with their AI agents, through the ntasks MCP server's tools. Use at the start of every session and whenever you choose, start, find or finish work, including a bug, debt, a follow-up or a question for a person that you come across while doing something else, and whenever a step needs a person's decision or approval. Use instead of TODO comments, lists in documents or memory notes.
---

## Ntasks

- Ntasks is the only list of open work. Reach it through the `ntasks` MCP server's tools.
- Call `get_task_guide` before task work, and again when `list_workspaces` returns a different `guideVersion`. The guide holds the workflow and the rules for writing a task.
- Found work (a bug, debt, a follow-up, a question for a person) becomes a task. Search first with `list_tasks` and `query`, leaving out `project` to search every project, then file it with `create_task`. Never record it as a TODO comment, a list in a document or a memory note.
- Call `claim_task` before you build, `comment_on_task` when something changes, and `close_task` with its proof: `commit`, `pr` or `link`.
- Record your pull request with `pr` once you open it. When GitHub reports that it merged into the default branch, the task closes itself as done, even if your session has stopped. It stays in progress when it is an epic or a person's request, waits on an open approval or Do request, has open tasks under it, or carries the label `keep-open`, which you add when the pull request covers only part of the task. After the merge, check the task and close it yourself if it stayed open.
- Everything about a task goes on the task, as a comment or its fields: progress, hand-overs (where work stopped, file pointers, gotchas, what is left), findings and decisions. Never put it in a separate notes file, scratch doc, chat-only summary, memory or a tool's own notes feature. When another tool asks for a note, write only a pointer to the task.
- On a task in an epic, `get_task` and `claim_task` show `parent`: the facts the epic's tasks pinned for each other and what its closed tasks left. Read it before you build. A fact the epic's other tasks need, such as a file they all change or the order their pull requests merge in, goes on the epic with `comment_on_task` and `pin: true`.
- A step only a person can do is a task with the label `human`, written for that person. Work that must wait for a person's approval uses `request_human_approval`; steps only the person can do, such as running a command on their own machine, use `request_human_action`, each step's command apart from its text.
- An ask to a person says in plain words what is waiting, why it is theirs to decide, and the exact place to act: the button on the task's page in Ntasks, a link, or the command to run. Leave out internal terms such as store migration or gate. The guide shows a before-and-after example.
- If the `ntasks` tools are missing, ask the person to connect the server (https://github.com/notice-cx/Ntasks/blob/main/docs/agents.md), and track no work anywhere else until they do.
