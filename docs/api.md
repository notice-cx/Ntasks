# The API

The Worker answers under `/api` in two ways, both over the same task engine:

- **The MCP endpoint** at `/api/mcp` is for AI agents. The
  [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is the
  standard way an agent calls the tools a server offers.
- **The HTTP routes** under `/api/tasks` and `/api/changes` are for the web
  app.

Two more serve the store as a whole: `/api/backup` hands it out for a backup
([below](#backing-up-the-whole-store)), and `/api/restore` loads an import or
a backup into an empty store ([below](#loading-an-empty-store)).

Both read tasks and change them: they file, claim, change, comment on and
close tasks, link one task to another and ask a person for an approval. A
person's own decisions (answering a task that waits on them, choosing one of
its options, approving) and `reconcile_task`, which records such an answer
for an agent, are being built.

Agents written for NoticeOS's task tools work against Ntasks unchanged: the
tool names, their arguments, the fields of their results and the sentences of
their refusals are the ones NoticeOS used, except that a refusal that sent a
person to NoticeOS's Tower sends them to the web app.
Ntasks adds optional arguments for what NoticeOS's tools lacked, such as a
task's notes; every argument NoticeOS's tools take is unchanged, and
[`write-tools.test.ts`](../workers/api/test/api/write-tools.test.ts) compares
the tools' schemas with NoticeOS's own. The HTTP routes take the bodies and
give the answers NoticeOS's task pages used, with the same additions.

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
For the same reason, a link between a task the sender reaches and a task in a
project it cannot reach is left out of every task the API answers with, and
of the task's history and the change feed. The other task's project is the
one whose prefix starts its id.
A write to a project granted for reading only is refused: `403` with
`forbidden` on an HTTP route, and a `refused: …` sentence from an MCP tool.

The Worker signs every request in as [Sign-in](sign-in.md) describes: the
owner's browser session, an agent's OAuth access token, or a service
credential. A request with none, or with one that is invalid, revoked or
expired, gets `401` with a bearer challenge that tells an MCP client where to
sign in. A service names the agent each request is for in the
`x-ntasks-on-behalf-of` header, and the request is recorded as that agent's
([A service acting for its agents](sign-in.md#a-service-acting-for-its-agents)). The sign-in routes under `/api/auth` and `/api/access` answer as
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
| `list_tasks` | Tasks most urgent first: every open one and those closed in the last 7 days, as summaries, a page at a time | `workspace`, and optionally `project`, `query`, `status`, `ready`, `assignee` (`"me"` for your own), `parent`, `labels`, `type`, `created_after`, `created_before`, `updated_after`, `updated_before`, `closed_days` (1 to 56), `limit` (1 to 200, default 50), `offset` and `fields` (with `project`) |
| `get_task` | One task in full, its comments, and the proposal an owner's answer is checked against | `workspace`, `project`, `task` |
| `get_task_history` | The task's changes newest first, each field with its old and new value, or whole versions with `snapshots` | `workspace`, `project`, `task`, and optionally `limit` (1 to 200, default 50) and `snapshots` |
| `create_task` | The new task's `id`, its project's key, `replayed`, the approval it opened if any, and `lint` | `workspace`, `project`, `title`, `idempotency_key`, and optionally `description`, `type`, `priority`, `labels`, `parent`, `acceptance`, `notes`, `design`, `estimate_minutes`, `depends_on`, `blocks`, `related`, `discovered_from`, `duplicates`, `supersedes`, `external_links`, `fields`, `approval`, `choices`, `card`, `change_class`, `metadata` and `model` |
| `create_tasks` | Each task filed, in order, with its `lint`; the first task refused, if any, and how many were not tried | `workspace`, `project`, `tasks` (1 to 25, each with `create_task`'s task fields), `idempotency_key`, and optionally `model` |
| `claim_task` | The task, now held by the sender and in progress | `workspace`, `project`, `task`, `idempotency_key`, and optionally `model` |
| `update_task` | The task as changed, and `lint` | `workspace`, `project`, `task`, `idempotency_key`, and at least one of `status`, `priority`, `title`, `description`, `assignee`, `parent`, `defer`, `acceptance`, `notes`, `design`, `estimate_minutes`, `add_labels`, `remove_labels`, `related`, `duplicates`, `supersedes`, `add_external_links`, `remove_external_links`, `fields`, `choices`, `card` and `change_class` |
| `comment_on_task` | The comment | `workspace`, `project`, `task`, `text`, `idempotency_key` |
| `add_dependency` | The link | `workspace`, `project`, `task`, `depends_on`, and optionally `type`: `blocks` (the default), `related` or `discovered-from`. A `duplicates` or `supersedes` link is added with `create_task` or `update_task` |
| `remove_dependency` | The link, removed | `workspace`, `project`, `task`, `depends_on` |
| `request_human_approval` | The approval the task now waits on, and `created`: whether this call opened it | `workspace`, `project`, `task`, `reason` (at most 400 characters) |
| `close_task` | The task as closed | `workspace`, `project`, `task`, `reason`, `idempotency_key`, and optionally `resolution` (`done` when left out), `duplicate_of` and `model` |
| `list_fields` | The project's key and its custom fields, retired ones included, in the order they were defined: each one's `key`, `name`, `type`, `options`, `createdAt` and `retiredAt` | `workspace`, `project` |
| `define_field` | The field, and `replayed` | `workspace`, `project`, `key`, `name`, `type`, `idempotency_key`, and `options` for a choice field |
| `retire_field` | The field as retired, and `replayed` | `workspace`, `project`, `field` (its key), `idempotency_key` |

`list_tasks` without a `project` reads every project, and each task then names
its project.

`notes` and `design` are Markdown, at most 8,192 characters each, and
`estimate_minutes` is a whole number of minutes from 0 to 525,600 (a year).
`get_task` returns them as `notes`, `design` and `estimateMinutes`, and
`list_tasks` returns `estimateMinutes`; like `description`, `notes` and
`design` are left out of `list_tasks`.

`duplicates` names earlier tasks for the same work, and `supersedes` the
tasks this one replaces. `get_task` lists them among `dependencies`, with
those types.

`external_links` and `add_external_links` are each an array of objects, and
each object has a `url`, an http or https URL of at most 2,048 characters, a
`title`, one line of at most 512 characters, and optionally a `kind`:
`pull-request`, `document` or `other`. `remove_external_links` is an array of
URLs. A task links to at most 32 pages, and to a URL once: a URL is kept as
the URL standard writes it, so `HTTPS://Example.com` and
`https://example.com/` are one URL, and adding a URL the task has gives that
link the new title and kind. `get_task` and `list_tasks` return them as
`externalLinks`, ordered by URL, each with its `url`, `title` and `kind`,
which is null when none was given.

Each project defines its own **custom fields**, and its tasks carry values
of them. A field has a `key`, which names it in values and filters: a
lowercase letter, then up to 63 lowercase letters, digits, underscores or
hyphens. It has a `name`, one line of at most 128 characters, and a `type`.
A value of each type is:

| Type | Value |
|---|---|
| `text` | Text of 1 to 1,024 characters |
| `number` | A number |
| `date` | A date as `YYYY-MM-DD` |
| `single-choice` | One of the field's `options` |
| `multiple-choice` | A list of the field's `options`, none twice, kept in the field's order |
| `url` | An http or https URL of at most 2,048 characters, kept as the URL standard writes it |
| `yes-no` | `true` or `false` |

A choice field has 1 to 64 options, each one line of at most 128
characters. A project defines at most 64 fields, retired ones included, and
a key names one field for good: defining a key the project has used, retired
or not, is refused. A field keeps its key, type and options.

`fields` in `create_task`, `create_tasks` and `update_task` is an object of
values by field key, and in `update_task` `null` takes a value off.
`get_task` and `list_tasks` return a task's values as `fields`. A value that
is not of its field's type is refused with a sentence that names the field and
its type, such as
`invalid arguments: fields.points must be a number: Points is a number field`.
`fields` in `list_tasks` lists only the tasks holding each value, by key; for
a multiple-choice field, the value is one option, which the task's options
include. It needs `project`, since each project defines its own fields.

A retired field takes no new values: a task keeps the value it has, filters
still find it, its history keeps every change, and `update_task` can take it
off with `null`. Retiring a retired field changes nothing.

In `update_task`, `""` releases the task (`assignee`), takes it out of its
parent (`parent`) or clears its defer date (`defer`), and `null` takes off its
`choices`, `card`, `change_class` or `estimate_minutes`. A status on a closed
task opens it again.
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
  `related`, `duplicates` or `supersedes` link may name a task in another
  project the sender reaches; every other link stays inside the project. A
  link that would make tasks wait on
  each other in a loop is refused. A dependency on a person's decision stays
  until the person decides.
- **An approval** asked again with the same reason returns the open one,
  with `created: false`.
- **Who did it**: the task records the sender's name as its filer, holder,
  closer or the author of a comment, and the `model` argument beside it. The
  server records who wrote a card and when, and a card's kill date is also the
  task's due date.
- **A custom field** is defined and retired by a sender who may change the
  project, as any write needs. Listing a project's fields needs only reading
  it.
- **Lint**: `create_task`, `create_tasks` and `update_task` return `lint`, the
  sections the task's type expects that it still lacks, and advice, such as
  passing lettered options as `choices`. Nothing is refused for it.

## Retrying a write

A write that would repeat its effect takes an idempotency key, a string of 8
to 128 letters, digits, dots, underscores, colons or hyphens: the
`idempotency_key` argument of `create_task`, `create_tasks`, `claim_task`,
`update_task`, `comment_on_task`, `close_task`, `define_field` and
`retire_field`, and the optional
`Idempotency-Key` header of an HTTP write. A retry with the same key and the
same arguments answers what the first call answered, with the tasks as they
stand now and `replayed: true`, and changes nothing. The same key with other
arguments, for another task or in another project is refused. A key is kept
for seven days, for each sender and each tool. A call that finds nothing to
change, such as a title set to the title the task has, still keeps its key,
so a retry of it answers again rather than writing that title over a newer
one.

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
| `GET /api/tasks` | `project`, optionally `status` (comma-separated), `closedDays` and `field.<key>` | A board: the project's tasks in those statuses and those closed in the last 7 days, the open epics with how many of their children are closed, `closedSince`, and `lastSeq`, the latest change the board reflects. `closedDays` (1 to 56) reaches further back and is taken only with `status=closed`. Each `field.<key>` parameter, such as `field.severity=high`, keeps only the tasks holding that value of the custom field, as `fields` in `list_tasks` does; a number field reads the parameter as a number, and a yes-no field reads `true` or `false`. |
| `GET /api/tasks` with `label` | `project` and `label` (one label), optionally `limit` (1 to 200, default 100) and `after` | Every task of the project carrying the label, in every status and closed at any time, ordered by id, with `label` and `next`. `next` is the last task's id when more remain, and null on the last page; ask again with `after` set to it. `status`, `closedDays` and `field.<key>` are refused with `label`, and `limit` and `after` without it. |
| `GET /api/tasks/:id` | `project` | The task, its comments and its proposal |
| `GET /api/tasks/:id/history` | `project`, optionally `limit` (1 to 200, default 100) | `{ changes }`, newest first |
| `GET /api/changes` | optionally `after` (default 0), `limit` (1 to 200, default 100) and `project` | `{ events, lastSeq }` |
| `GET /api/fields` | `project` | `{ project, fields }`: the project's key and its custom fields, as `list_fields` lists them |

### Writes

Each write takes one JSON object of at most 32 KB, sent as
`application/json`, with no key twice, and no query. A browser may send one
only from the Worker's own origin. Each runs the same write as the MCP tool
that does the same thing, so it keeps [the same rules](#the-rules-a-write-keeps).

| Route | Body | Answer |
|---|---|---|
| `POST /api/tasks` | `projectId`, `title`, and optionally `description`, `type`, `priority`, `labels`, `parent`, `acceptance`, `notes`, `design`, `estimateMinutes`, `dueAt`, `externalLinks`, `fields`, `metadata`, `card` and `changeClass` | `{ id, project }`: the new task's id and its project's key |
| `PATCH /api/tasks/:id` | `projectId` and at least one of `status`, `priority`, `title`, `description`, `assignee`, `parent`, `defer`, `acceptance`, `notes`, `design`, `estimateMinutes`, `dueAt`, `addLabels`, `removeLabels`, `addExternalLinks`, `removeExternalLinks`, `fields`, `card` and `changeClass`; or `projectId` and `claim: true` to take the task | `{ task }`, the task as changed |
| `POST /api/tasks/:id/comments` | `projectId`, `text` | `{ comment }` |
| `POST /api/tasks/:id/close` | `projectId`, `reason`, and optionally `resolution` and `duplicateOf` | `{ task }`, the task as closed |
| `POST /api/fields` | `projectId`, `key`, `name`, `type`, and `options` for a choice field | `{ field }`, the field defined |
| `POST /api/fields/:key/retire` | `projectId` | `{ field }`, the field as retired |

A new task's `metadata` holds where it came from, under the keys NoticeOS
used for that: `noticeos_source`, `noticeos_asset`, `noticeos_kind`,
`noticeos_rule`, `noticeos_key`, `noticeos_panel_asset`,
`noticeos_panel_date`, `noticeos_panel_version` and
`noticeos_task_map_asset`. In a change, `""` releases the task, takes it out
of its parent or clears its defer date, and `null` takes off its card, change
class, estimate or due date.

`dueAt` is a date, `YYYY-MM-DD`, or an ISO time with its offset, and the task
answers it as `dueAt` in UTC. Writing a card with a kill date also sets the
task's `dueAt` to that date, so one body gives either a card with a kill date
or a `dueAt`, not both. After that each changes on its own: a later change
can set or clear `dueAt` and leave the card as it is, and taking the card off
leaves `dueAt`, so the two dates can differ until a card with a kill date is
written again.

`externalLinks` and `addExternalLinks` are each an array of objects, and each
object has a `url`, a `title` and optionally a `kind`, with the limits that
[`external_links`](#the-mcp-endpoint) has over MCP. `removeExternalLinks` is
an array of URLs.

`fields` is an object of custom field values by key, as `fields` is over MCP,
and in a change `null` takes a value off. The task answers its values as
`fields`.

NoticeOS answered a change, a comment and a close with its task client's own
output; Ntasks answers them with the task or the comment, in the shapes the
reads use.

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
| The store changed during a backup | `409` with `store_changed` ([below](#backing-up-the-whole-store)) |
| A load into a store that is not empty, or that does not fit the store | `409` with the reason ([below](#loading-an-empty-store)) |
| A method the path does not take | `405` with an `allow` header naming the ones it takes |

## Reading changes instead of reloading

Every change to a task is an event with a sequence number that orders every
change in the installation. `GET /api/changes?after=N` returns the events
after `N`, oldest first, and `lastSeq`, the number to ask after next. When
nothing changed it returns no events and the same `lastSeq`.

This is the cheapest read the API has. A client that shows a board starts
from the board's own `lastSeq`, asks for the changes after it, and reloads
the board only when an event arrives.

## Backing up the whole store

`GET /api/backup` hands out every row the task store keeps, page by page:
the rows of each table [the task store](task-store.md#tables) lists, retry
records included, exactly as stored, so a backup loads into an empty store
as the same rows. It needs the `tasks:backup` scope, which the owner's
browser session holds, and a service credential holds when the owner made it
with `"backup": true` ([Sign-in](sign-in.md#routes)). It reads every
project, whatever projects the sender was granted. Any other sender gets
`403` with `insufficient_scope`.

| Request | Answer |
|---|---|
| `GET /api/backup` | The first page |
| `GET /api/backup?page=<next>` | The page after the one whose `next` this is |

Each page is a JSON object:

| Field | Holds |
|---|---|
| `format` | `ntasks-backup-v1` |
| `takenAt` | When the first page was read. Every page holds the store as it stood then. |
| `migrations` | The names of the store's schema migrations. A backup loads only into a store with exactly these. |
| `table` | The table the rows are from. The tables come in the order the task store lists them. |
| `rows` | Rows of that table in primary key order, each with every column |
| `next` | The token that asks for the next page, or null after the last |

A page holds at most 500 rows, or rows holding about 512 KB of values,
whichever comes first, so one request stays well inside the free plan's
10 ms of CPU. A table's last page may be empty.

The pages of one backup fit together only if nothing is written while they
are read: a task written after its table was read would be missing from the
backup, though its history was in it. So every page after the first checks
that the store has changed no row since the first page, and has not
restarted. If it has, the page answers `409` with `store_changed`, and the
backup starts again from the first page. A busy store can refuse several
tries in a row; a backup succeeds when agents are quiet. A `page` the route
did not give gets `400` with `invalid_request`.

A whole backup reads each row once. A store of 100,000 rows costs about 2%
of the 5,000,000 rows the free plan reads in a day.
[`tools/migrate`](../tools/migrate/README.md#back-up-and-restore) writes the
pages to one file and restores the file into an empty store copy.

## Loading an empty store

`POST /api/restore` and the routes under it load rows into the store while it
holds none: an import from Beads, or a backup. The rows arrive in pages, wait
in the store, and are written together when the load is committed, in one
transaction. So a load lands whole or not at all, and nobody reading the
store sees part of one. They need the `tasks:restore` scope, which the
owner's browser session holds, and a service credential holds when the owner
made it with `"restore": true` ([Sign-in](sign-in.md#routes)). Any other
sender gets `403` with `insufficient_scope`. Each takes one JSON object, of
at most 1 MB, and no query.

| Route | Body | Answer |
|---|---|---|
| `POST /api/restore` | `migrations`: the names of the store migrations the rows were made with | `{ load }`: the load's id. Refused unless the store holds no row in any table a backup holds, and has exactly these migrations. A load that was waiting is dropped. |
| `POST /api/restore/rows` | `load`, `table` and `rows`: 1 to 500 rows of that table, each an object holding exactly the table's columns, as GET /api/backup gives them | `{ table, page, rows }`: the page's number and its rows |
| `POST /api/restore/commit` | `load` and `counts`: the rows sent for each table | `{ rows, rowsWritten }`: the rows written, and the rows Cloudflare counts as written for them, index entries included |
| `POST /api/restore/abort` | `load` | `{ aborted: true }`: the waiting load and its pages are gone |

The commit writes nothing unless every check passes:

| Refusal | When |
|---|---|
| `409` with `store_not_empty` | The store held a row when the load began, or someone wrote one before the commit |
| `409` with `schema_mismatch` | The rows were made with other migrations than the store has; load them with the version of Ntasks the store runs |
| `409` with `counts_differ` | The pages that arrived do not hold the rows `counts` gives, such as when a page was lost |
| `409` with `load_refused` | A row breaks a rule of the store, such as a check or a link to a task the load does not hold. The load keeps waiting, to be aborted. |
| `409` with `no_such_load` | No load with this id is waiting |
| `400` with `invalid_request` | A page names another table, holds no row or more than 500, or a row lacks a column, has one the table lacks, or holds a value that is not text, a number or null |

A load does not stop others from writing: the commit finds any row written
since the load began, and refuses. Cloudflare counts each index entry as a
row written, so a load writes about three times as many rows as it holds: a
hub of 40,000 rows, mostly history, comes to about 120,000, more than the
free plan's 100,000 a day. Such a one-time load fits the paid plan.
[`tools/migrate`](../tools/migrate/README.md#load-into-the-deployed-store)'s
`load` command checks the rows in a local copy first, sends the pages,
commits, and reads the store back to verify it.

## What a read costs

Cloudflare counts every row a query reads, and its free plan allows the task
store 5,000,000 rows read a day ([architecture](architecture.md#the-free-plan-budget)).

A board, a list of tasks, the epics or the project list that the store has
read since the last write comes from its memory and reads no rows. It stays
there until a write changes a task or a deferred task's time comes. The store
keeps at most 32 MB of answers, the oldest going first, and reads an answer
larger than 8 MB afresh each time, since the object has 128 MB in all. When the
store does read, each read reaches its rows through an index and returns a
task's labels, its links to other tasks and its external links in the same
query:

- a read of one task, its comments or its history reads a few dozen rows;
- a list or a board reads about ten rows for each task it returns;
- `list_tasks` reads the external links of the tasks on the page it returns,
  in one statement after the board, and no other task's;
- a label read reads about fifteen rows for each task carrying the label in
  that project, however many tasks the project has;
- a task's custom field values are part of its row, so they cost no row of
  their own, and a filter by them tests the rows the read reaches anyway; it
  adds one statement, which reads the project's fields;
- the statements a read runs do not grow with the number of projects or
  tasks: at most six, for a board filtered by a custom field.

[`read-cost.test.ts`](../workers/api/test/api/read-cost.test.ts) seeds a store
of eight projects and about 7,000 tasks and fails when a read goes over its
budget. Run it with `--silent=false` to print each read's statements and rows
read. [`store.test.ts`](../workers/api/test/store.test.ts) checks that a
repeated read reads no rows.
