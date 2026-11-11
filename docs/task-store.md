# The task store

The task store is the Durable Object behind Ntasks: one Cloudflare object
for each workspace, with its own SQLite database, which holds the tables of
that workspace's projects and tasks, enforces the rules on them, and runs the
engine that every part of Ntasks reads and writes through. This page is
written for contributors working on the engine, the API or the import from
Beads. Read [Concepts](concepts.md) first for the task model, and
[Architecture](architecture.md) for where the store sits.

A workspace's store is the object named `workspace:` followed by the
workspace's id (`workspaceStore` in
[`store/index.ts`](../workers/api/src/store/index.ts)), created by the first
request that reaches it. Every store has the same schema and engine, and
neither knows of workspaces: the Worker picks the store, and hands it the
sender with its scopes and projects in that workspace. A store answers an
HTTP request with `serve` and an MCP tool call with `callTool`, both over
Durable Object RPC. Two workspaces may each hold a project with the same id
or prefix, since no query reads across stores.

| Part | Where |
|---|---|
| Schema | [`workers/api/src/store/migrations/`](../workers/api/src/store/migrations/) |
| The store object, its read cache and its SQLite access | [`workers/api/src/store/`](../workers/api/src/store/) |
| Vocabulary and record shapes | [`packages/domain/src/task.ts`](../packages/domain/src/task.ts) |
| Engine contract | [`packages/domain/src/engine.ts`](../packages/domain/src/engine.ts) |
| The engine | [`workers/api/src/engine/`](../workers/api/src/engine/) |
| Lint rules, from Beads | [`packages/domain/src/lint.ts`](../packages/domain/src/lint.ts) |
| The tables' rows, as an import writes and reads them | [`packages/domain/src/store-rows.ts`](../packages/domain/src/store-rows.ts) |
| Loading an import from Beads or a backup | [`workers/api/src/store/import.ts`](../workers/api/src/store/import.ts) |
| A backup's pages, and its format | [`workers/api/src/store/backup.ts`](../workers/api/src/store/backup.ts), [`packages/domain/src/backup.ts`](../packages/domain/src/backup.ts) |
| A load into the empty store, page by page | [`workers/api/src/store/load.ts`](../workers/api/src/store/load.ts), [`packages/domain/src/load.ts`](../packages/domain/src/load.ts) |
| Tests of the schema's rules | [`workers/api/test/schema.test.ts`](../workers/api/test/schema.test.ts) |
| Tests of the engine | [`workers/api/test/engine/`](../workers/api/test/engine/) |

## Tables

| Table | Holds |
|---|---|
| `projects` | Each project's id, key, name and task id prefix, whether its changes go live by a deploy (`deploys`), when an owner disabled it (`disabled_at`, null while it takes new tasks), and its website (`website_url`) |
| `project_icons` | The icon read from each project's website: the address it came from, its image type, its bytes and when it was read. A new website replaces it, and a backup leaves it out ([API](api.md#a-projects-website-and-icon)) |
| `tasks` | One row per task: its fields, its current close and delivery, its version |
| `task_labels` | A task's labels, one row each |
| `task_edges` | Links between tasks: `blocks`, `related`, `discovered-from`, `duplicates`, `supersedes` and `merges-after` |
| `task_external_links` | Links from a task to pages outside Ntasks: a URL, a title and optionally a kind, `pull-request`, `document` or `other` |
| `custom_fields` | The custom fields each project defines: key, name, type, options, and when it was retired |
| `task_comments` | Comments, in the order they were added, each marked when it is pinned |
| `task_events` | Every change to every task, in order |
| `task_aliases` | Each former id of a task that moved to another project, and the task's id now |
| `write_receipts` | Retry records: a write's idempotency key, its request and its answer |
| `store_loads`, `store_load_pages` | A load into the empty store that waits to be committed, and its pages of rows. They hold nothing once a load ends, and a backup leaves them out. |

A task's parent is the `parent_id` column, not a link. Sign-in, workspaces
and access grants have their own tables, in D1 ([Sign-in](sign-in.md#tables)).

A task's text is in four Markdown columns of `tasks`: `description`,
`acceptance`, `notes` and `design`. The database sets no length limit on
them, so a task imported from Beads fits; a new write through the API takes
at most 8,192 characters in each (`TASK_LIMITS` in
[`task.ts`](../packages/domain/src/task.ts)). `estimate_minutes` holds the
task's estimate in whole minutes, or null when nobody estimated it.

A task's work in hand is two columns of `tasks`: `assignee_for`, the helper
agent its holder works through, and `work`, the details its holder recorded
(`session`, `worktree`, `branch`, `pr`, `commit` and `next`, and `touches`,
a list of the files or other things the work changes) as one JSON
object, so a new detail needs no new column (`WORK_DETAILS` and
`WORK_LIMITS` in [`task.ts`](../packages/domain/src/task.ts)). The engine
clears both in the write that releases the task, gives it to someone else or
closes it. A task's last activity is not stored: a read takes the latest
`task_events` row its assignee made, which the `task_events_by_actor` index
`(task_id, actor, at)` answers from one entry, so every write and comment
the holder makes moves it without a write of its own.

A link in `task_edges` reads from `task_id` to `depends_on_id`: `web-2`
`duplicates` `web-1` means web-2 is the same work as web-1, filed again, and
`web-3` `supersedes` `web-1` means web-3 replaces it, and `web-4`
`merges-after` `web-1` means web-4's pull request lands only once web-1's
has. Only `blocks` holds a
task out of ready work. A task links to another task once, whatever the type.

A task that moves to another project takes an id with that project's
prefix, and its old id becomes a row of `task_aliases` naming the new one. A
trigger records it in the statement that changes the task's id, and moves
the task's labels, links in both directions, external links, comments and
history to the new id in the same statement; each history event keeps the
`project_id` the task was in when it was recorded, so a read of a task's
history reads its events by task, not by project. A task that moves again
keeps each former id, each naming its id now. The tasks that name a moved
task as their parent or the task they duplicate are the engine's to change,
each with a new version and a history event, so the batch defers foreign
keys until it commits.

A task's external links are http or https URLs, kept as the URL standard
writes them, so one page has one URL and a task links to it once. The
database allows URLs of at most 2,048 characters; a new write through the API
also takes at most 32 links on a task and 512 characters in a title.

A task's delivery ([concepts](concepts.md#where-a-change-is)) is seven
columns of `tasks`: `delivery_stage` (`built`, `merged` or `live`),
`delivery_commit`, `delivery_pull_request`, `delivery_merge_commit`, and
`built_at`, `merged_at` and `live_at`. A signal names pull requests and
commits, and reaches the tasks carrying them through one index on each of the
three, never through a project's history: a commit matches by prefix, so it
reads the range of the index that shares its first 7 characters.
`tasks_by_project_stage` reaches a project's tasks at a stage, whenever they
closed. A close as done may also name a link, a URL that shows work no commit
or pull request shows, in `close_link`; like the rest of the close, only a
task closed as done has one, and a reopen clears it.

A request that a person do steps is a gate with its steps in the `steps`
column of `tasks`: one JSON array, in order, each step holding its `text`, its
`command` or null, and what the person recorded on it, `done`, `note` and
`stuck`, each null or the person, the time and any connected app (`TaskStep` in
[`task.ts`](../packages/domain/src/task.ts)). The database takes steps only on
a gate, and at least one. An approval and every other task has none. A tick
rewrites the whole array in one write, so the task's history holds the steps
as they stood after each mark. The engine refuses a write that changes a
step's text or command, or the number of steps.

The open tasks one holder holds are read through `tasks_by_assignee`, one
entry for each task held, with each task's last activity from
`task_events_by_actor`: the list an agent reads when it connects.

A task's values of its project's custom fields are the `field_values` column
of `tasks`: one JSON object by field key, holding text, a number, true or false,
or a list of options. Being part of the task's row, they cost a read no row of
its own, and a filter by them tests rows the read reaches through its index
anyway. A field's type and options are in `custom_fields`, and the engine
checks each value against them in the write that sets it. A retired field
takes no new value: the batch that sets a value fails as `version_conflict`
when its field was retired after the write checked it, and the write is
checked again. The database does not refuse a value of a retired field
itself, so an import can load a retired field with the values tasks had.

A backup holds every row of one workspace's store, in the tables above but the two a load waits in, in
their order, as stored ([API](api.md#backing-up-the-whole-store)). An import
or a backup loads into an empty store in one transaction: through
`importRows`, with the statements an import uses, or through
[a load](api.md#loading-an-empty-store), whose pages wait in
`store_load_pages` until the commit inserts them all with one statement per
table. Either way the store checks foreign keys when the transaction ends,
since a backup lists tasks by id and a parent's id can sort after its
child's. While a row waits for a task loaded after it, SQLite looks up each
new task's id in every column that names a task. Each of those columns has an
index, `tasks_by_duplicate_of` among them, so a commit reads a few rows for
each row it writes rather than the whole table for each task.

## Rules the database enforces

These hold whatever code writes to the database. Each has a test in
`schema.test.ts`.

- The CHECK lists of statuses, types, link types, resolutions, history
  event kinds, external link kinds and custom field types match the lists in
  `packages/domain/src/task.ts`.
- A task is closed exactly when it records when and how it closed, and close
  details are empty while it is not closed.
- Only a task closed as done with a commit or a pull request has a delivery,
  and a task without a stage records no delivery at all. A commit is 7 to 64
  lowercase hexadecimal characters; a merged task records when it merged,
  and only a live one when it went live.
- A task's helper and work details are empty while nobody holds it, and once
  it is closed.
- Every update of a task raises its `version` by exactly one.
- A task keeps its creation time. It keeps its id and its project too, except
  in a move to another project, where it takes an id that starts with that
  project's prefix and is no task's former id.
- A move records the task's old id in `task_aliases`. A former id is never
  removed, never becomes a new task's id, and changes only the task id it
  names, to the id that task moved to.
- Tasks, their history and their comments are never deleted, and history and
  comments are never edited. The one change a comment takes is being
  unpinned, and a comment once unpinned is never pinned again; beyond that,
  a comment and a history event follow their task's move to its new id.
- A project prefix has no hyphen, and a task never depends on itself.
- A custom field keeps its project, key, type and options, stays retired once
  retired, and is never deleted. A choice field has options and no other
  field does. A task's `field_values` is a JSON object.

### The write guard

The store runs a batch of statements as one transaction, but a conditional
update that matches no row does not fail it. The `write_guard` view turns that case
into a failure. Right after a statement that must change exactly one row, the
engine inserts into the view whether it did:

```sql
UPDATE tasks SET title = ?, version = version + 1, updated_at = ?
  WHERE id = ? AND version = ?;
INSERT INTO write_guard (ok, refusal) VALUES (changes() = 1, 'version_conflict');
INSERT INTO task_events (...) VALUES (...);
```

When the update matched no row, the insert fails with
`ntasks refused: version_conflict`, the store rolls back the whole batch, and
`guardRefusalOf()` in the domain package reads the refusal from the error.
The guard reports `not_found`, `version_conflict` and `cycle`.

## The engine contract

`TaskEngine` in `engine.ts` has three kinds of methods:

- **Reads:** `getTask`, `getTasks`, `findTasks`, `formerIds`, `listUnder`,
  `listBoard`,
  `listEpics`, `listLabelled`, `listExternalLinks`, `listFields`, `listWork`,
  `listComments`, `parentContext`, `listHistory`, `listChanges`, `lint` and
  `recordedWrite`. `listBoard` takes filters by custom field values. `parentContext` reads, in one statement, a task's parent, the
  parent's newest pinned comments through `task_comments_pinned`, and its most
  recently closed other children through `tasks_closed_by_parent`, with the
  totals of each.
  `listWork` reads, for the projects named, the tasks in progress or blocked
  and those closed from a time, with only the columns agent statistics count:
  one statement, through the `(project_id, status)` and
  `(project_id, closed_at)` indexes.
  `listBoard` reads a whole board, in one project or in every project, in
  one round trip. A caller that returns a page of it, as `list_tasks` does,
  reads the board with `withoutExternalLinks: true`, then the page's external
  links with `listExternalLinks`.
  `formerIds` reads which of some ids are moved tasks' former ids, through
  the table's key, and `listUnder` every task under some tasks, at any depth,
  through `tasks_by_parent`.
  `recordedWrite` returns what an earlier write with an idempotency key
  answered, so the API can answer a retry before it checks a rule that the
  write's own effect would break, such as a close's rule that the task is
  open.
- **Writes:** `createTask`, `writeTask`, `moveTasks`, `addComment` and
  `recordUnchanged`.
  Each is one batch. `createTask` can open an approval the new task waits on.
  `writeTask` takes everything one change does at once: field changes
  (the holder's helper and work details among them), labels, links,
  metadata, a close or a reopen, an approval request and a comment, which
  its result returns, and in `others` changes to at most 500 other tasks of the project
  (`TASK_LIMITS.others`), such as the comment and hand-back a decision on an
  approval gives the tasks waiting on it. Each of those names the version it
  read, as the write does, and the whole batch fails as `version_conflict`
  when one of them moved since; one that only comments leaves its task's
  version as `addComment` does, and so does a write whose comment comes with
  a helper and work details that change nothing.
  `moveTasks` puts up to 50 tasks (`TASK_LIMITS.move`), each named with the
  version it read and the task it goes under, into one project in one batch.
  A task from another project takes its new parent's next child id, which
  counts the child ids former ids hold, or a new key, and moves only with
  every task under it among the tasks placed. `recordedMove` answers a
  retried move as `recordedWrite` answers a retried write.
  `recordUnchanged` writes only the retry record of a change that
  found nothing to change, so its key answers a retry and cannot be reused
  for another change; the task's version and history stay as they were.
  A retry identity marked `derived` (a key the API derived from an MCP
  call's arguments) also records the version the write left each task it
  wrote at, and marks a record of new tasks. Its record answers only while
  every one of those tasks stands at that version, and a record of new tasks
  also only for 24 hours; after that the same request is a new write, and
  its batch replaces the stale record. The record carries this rule, so
  `recordedWrite` reads it as the write does. A key a caller chose keeps
  rule 3 unchanged.
- **Projects:** `listProjects`, `createProject`, which
  `POST /api/tasks/projects` ([API](api.md#writes)) calls, `updateProject`,
  which renames a project, sets whether it deploys and whether it is
  disabled, and replaces its website with the icon read from it in one
  batch, and `projectIcon`, which reads that icon; an import writes its
  projects' rows itself.
- **Delivery:** `reportDelivery` moves the closed tasks of the projects named
  whose pull request, commit or merge commit a signal matches, each move with
  its history, in one batch ([API](api.md#delivery)). A close as done that
  carries `commit` or `pullRequest` starts a task's delivery, and a reopen
  clears it. `listBoard` with `stages` reads closed tasks at those stages.
- **Custom fields:** `defineField` and `retireField`, each one batch, which
  writes a retry record when the call carries a retry identity (every MCP
  call, keyed by its `idempotency_key` or else by its arguments, and an HTTP
  write with an `Idempotency-Key` header); without one, a repeated definition
  is refused rather than replayed. A key the project has
  used, retired or not, is refused as
  `invalid`, and so is a field past the project's 64.

The engine checks the task model's rules. It does not check who may act: the
API layer signs the sender in and passes the engine an `Actor`.

### Refusals

A refused write throws `TaskRefused`, whose `refusal` names why. Nothing of a
refused write is stored.

| Refusal | When |
|---|---|
| `not_found` | The project, the task or a task the write names does not exist |
| `version_conflict` | The task changed after the caller read it (rule 2) |
| `cycle` | A `blocks` link or a parent would make tasks wait on each other in a loop |
| `held` | A claim on a task someone else holds (rule 1) |
| `retry_conflict` | An idempotency key reused for a different request or project (rule 3) |
| `invalid` | An input breaks the model or `TASK_LIMITS`; the message names the field |

### Ready work

Ready work follows Beads' rule. A task that is not closed is blocked when it
has a `blocks` link onto a task that is not closed, or when its parent is
blocked, down any depth. A task is ready when it is open, not blocked, not a
gate, and neither it nor its parent is deferred past now. Ntasks adds one
exception: a task labelled `human` that is not an epic is held only by its own
`blocks` links, not by a blocked parent, while the tasks under it stay
blocked. `READY` in
[`reads.ts`](../workers/api/src/engine/reads.ts) is that rule, and both the
ready filter and every task's `ready` flag use it.

### Where each NoticeOS operation goes

NoticeOS sent these operations to Beads, some of them as several `bd`
commands in a row (`scripts/hosted-task-command.mts` in NoticeOS). Each is one
engine call. Its checks of who may decide, such as matching an owner's answer
to the proposal version they saw, stay in the API layer:
[`task-writes.ts`](../workers/api/src/task-writes.ts) holds the checks
of the writes the API offers, and
[`owner-answers.ts`](../workers/api/src/owner-answers.ts) those of a person's
decisions and of the owner answers agents record.

| NoticeOS operation | Engine call |
|---|---|
| `list` | `listBoard` with statuses or `closedSince` and `withoutExternalLinks: true`, then `listExternalLinks` for the page it returns |
| `active-board`, `closed-board` | One `listBoard` with the open statuses and `closedSince` |
| `ready` | `listBoard` with `ready: true` |
| `show` | `getTask` |
| `find` | `findTasks` |
| `history` | `listHistory` |
| `comments` | `listComments` |
| `epics` | `listEpics` |
| `snapshot` | `listChanges` |
| `lint` | `lint` |
| `create` | `createTask`, with `requestApproval` when the new task asks for an approval |
| `update`, `depend`, `undepend`, `relate`, `hand-back` | `writeTask` with `set`, labels, `addLinks` or `removeLinks` |
| `comment` | `addComment` |
| `close`, `dismiss` | `writeTask` with `close` |
| `attribute` | Nothing separate: the close records the closer, model and resolution itself |
| `gate` | `writeTask` with `requestApproval`, after the API looks for an open approval asking the same |
| `resolve-gate` | `writeTask` with `close` on the gate |
| `dispute` | One `writeTask`: the withdrawn record in metadata, the comment and `reopen` on the gate, and in `others` a comment on each task waiting on it |
| `respond`, `choose`, `record-choice` | One `writeTask`: the choice, the comment, and the close or hand-back |
| `maintain`, `record-maintenance` | One `writeTask`: the maintenance record in metadata, the comment, the close or hand-back, and in `others` the comments, links and hand-backs of the tasks waiting on it |
| Agent statistics | `listWork`, where NoticeOS read two boards of each project |

### Where NoticeOS's task metadata goes

Beads had no fields for some facts, so NoticeOS kept them in task metadata.
In Ntasks they are columns, written in the same batch as the change they
describe.

| NoticeOS metadata | Ntasks |
|---|---|
| `noticeos_filed_by`, `noticeos_filed_model` | `tasks.filed_by`, `tasks.filed_model` |
| `noticeos_claimed_model` | `tasks.assignee_model` |
| `noticeos_closed_by`, `noticeos_closed_model`, `noticeos_closed_at` | `tasks.closed_by`, `tasks.closed_model`, `tasks.closed_at` |
| `noticeos_resolution`, `noticeos_duplicate_of` | `tasks.resolution`, `tasks.duplicate_of` |
| `noticeos_choices`, `noticeos_choice` | `tasks.choices`, `tasks.choice` |
| `noticeos_related_tasks` | `task_edges` rows of type `related` |
| `noticeos_operation_id` | `write_receipts` |
| Every other key, such as `noticeos_card` | `tasks.metadata`, stored and returned as given |

## Beads behaviour in and out of scope

| In scope | Out of scope |
|---|---|
| Tasks as a graph with `blocks`, `related`, `discovered-from`, `duplicates` and `supersedes` links | The `waits-for` and `conditional-blocks` link types |
| Parents and children, with child ids such as `web-a1b2.3` | Prefixes with hyphens, and ids whose key has hyphens |
| Ready work, worked out on the server | Claims that expire as leases, and heartbeats |
| Epics that can close once their children have | Formulas, molecules and wisps |
| Approvals (gates a person answers) and decisions | Dolt branches, merges and sync |
| Labels, comments, metadata and the full history of every task | |
| Notes, design and estimated minutes | |

An import from Beads refuses a task that uses something out of scope and
names it, rather than dropping it. [`tools/migrate`](../tools/migrate/README.md)
is that import, with the export before it and a verifier after.
