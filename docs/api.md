# The API

The Worker answers under `/api` in two ways, both over the same task engine:

- **The MCP endpoint** at `/api/mcp` is for AI agents. The
  [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is the
  standard way an agent calls the tools a server offers.
- **The HTTP reads** under `/api/tasks` and `/api/changes` are for the web
  app.

Today both read tasks. Writes (filing, claiming, commenting and closing) are
being built.

Agents written for NoticeOS's task tools work against Ntasks unchanged: the
tool names, their arguments, the fields of their results and the sentences of
their refusals are the ones NoticeOS used. The HTTP answers have the shapes
NoticeOS's task pages read.

## Signing in

Every request under `/api` names who sends it, and the Worker checks it
before anything else. A sender holds **scopes**, the kinds of call it may
make: `tasks:read` to read and `tasks:write` to change tasks.

| Answer | When |
|---|---|
| `401` | Nobody is signed in. |
| `403` with `insufficient_scope` | The sender lacks the scope an HTTP route needs. An MCP tool refuses the same call with a sentence instead. |

[Sign-in](sign-in.md) is built, but the API does not use it yet: until the API
checks the projects each sender may reach, the Worker answers `401` with
`{"error":"sign_in_required"}` to every API and MCP request, so a deployment
serves no task data. The sign-in routes under `/api/auth` and `/api/access`
answer as [Sign-in](sign-in.md#routes) describes.

## The workspace

One Ntasks installation serves one **workspace**: the set of projects its
people and agents share. Every MCP tool but `list_workspaces` and
`get_task_guide` takes a `workspace` argument naming it, as NoticeOS's tools
did. Its id and name are `WORKSPACE_ID` and `WORKSPACE_NAME` in the `vars` of
[`wrangler.jsonc`](../workers/api/wrangler.jsonc). An installation that takes
over from NoticeOS sets `WORKSPACE_ID` to that NoticeOS workspace's id, so
agent instructions that name it keep working.

## The MCP endpoint

`POST /api/mcp` takes one JSON-RPC message and answers it. It speaks both
versions of the protocol in use: the 2026-07-28 revision, where every request
names its version, and the earlier revisions that agree a version in an
`initialize` handshake. It keeps no session and streams nothing. A browser
may call it only from the Worker's own origin.

The server's instructions, which an agent reads when it connects, carry the
start of the task guide and its rules for writing a task.

| Tool | What it returns | Arguments |
|---|---|---|
| `list_workspaces` | The workspace, the sender's role and access in it, and the guide's version | none |
| `get_task_guide` | The rules for task work as Markdown, with a version that changes whenever the text does | none |
| `list_projects` | Each project's `projectId`, key, name and prefix | `workspace` |
| `list_tasks` | Tasks most urgent first: every open one and those closed in the last 7 days, as summaries, a page at a time | `workspace`, and optionally `project`, `query`, `status`, `ready`, `assignee` (`"me"` for your own), `parent`, `labels`, `type`, `created_after`, `created_before`, `updated_after`, `updated_before`, `closed_days` (1 to 56), `limit` (1 to 200, default 50) and `offset` |
| `get_task` | One task in full, its comments, and the proposal an owner's answer is checked against | `workspace`, `project`, `task` |
| `get_task_history` | The task's changes newest first, each field with its old and new value, or whole versions with `snapshots` | `workspace`, `project`, `task`, and optionally `limit` (1 to 200, default 50) and `snapshots` |

`list_tasks` without a `project` reads every project, and each task then names
its project.

A refused call answers with a tool result marked as an error, holding one
sentence the agent can act on:

- `invalid arguments: …` names the argument and what it must be, such as
  `invalid arguments: limit (1–200)`.
- `refused: …` names what is missing and where to find it, such as
  `refused: projectId p1 names no project in this workspace; list_projects lists the current projectIds.`

## The HTTP reads

Every route answers JSON with `cache-control: no-store`. A route refuses a
query parameter it does not take, or one given twice, so a misspelt filter
fails instead of being ignored.

| Route | Parameters | Answer |
|---|---|---|
| `GET /api/tasks/projects` | none | `{ projects }`: each `projectId`, `logicalKey`, `displayName` and `prefix` |
| `GET /api/tasks/capabilities` | none | What the web app may offer; `writable` is `false` until writes are built |
| `GET /api/tasks` | `project`, optionally `status` (comma-separated) and `closedDays` | A board: the project's tasks in those statuses and those closed in the last 7 days, the open epics with how many of their children are closed, and `closedSince`. `closedDays` (1 to 56) reaches further back and is taken only with `status=closed`. |
| `GET /api/tasks/:id` | `project` | The task, its comments and its proposal |
| `GET /api/tasks/:id/history` | `project`, optionally `limit` (1 to 200, default 100) | `{ changes }`, newest first |
| `GET /api/changes` | optionally `after` (default 0), `limit` (1 to 200, default 100) and `project` | `{ events, lastSeq }` |

| Error | Answer |
|---|---|
| A parameter is missing, unknown, repeated or out of range | `400` with `{ "error": "invalid_request", "detail": … }` |
| The project or task does not exist | `404` with `{ "error": "not_found", "detail": … }` |
| A method other than `GET` or `HEAD` | `405` with an `allow` header |

## Reading changes instead of reloading

Every change to a task is an event with a sequence number that orders every
change in the installation. `GET /api/changes?after=N` returns the events
after `N`, oldest first, and `lastSeq`, the number to ask after next. When
nothing changed it returns no events and the same `lastSeq`.

This is the cheapest read the API has. A client that shows a board asks for
the changes since its last read, and reloads the board only when an event
arrives.

## What a read costs

Cloudflare counts every row a query reads, and its free plan allows the task
store 5,000,000 rows read a day ([architecture](architecture.md#the-free-plan-budget)).

A board, a list of tasks, the epics or the project list that the store has
read since the last write comes from its memory and reads no rows. It stays
there until a write changes a task or a deferred task's time comes. The store
keeps at most 32 MB of answers, the oldest going first, and reads an answer
larger than 8 MB afresh each time, since the object has 128 MB in all. When the
store does read, each read reaches its rows through an index and returns a
task's labels and links in the same query:

- a read of one task, its comments or its history reads a few dozen rows;
- a list or a board reads about ten rows for each task it returns;
- no read runs more than four statements, however many projects there are.

[`read-cost.test.ts`](../workers/api/test/api/read-cost.test.ts) seeds a store
of eight projects and about 7,000 tasks and fails when a read goes over its
budget. Run it with `--silent=false` to print each read's statements and rows
read. [`store.test.ts`](../workers/api/test/store.test.ts) checks that a
repeated read reads no rows.
