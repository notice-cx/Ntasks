# The task store

The task store is the Durable Object behind Ntasks: one Cloudflare object
with its own SQLite database, which holds the tables of projects and tasks,
enforces the rules on them, and runs the engine that every part of Ntasks
reads and writes through. It is written for
contributors working on the engine, the API or the import from Beads. Read
[Concepts](concepts.md) first for the task model, and
[Architecture](architecture.md) for where the store sits.

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
| `projects` | Each project's id, key, name and task id prefix |
| `tasks` | One row per task: its fields, its current close, its version |
| `task_labels` | A task's labels, one row each |
| `task_edges` | Links between tasks: `blocks`, `related`, `discovered-from`, `duplicates` and `supersedes` |
| `task_external_links` | Links from a task to pages outside Ntasks: a URL, a title and optionally a kind, `pull-request`, `document` or `other` |
| `custom_fields` | The custom fields each project defines: key, name, type, options, and when it was retired |
| `task_comments` | Comments, in the order they were added |
| `task_events` | Every change to every task, in order |
| `write_receipts` | Retry records: a write's idempotency key, its request and its answer |
| `store_loads`, `store_load_pages` | A load into the empty store that waits to be committed, and its pages of rows. They hold nothing once a load ends, and a backup leaves them out. |

A task's parent is the `parent_id` column, not a link. Sign-in and access
grants have their own tables, in D1 ([Sign-in](sign-in.md#tables)).

A task's text is in four Markdown columns of `tasks`: `description`,
`acceptance`, `notes` and `design`. The database sets no length limit on
them, so a task imported from Beads fits; a new write through the API takes
at most 8,192 characters in each (`TASK_LIMITS` in
[`task.ts`](../packages/domain/src/task.ts)). `estimate_minutes` holds the
task's estimate in whole minutes, or null when nobody estimated it.

A link in `task_edges` reads from `task_id` to `depends_on_id`: `web-2`
`duplicates` `web-1` means web-2 is the same work as web-1, filed again, and
`web-3` `supersedes` `web-1` means web-3 replaces it. Only `blocks` holds a
task out of ready work. A task links to another task once, whatever the type.

A task's external links are http or https URLs, kept as the URL standard
writes them, so one page has one URL and a task links to it once. The
database allows URLs of at most 2,048 characters; a new write through the API
also takes at most 32 links on a task and 512 characters in a title.

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

A backup holds every row of the tables above but the two a load waits in, in
their order, as stored ([API](api.md#backing-up-the-whole-store)). An import
or a backup loads into an empty store in one transaction: through
`importRows`, with the statements an import uses, or through
[a load](api.md#loading-an-empty-store), whose pages wait in
`store_load_pages` until the commit inserts them all with one statement per
table. Either way the store checks foreign keys when the transaction ends,
since a backup lists tasks by id and a parent's id can sort after its
child's.

## Rules the database enforces

These hold whatever code writes to the database. Each has a test in
`schema.test.ts`.

- The CHECK lists of statuses, types, link types, resolutions, history
  event kinds, external link kinds and custom field types match the lists in
  `packages/domain/src/task.ts`.
- A task is closed exactly when it records when and how it closed, and close
  details are empty while it is not closed.
- Every update of a task raises its `version` by exactly one.
- A task keeps its id, its project and its creation time.
- Tasks, their history and their comments are never deleted, and history and
  comments are never edited.
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

- **Reads:** `getTask`, `getTasks`, `findTasks`, `listTasks`, `listBoard`,
  `listEpics`, `listLabelled`, `listExternalLinks`, `listFields`, `listWork`,
  `listComments`, `listHistory`, `listChanges`, `lint` and `recordedWrite`.
  `listTasks` and `listBoard` take filters by custom field values.
  `listWork` reads, for the projects named, the tasks in progress or blocked
  and those closed from a time, with only the columns agent statistics count:
  one statement, through the `(project_id, status)` and
  `(project_id, closed_at)` indexes.
  `listTasks` reads one project a page at a time; `listBoard` reads a whole
  board, in one project or in every project, in one round trip.
  `recordedWrite` returns what an earlier write with an idempotency key
  answered, so the API can answer a retry before it checks a rule that the
  write's own effect would break, such as a close's rule that the task is
  open.
- **Writes:** `createTask`, `writeTask`, `addComment` and `recordUnchanged`.
  Each is one batch. `createTask` can open an approval the new task waits on.
  `writeTask` takes everything one change does at once: field changes,
  labels, links, metadata, a close or a reopen, an approval request and a
  comment, and in `others` changes to other tasks of the project, such as
  the comment and hand-back a decision on an approval gives the tasks waiting
  on it. Each of those names the version it read, as the write does; one
  that only comments leaves its task's version as `addComment` does.
  `recordUnchanged` writes only the retry record of a change that
  found nothing to change, so its key answers a retry and cannot be reused
  for another change; the task's version and history stay as they were.
- **Projects:** `listProjects` and `createProject`.
- **Custom fields:** `defineField` and `retireField`, each one batch, which
  writes a retry record when the call carries a retry identity (an MCP
  `idempotency_key` or an HTTP `Idempotency-Key` header); without one, a
  repeated definition is refused rather than replayed. A key the project has
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
gate, and neither it nor its parent is deferred past now. `READY` in
[`reads.ts`](../workers/api/src/engine/reads.ts) is that rule, and both the
ready filter and every task's `ready` flag use it.

### Where each NoticeOS operation goes

NoticeOS sent these operations to Beads, some of them as several `bd`
commands in a row (`scripts/hosted-task-command.mts` in NoticeOS). Each is one
engine call. Its checks of who may decide, such as matching an owner's answer
to the proposal they saw, stay in the API layer, which is ported from that
file: [`task-writes.ts`](../workers/api/src/task-writes.ts) holds the checks
of the writes the API offers, and
[`owner-answers.ts`](../workers/api/src/owner-answers.ts) those of a person's
decisions and of the owner answers agents record. The proposal a comment was
written against comes from the task's history in `task_events`, where
NoticeOS read Dolt's versions of the task.

| NoticeOS operation | Engine call |
|---|---|
| `list` | `listTasks` with statuses or close times |
| `active-board`, `closed-board` | One `listBoard` with the open statuses and `closedSince` |
| `ready` | `listBoard` or `listTasks` with `ready: true` |
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
