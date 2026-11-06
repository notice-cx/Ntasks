# The API

The Worker answers under `/api` in two ways, both over the same task engine:

- **The MCP endpoint** at `/api/mcp` is for AI agents. The
  [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is the
  standard way an agent calls the tools a server offers.
- **The HTTP routes** under `/api/tasks` and `/api/changes` are for the web
  app.

Both read tasks and change them: they file, claim, change, comment on and
close tasks, link one task to another and ask a person for an approval. A
person's own decisions (answering a task that waits on them, choosing one of
its options, approving) and `reconcile_task`, which records such an answer
for an agent, are being built.

Agents written for NoticeOS's task tools work against Ntasks unchanged: the
tool names, their arguments, the fields of their results and the sentences of
their refusals are the ones NoticeOS used, except that a refusal that sent a
person to NoticeOS's Tower sends them to the web app.
[`write-tools.test.ts`](../workers/api/test/api/write-tools.test.ts) compares
the tools' schemas with NoticeOS's own. The HTTP routes take the bodies and
give the answers NoticeOS's task pages used.

## Signing in

Every request under `/api` names who sends it, and the Worker checks it
before anything else. A sender holds **scopes**, the kinds of call it may
make: `tasks:read` to read and `tasks:write` to change tasks.

| Answer | When |
|---|---|
| `401` | Nobody is signed in. |
| `403` with `insufficient_scope` | The sender lacks the scope an HTTP route needs. An MCP tool refuses the same call with a sentence instead. |

A sender also reaches certain **projects**. The owner reaches every project;
an agent or a service reaches only the projects it was granted, each for
reading or for writing too. Lists and the change feed leave the other
projects out, and a request that names one gets the same answer as a project
that does not exist, so a sender learns nothing of projects it cannot reach.
A write to a project granted for reading only is refused: `403` with
`forbidden` on an HTTP route, and a `refused: …` sentence from an MCP tool.

The Worker signs every request in as [Sign-in](sign-in.md) describes: the
owner's browser session, an agent's OAuth access token, or a service
credential. A request with none, or with one that is invalid, revoked or
expired, gets `401` with a bearer challenge that tells an MCP client where to
sign in. The sign-in routes under `/api/auth` and `/api/access` answer as
[Sign-in](sign-in.md#routes) describes.

## The workspace

One Ntasks installation serves one **workspace**: the set of projects its
people and agents share. Every MCP tool but `list_workspaces` and
`get_task_guide` takes a `workspace` argument naming it, as NoticeOS's tools
did. Its id and name are `WORKSPACE_ID` and `WORKSPACE_NAME` in the `vars` of
[`wrangler.jsonc`](../workers/api/wrangler.jsonc). An installation that takes
over from NoticeOS sets `WORKSPACE_ID` to that NoticeOS workspace's id, so
agent instructions that name it keep working.

## The MCP endpoint

`POST /api/mcp` takes one JSON-RPC message of at most 256 KB and answers it. It speaks both
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
| `create_task` | The new task's `id`, its project's key, `replayed`, the approval it opened if any, and `lint` | `workspace`, `project`, `title`, `idempotency_key`, and optionally `description`, `type`, `priority`, `labels`, `parent`, `acceptance`, `depends_on`, `blocks`, `related`, `discovered_from`, `approval`, `choices`, `card`, `change_class`, `metadata` and `model` |
| `create_tasks` | Each task filed, in order, with its `lint`; the first task refused, if any, and how many were not tried | `workspace`, `project`, `tasks` (1 to 25, each with `create_task`'s task fields), `idempotency_key`, and optionally `model` |
| `claim_task` | The task, now held by the sender and in progress | `workspace`, `project`, `task`, `idempotency_key`, and optionally `model` |
| `update_task` | The task as changed, and `lint` | `workspace`, `project`, `task`, `idempotency_key`, and at least one of `status`, `priority`, `title`, `description`, `assignee`, `parent`, `defer`, `acceptance`, `add_labels`, `remove_labels`, `related`, `choices`, `card` and `change_class` |
| `comment_on_task` | The comment | `workspace`, `project`, `task`, `text`, `idempotency_key` |
| `add_dependency` | The link | `workspace`, `project`, `task`, `depends_on`, and optionally `type`: `blocks` (the default), `related` or `discovered-from` |
| `remove_dependency` | The link, removed | `workspace`, `project`, `task`, `depends_on` |
| `request_human_approval` | The approval the task now waits on, and `created`: whether this call opened it | `workspace`, `project`, `task`, `reason` (at most 400 characters) |
| `close_task` | The task as closed | `workspace`, `project`, `task`, `reason`, `idempotency_key`, and optionally `resolution` (`done` when left out), `duplicate_of` and `model` |

`list_tasks` without a `project` reads every project, and each task then names
its project.

In `update_task`, `""` releases the task (`assignee`), takes it out of its
parent (`parent`) or clears its defer date (`defer`), and `null` takes off its
`choices`, `card` or `change_class`. A status on a closed task opens it again.
In `create_tasks`, a parent or a link may name an earlier task of the same
call as `#0`, `#1` and so on.

A refused call answers with a tool result marked as an error, holding one
sentence the agent can act on:

- `invalid arguments: …` names the argument and what it must be, such as
  `invalid arguments: limit (1–200)`.
- `refused: …` names what is missing and where to find it, such as
  `refused: projectId p1 names no project in this workspace; list_projects lists the current projectIds.`,
  or what in the task's state stops the change and what to do instead.
- `conflict: …` says the idempotency key was first used for a different
  change ([retrying a write](#retrying-a-write)).
- `unavailable: …` says the change did not land and may be retried.

A client whose copy of the tool list is older than an argument sends an
object argument, such as `card`, as text. The tools read it as JSON, and the
answer starts with `staleClient`, a sentence telling the agent to reconnect.

## The rules a write keeps

These are the rules NoticeOS's task tools kept, and the HTTP writes keep them
too.

- **A claim** takes an open task. It is refused when someone else holds the
  task, when the task is closed, and when its status is `blocked`, `deferred`
  or `in_progress` with nobody holding it.
- **A close** is refused when someone else holds the task, when an approval it
  waits on is still open, when it has children that are not closed, and when
  the task is a person's decision: an approval, or a task labelled `human`.
  A task it depends on may still be open. A close as `done` keeps the task's
  card as it stood, with the commit hash its reason names, and `get_task`
  returns it as `cardShipped`. A close as `duplicate` links the two tasks as
  `related`.
- **A change** may not replace a task's choices once a person has chosen, or
  its card once it has shipped. Taking the `human` label off a person's
  decision is refused. A task someone is working on goes to someone else only
  from its holder.
- **A dependency** keeps the type it was added with: asking for it with
  another type is refused, and asking for it again changes nothing. A
  `related` link may name a task in another project the sender reaches; every
  other link stays inside the project. A link that would make tasks wait on
  each other in a loop is refused. A dependency on a person's decision stays
  until the person decides.
- **An approval** asked again with the same reason returns the open one,
  with `created: false`.
- **Who did it**: the task records the sender's name as its filer, holder,
  closer or the author of a comment, and the `model` argument beside it. The
  server records who wrote a card and when, and a card's kill date is also the
  task's due date.
- **Lint**: `create_task`, `create_tasks` and `update_task` return `lint`, the
  sections the task's type expects that it still lacks, and advice, such as
  passing lettered options as `choices`. Nothing is refused for it.

## Retrying a write

A write that would repeat its effect takes an idempotency key, a string of 8
to 128 letters, digits, dots, underscores, colons or hyphens: the
`idempotency_key` argument of `create_task`, `create_tasks`, `claim_task`,
`update_task`, `comment_on_task` and `close_task`, and the optional
`Idempotency-Key` header of an HTTP write. A retry with the same key and the
same arguments answers what the first call answered, with the tasks as they
stand now and `replayed: true`, and changes nothing. The same key with other
arguments, for another task or in another project is refused. A key is kept
for seven days, for each sender and each tool.

`add_dependency`, `remove_dependency` and `request_human_approval` take no
key, because asking again changes nothing.

A write that another write beats to the same task reads the task again,
checks the rules again and tries again, up to three times. After that it
answers `unavailable: …`, or `503` over HTTP, and has changed nothing.

## The HTTP routes

Every route answers JSON with `cache-control: no-store`.

### Reads

A read refuses a query parameter it does not take, or one given twice, so a
misspelt filter fails instead of being ignored.

| Route | Parameters | Answer |
|---|---|---|
| `GET /api/tasks/projects` | none | `{ projects }`: each `projectId`, `logicalKey`, `displayName` and `prefix` |
| `GET /api/tasks/capabilities` | none | What the web app may offer: for a sender who holds `tasks:write` and may change some project, `writable: true`, the write `operations` (`create`, `update`, `comment`, `close`) and the `editableFields` an update may change; for any other sender, `writable: false` and none |
| `GET /api/tasks` | `project`, optionally `status` (comma-separated) and `closedDays` | A board: the project's tasks in those statuses and those closed in the last 7 days, the open epics with how many of their children are closed, `closedSince`, and `lastSeq`, the latest change the board reflects. `closedDays` (1 to 56) reaches further back and is taken only with `status=closed`. |
| `GET /api/tasks/:id` | `project` | The task, its comments and its proposal |
| `GET /api/tasks/:id/history` | `project`, optionally `limit` (1 to 200, default 100) | `{ changes }`, newest first |
| `GET /api/changes` | optionally `after` (default 0), `limit` (1 to 200, default 100) and `project` | `{ events, lastSeq }` |

### Writes

Each write takes one JSON object of at most 32 KB, sent as
`application/json`, with no key twice, and no query. A browser may send one
only from the Worker's own origin. Each runs the same write as the MCP tool
that does the same thing, so it keeps [the same rules](#the-rules-a-write-keeps).

| Route | Body | Answer |
|---|---|---|
| `POST /api/tasks` | `projectId`, `title`, and optionally `description`, `type`, `priority`, `labels`, `parent`, `acceptance`, `metadata`, `card` and `changeClass` | `{ id, project }`: the new task's id and its project's key |
| `PATCH /api/tasks/:id` | `projectId` and at least one of `status`, `priority`, `title`, `description`, `assignee`, `parent`, `defer`, `acceptance`, `addLabels`, `removeLabels`, `card` and `changeClass`; or `projectId` and `claim: true` to take the task | `{ task }`, the task as changed |
| `POST /api/tasks/:id/comments` | `projectId`, `text` | `{ comment }` |
| `POST /api/tasks/:id/close` | `projectId`, `reason`, and optionally `resolution` and `duplicateOf` | `{ task }`, the task as closed |

A new task's `metadata` holds where it came from, under the keys NoticeOS
used for that: `noticeos_source`, `noticeos_asset`, `noticeos_kind`,
`noticeos_rule`, `noticeos_key`, `noticeos_panel_asset`,
`noticeos_panel_date`, `noticeos_panel_version` and
`noticeos_task_map_asset`. In a change, `""` releases the task, takes it out
of its parent or clears its defer date, and `null` takes off its card or
change class. NoticeOS answered a change, a comment and a close with its task
client's own output; Ntasks answers them with the task or the comment, in the
shapes the reads use.

### Errors

A refusal from a route carries a `detail` sentence a person can read.

| Error | Answer |
|---|---|
| A parameter, the body or a field is missing, unknown, repeated or out of range | `400` with `{ "error": "invalid_request", "detail": … }` |
| The sender lacks the scope the route needs | `403` with `insufficient_scope` |
| The sender may read the project but not change it, or a write comes from another site's page | `403` with `forbidden` |
| The project or a task the request names does not exist | `404` with `{ "error": "not_found", "detail": … }` |
| The task's state refuses the write, such as a close of a task someone else holds | `409` with `task_refused` |
| The `Idempotency-Key` was first used for a different write | `409` with `idempotency_conflict` |
| The task kept changing while the write was made | `503` with `unavailable` |
| A method the path does not take | `405` with an `allow` header naming the ones it takes |

## Reading changes instead of reloading

Every change to a task is an event with a sequence number that orders every
change in the installation. `GET /api/changes?after=N` returns the events
after `N`, oldest first, and `lastSeq`, the number to ask after next. When
nothing changed it returns no events and the same `lastSeq`.

This is the cheapest read the API has. A client that shows a board starts
from the board's own `lastSeq`, asks for the changes after it, and reloads
the board only when an event arrives.

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
