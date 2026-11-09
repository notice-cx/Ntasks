# @ntasks/migrate

Moves a [Beads](https://github.com/gastownhall/beads) task hub that runs on
Dolt into the Ntasks task store, with its full history, backs a task store
up and restores it ([below](#back-up-and-restore)), loads an import or a
backup into an empty deployed store ([below](#load-into-the-deployed-store)),
turns a seed of invented tasks into a backup that loads
([below](#seed-a-store)), and provisions a deployment nobody signs in to
([below](#provision-a-deployment-nobody-signs-in-to)). **Dolt** is the
versioned SQL database Beads stores tasks in. The **task store** is the
Durable Object that holds Ntasks' tasks in its own SQLite database
([The task store](../../docs/task-store.md)). Three commands move a hub:

| Command | Reads | Writes |
|---|---|---|
| `export` | The hub, through a Dolt SQL client, with read-only queries | One export file, readable only by its owner (mode 600). It never writes over an existing file |
| `import` | The export file | With `--check`, nothing. With `--store`, a new local copy of the task store: a SQLite file with the store's schema |
| `verify` | The export file, or a backup file, and a store copy | Nothing. It prints the comparison and fails on any difference |

A store copy is made from the store's own migration files
([`workers/api/src/store/migrations/`](../../workers/api/src/store/migrations/))
and loaded with the same statements the store runs
([`packages/domain/src/store-rows.ts`](../../packages/domain/src/store-rows.ts)),
so a dry run needs no Worker and reaches nothing outside the machine.

A deployed store takes an import or a backup through its restore routes, page
by page, and writes it in one transaction
([`load`](#load-into-the-deployed-store)).

## Run a migration

Run each command from the repository root with the Node.js version in
[`.node-version`](../../.node-version), after `pnpm install`.

1. Write a hub file (below), and list the queries the export would send.
   This connects to nothing:

   ```sh
   node tools/migrate/src/cli.ts export --hub hub.json --describe
   ```

2. Export the hub into a new file:

   ```sh
   node tools/migrate/src/cli.ts export --hub hub.json --out export.json
   ```

3. Check that the export imports. This prints every refusal, or what the
   import holds, and writes nothing:

   ```sh
   node tools/migrate/src/cli.ts import --from export.json --check
   ```

4. Import it into a new store copy:

   ```sh
   node tools/migrate/src/cli.ts import --from export.json --store store.sqlite
   ```

5. Verify the store copy against the export:

   ```sh
   node tools/migrate/src/cli.ts verify --from export.json --store store.sqlite
   ```

`import` and `verify` print what a store holding the import costs against
the free plan's limits ([Architecture](../../docs/architecture.md)): its
size, against the 5 GB that Durable Objects store, and the rows written to
load it, against the 100,000 the task store may write in a day. The rows
written count each row and each index entry on its table, so it is an upper
bound.

The export file and the store copy hold the hub's task data. Keep them
private, and delete them when the migration is done.

### The hub file

The hub file says how to reach the hub and which Dolt databases to read, one
per project. It names the file that holds the password, never the password.

```json
{
  "client": ["/usr/local/bin/dolt", "--host=127.0.0.1", "--port=3306", "--user=tasks", "--no-tls", "sql", "--result-format=json", "--query"],
  "passwordFile": "/path/to/private/password",
  "projects": [
    { "database": "acme_tasks", "key": "acme.example.com", "name": "Acme", "id": "a1111111-0000-4000-8000-000000000001", "prefix": "acme" }
  ]
}
```

| Field | Meaning |
|---|---|
| `client` | The SQL client command. Each query is added as its last argument, and the client must print Dolt's JSON result format |
| `passwordFile` | Optional. Its content, without the final line break, reaches the client as `DOLT_CLI_PASSWORD` |
| `env` | Optional. More environment variables for the client |
| `projects[].database` | The Dolt database that holds the project |
| `projects[].key`, `.name` | The project's key and name in Ntasks |
| `projects[].id` | Optional. The project's id in Ntasks. Give the NoticeOS project id, so the ids agents use keep working. Left out, it is the database's own `_project_id`, which Beads chose and NoticeOS does not use |
| `projects[].beadsProjectId`, `.prefix` | Optional. The export stops if the database holds a different `_project_id` or prefix |

The client runs with an empty, private home folder of its own and only
`PATH`, the password and the variables in `env`, so no other Dolt or Beads
setting reaches it. Dolt's usage reporting is turned off.

## What the export reads

The export works in five steps. Each step runs as one read-only transaction,
which the export ends with `ROLLBACK`, so it cannot write to the hub. Before
each query, and after the last, it sends a marker query that only prints a
random value back, so it can tell which output answers which query.
`export --describe` prints every statement it sends.

1. The Dolt version.
2. For every database, the hash of its branch head, which changes with any
   commit, and of its working set, which changes with any write, including
   to tables Dolt is told to ignore, such as Beads' audit log.
3. For each database, the project id (`_project_id` in the `metadata` table),
   the task id prefix (`issue_prefix` in the `config` table), and no other
   setting, and the names of its tables.
4. In one transaction for all databases, so it is one snapshot of the hub:
   the project id, prefix and table names again, which must match step 3,
   the row count of every table, the Dolt branches and commits (`dolt_log`),
   every row of `issues`, `labels`, `dependencies`, `comments` and `events`,
   and every change ever made to `issues`, `labels` and `dependencies`,
   commit by commit (`dolt_diff_<table>`).
5. Step 2 again. If any database's hashes changed, the hub was written to
   during the export, and the export stops without writing a file.

## How Beads data becomes Ntasks rows

[The task store](../../docs/task-store.md#where-noticeoss-task-metadata-goes)
defines where each NoticeOS metadata key goes; the import follows it.
[`src/task-state.ts`](src/task-state.ts) holds the rules below.

| Beads | Ntasks |
|---|---|
| Project | `projects.id` is the hub file's id, else the database's `_project_id`; `projects.prefix` is the database's `issue_prefix`; the key and name come from the hub file, and the creation time is the earliest commit or task |
| Issue id, title, description, status, priority, type, assignee, start, defer and due times | The same `tasks` columns; `acceptance_criteria` is `acceptance` |
| `notes`, `design` | `tasks.notes`, `tasks.design` |
| `estimated_minutes` | `tasks.estimate_minutes`, in whole minutes; none when Beads recorded none |
| Type `spike`, which Ntasks lacks | Type `task`, with the label `spike` |
| `created_at`, `updated_at` | `tasks.created_at`, `tasks.updated_at`, kept as they are |
| `created_by` | `tasks.filed_by`, unless NoticeOS recorded `noticeos_filed_by` |
| `await_type` `human` on a gate | `tasks.await_type` |
| A closed issue's `closed_at` and `close_reason` | `tasks.closed_at`, `tasks.close_reason` |
| NoticeOS's closer, model and resolution | `closed_by`, `closed_model`, `resolution`, `duplicate_of`, when they describe the current close, as NoticeOS reads them (`readTaskResolution`); otherwise the close is `done` with no recorded closer |
| `noticeos_claimed_model` | `tasks.assignee_model`, while the task has an assignee |
| `noticeos_choices`, `noticeos_choice` | `tasks.choices`, `tasks.choice` |
| Every other metadata key, such as `noticeos_card`, `noticeos_card_shipped` and `noticeos_operation_id` | `tasks.metadata`, as given. A retry record needs the sender's key and request, which Beads did not keep, so an operation id stays in metadata |
| `parent-child` link | `tasks.parent_id` |
| `blocks`, `related`, `discovered-from`, `duplicates` links | `task_edges` rows of the same type, with Beads' creation time and author |
| `relates-to` links, which `bd relate` writes in both directions | `related` rows in `task_edges`, both directions kept |
| `supersedes` links | `supersedes` rows in `task_edges`, turned around: `bd supersede old --with new` records `old supersedes new`, meaning old is superseded, while in Ntasks `new supersedes old` means new replaces old. So the link moves to the replacing task, in every past version too, and the replacing task must be in the same Beads database |
| A link to a task in another Beads database, which Beads keeps as the task's id in `depends_on_external` | A `task_edges` row of the same type, like any other link between projects |
| A link to a web address outside the hub (`depends_on_external`) | A `task_external_links` row: the address as the URL standard writes it, also as its title, with Beads' creation time and author |
| `noticeos_related_tasks` | `related` rows in `task_edges`, dated by the change that added them |
| Labels | `task_labels` |
| Comments | `task_comments`, ids kept, and a `commented` history event each |
| `content_hash`, `is_blocked`, `row_lock` | Nothing: Beads computes them from the other columns, or keeps them to lock a row |

Times become UTC ISO 8601 with milliseconds. Dolt prints a time without a
zone, and Beads writes them in UTC.

Through a Dolt server, the SQL client prints every value as text. So `"0"` in
one of Beads' number columns, such as `pinned`, and `"{}"` in a JSON column,
such as a link's `metadata`, read as empty
([`src/task-state.ts`](src/task-state.ts) lists those columns). The same text
in a text column, such as `notes`, is something someone wrote, and is refused.

A task that is not closed has no close in Ntasks. A close time, reason or
closer that Beads or NoticeOS left behind from an earlier close stays in
that close's history event.

### History

Each task's history is rebuilt from Dolt's record of every change to
`issues`, `labels` and `dependencies`. Replaying the changes commit by commit
gives every state a task passed through; each state that differs from the
one before is a version, and becomes a `task_events` row:

- the first version is a `created` event holding every field, at the task's
  creation time;
- each later version is a `closed`, `reopened` or `updated` event holding
  only the fields that changed, at its commit's time;
- each comment is a `commented` event at its own time.

The fields are those the engine's own history records, so applying a task's
events in order rebuilds the task, and `tasks.version` is its number of
versions. The actor of a version is the one Beads' audit log (`events`) names
for that task in the same second, when exactly one does; otherwise the
commit's committer, or `unknown` for a change not yet committed. A model is
recorded where NoticeOS recorded one: the filer's, the claimer's and the
closer's. Historical actor names grant no access in Ntasks.

`task_events.seq` orders every event of every task by time.

## What the import refuses

The import writes nothing unless the whole export maps. It prints every
problem, each naming the task or project, so one run shows them all.

Out of scope, as [the task store](../../docs/task-store.md#beads-behaviour-in-and-out-of-scope)
lists:

- links of any type other than `blocks`, `related`, `relates-to`,
  `discovered-from`, `duplicates`, `supersedes` and `parent-child`, such as
  `waits-for` and `conditional-blocks`;
- a prefix with a hyphen, and any id that is not an Ntasks task id;
- statuses and types outside Ntasks' lists;
- wisps, molecules, formulas and templates, and approvals that wait on
  anything but a person;
- links to wisps, and links outside the hub that are not web addresses, such
  as Beads' `external:<project>:<capability>`, which waits for another
  project to ship something;
- tasks Beads compacted;
- a Dolt database with more than one branch.

Data the import cannot carry whole:

- a column that holds a value Ntasks has no field for, such as
  `external_ref`, quoting the value;
- a table holding rows that the import neither reads nor knows to be Beads'
  own bookkeeping;
- a link, parent or duplicate that names a task not in the export;
- tasks that wait on each other in a loop, other than the one below that is
  left out;
- a task whose Dolt history does not rebuild it as it stands;
- out-of-scope data in a task's past versions, with the time;
- empty comments and comments without an author or time.

## What the import leaves out

By the owner's choice, the import leaves these out. It lists each one it
leaves out, after what it imported:

- the `owner` column, which holds one identity, the same on every task of the
  NoticeOS hub;
- lease rows, which record when a claim expires: Ntasks never expires a claim,
  and the claim itself is the task's assignee;
- a parent's `blocks` link onto its own child, which makes each wait on the
  other. It is left out of every past version too, so the history still
  rebuilds the task.

## What the verifier checks

[`src/verify.ts`](src/verify.ts) compares a store with the export it was
imported from, three ways:

1. **Against the export's own rows:** tasks per project and status, every id,
   label, link, external link, parent and comment, every task's notes,
   design and estimate, every close's time and reason, the choices of
   decisions, approvals and whom they wait on, and every metadata key, such
   as the cards NoticeOS froze when a task shipped.
2. **Against the import plan,** row by row, for every table.
3. **Against itself:** each task's history must start with its creation,
   number its versions without gaps, end at the task's version, rebuild the
   task when replayed, and hold one event for each comment.

It prints the tasks per project and status, the totals, the size, and either
`0 differences.` or each difference.

## Back up and restore

Two commands back up a deployed task store and check the backup:

| Command | Reads | Writes |
|---|---|---|
| `backup` | Every page of the store's backup route, `GET /api/backup` ([API](../../docs/api.md#backing-up-the-whole-store)) | One backup file, readable only by its owner (mode 600). It never writes over an existing file |
| `restore` | The backup file | A new local store copy holding the backup's rows, which it then compares with the file, as `verify` does |

1. Make a service credential for backups: as the owner of the workspace to
   back up, `POST /api/access/services` with
   `{"name": "nightly-backup", "backup": true}`, naming the workspace in the
   `x-ntasks-workspace` header when you belong to several
   ([Sign-in](../../docs/sign-in.md#routes)). The credential reads that
   workspace's store alone. Save the token it answers in a file only you can
   read.

2. Back the store up:

   ```sh
   node tools/migrate/src/cli.ts backup --api https://tasks.example.com --token-file token --out backup.json
   ```

   The token goes only to an `https` address, or to `http://localhost` for a
   store `pnpm dev` runs. If the store is written to while the backup reads
   it, the route refuses the next page and the backup starts again, three
   times at most; run it when agents are quiet. It prints the rows of each
   table and the share of the day's 5,000,000 rows read it used.

3. Check that the file restores, into a new store copy:

   ```sh
   node tools/migrate/src/cli.ts restore --from backup.json --store restored.sqlite
   ```

   The copy is made with this checkout's store migrations, which must be
   exactly the backup's; restore a backup with the version of Ntasks it was
   taken from. It loads every row in one transaction and prints `0
   differences.` when every table holds exactly the backup's rows.

`verify --from backup.json --store restored.sqlite` compares a store copy
with a backup again. The backup file holds every task: keep it private.

## Load into the deployed store

`load` puts an import from Beads, or a backup, into a deployed store that
holds nothing yet, through its restore routes
([API](../../docs/api.md#loading-an-empty-store)):

1. It loads the file into a local copy of the store in memory and verifies
   it there, as `import` and `restore` do. If the file does not import or
   verify, it stops before sending anything.
2. It sends the copy's rows, each with every column as the store holds it,
   table by table in pages of at most 500 rows, and commits them. The store
   writes every row in one transaction, or none.
3. It reads the store back through its backup route and compares it with the
   file: an export through the import's verifier, a backup row by row. It
   prints `0 differences.` when they match.

The store must run the same version of Ntasks as this checkout: the load is
refused when its migrations differ. The credential needs the restore choice,
to load, and the backup choice, to read the store back.

### The cutover from a Beads hub

The last step of moving a hub to Ntasks, once nothing writes to the hub:

1. Export the hub, check that the export imports, and keep the file private
   ([Run a migration](#run-a-migration), steps 1 to 3).
2. As a deployment admin, create the workspace the hub's tasks go into:
   `POST /api/workspaces` with `{"name": "...", "workspaceId": "..."}`
   ([API](../../docs/api.md#workspaces)). Giving it the id of the NoticeOS
   workspace the hub served keeps agent instructions that name that id
   working. Then, as its owner, make a credential for the load in it:
   `POST /api/access/services` with
   `{"name": "cutover-load", "backup": true, "restore": true}`, naming the
   workspace in the `x-ntasks-workspace` header when you belong to several.
   Save its token in a file only you can read.
3. Load it:

   ```sh
   node tools/migrate/src/cli.ts load --api https://tasks.example.com --token-file token --from export.json
   ```

4. When it prints `0 differences.`, revoke the credential
   (`POST /api/access/services/<credential id>/revoke`) and delete the export
   and the token file.

A load refused at its commit writes nothing; `load` aborts it, and the store
stays empty, ready for another try.

## Seed a store

`seed` turns a seed file into a backup file, which `load` puts into an empty
deployed store and `restore` into a local store copy. A **seed** lists
projects and tasks written by hand or by another program, such as a product
demo's invented tasks, each task with the dated changes it went through. Its
tasks read as if they had been filed, claimed, commented on and closed
through the API: each has a history that rebuilds it, with who made each
change and the model they named.

```sh
node tools/migrate/src/cli.ts seed --from seed.json --check
node tools/migrate/src/cli.ts seed --from seed.json --out backup.json
```

`--check` prints every refusal, or what the seed holds and what loading it
costs against the free plan's limits, and writes nothing. `--out` also loads
the seed into a local copy of the store in memory, checks there that every
row is the one planned and that each task's history rebuilds it, and writes
the backup file, readable only by its owner and never over an existing file.
The file is a backup of this checkout's store, so load it into a store that
runs the same version of Ntasks.

```json
{
  "format": "ntasks-seed-v1",
  "projects": [
    { "id": "a1111111-0000-4000-8000-000000000001", "key": "recipes.example.com", "name": "Recipes", "prefix": "rcp", "createdAt": "2026-09-01T00:00:00.000Z" }
  ],
  "tasks": [
    {
      "id": "rcp-a1b2",
      "title": "Shrink the recipe card images",
      "labels": ["perf"],
      "createdAt": "2026-09-02T10:00:00.000Z",
      "createdBy": "Mara",
      "changes": [
        { "at": "2026-09-03T10:00:00.000Z", "by": "claude", "model": "Opus 5.5", "status": "in_progress", "assignee": "claude" },
        { "at": "2026-09-04T10:00:00.000Z", "by": "claude", "model": "Opus 5.5", "status": "closed", "close": { "reason": "Shipped in 1a2b3c4." } }
      ],
      "comments": [{ "author": "codex", "text": "Checked.", "at": "2026-09-04T09:00:00.000Z" }]
    }
  ]
}
```

Times are UTC with milliseconds, as above.

| Field | Meaning |
|---|---|
| `projects[]` | `id`, a lowercase UUID; `key` and `name`, 1 to 128 characters; `prefix`, 1 to 32 lowercase letters and digits; `createdAt`; and optionally `deploys`, `true` when the project's changes go live by a deploy |
| `tasks[].id` | A task id whose prefix is its project's: the task goes into that project. `project` may name the project's id or prefix as well |
| `tasks[].title`, `.description`, `.acceptance`, `.notes`, `.design`, `.priority` (0 to 4, 2 when left out) | As the API takes them |
| `tasks[].type` | One of Ntasks's task types; `task` when left out. A `gate` with `"awaitsPerson": true` waits on a person's approval |
| `tasks[].parent`, `.links` | The parent's id, and links as `{ "type", "to" }`, with Ntasks's link types; each names a task in the seed |
| `tasks[].labels`, `.metadata`, `.choices`, `.dueAt` | Labels, the metadata object, a decision's choices object, and the due time |
| `tasks[].createdAt`, `.createdBy`, `.createdModel` | When it was filed, by whom, and the model they named |
| `tasks[].changes[]` | Oldest first, each at or after the one before: `at`, `by`, optionally `model`, and what it changes: `status`, `assignee` (or `null`), `priority`, `deferUntil` (or `null`) and `metadata`, which replaces the task's. A change to `closed` takes `close`: `{ "reason", "resolution" }`, `done` when the resolution is left out; its `by` and `model` are the closer's. A change to another status from `closed` reopens the task. An assignee set by the change's own `by` is a claim, and keeps the change's `model` as the assignee's |
| `tasks[].comments[]` | Oldest first: `author`, `text` and `at`, no earlier than the task's creation |

The seed is refused whole, with every reason, when any field is missing, of
the wrong kind or not listed above, when a link, a parent or a prefix names
something the seed does not hold, when a change changes nothing or comes
before the one before it, or when tasks wait on each other in a loop.

## Provision a deployment nobody signs in to

`provision` writes what a new, empty D1 database needs for a deployment that
no person signs in to, such as one a product demo runs inside its own stack:
the statements that create the sign-in schema from
[`workers/api/migrations`](../../workers/api/migrations/), one workspace with
an owner of record, and service credentials of that workspace, with each
credential's token.

```sh
node tools/migrate/src/cli.ts provision --from request.json --out provision.json
```

```json
{
  "format": "ntasks-provision-request-v1",
  "workspace": { "id": "b2222222-0000-4000-8000-000000000002", "name": "Demo" },
  "owner": { "name": "Mara" },
  "credentials": [
    { "name": "seed", "backup": true, "restore": true },
    { "name": "activity", "grants": [{ "projectId": "a1111111-0000-4000-8000-000000000001", "access": "write" }] }
  ]
}
```

A credential takes the choices `POST /api/access/services` takes
([Sign-in](../../docs/sign-in.md#routes)): `grants`, each a project id with
`read` or `write`, and `backup` and `restore`. One with no grants needs
`backup` or `restore`. A grant may name a project the store does not hold
yet, such as one a seed loads afterwards.

The file, `ntasks-provision-v1`, holds `statements`, each `{ "sql", "values" }`,
to run in order as one batch on the empty database through its D1 binding,
and `tokens`, each credential's bearer token by its name. It is readable only
by its owner and never written over: keep it private. The statements also
record each migration in `d1_migrations`, as `wrangler d1 migrations apply`
does, so a later `migrations apply` adds only newer files. The owner of
record has no GitHub account, so nobody signs in as them.

Sign-in must be on for the credentials to sign in: give the Worker
`AUTH_SECRET`, and `NTASKS_ORIGIN`, `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` ([Settings](../../docs/sign-in.md#settings)). With
`PUBLIC_WORKSPACE_ID` naming the workspace, visitors read it with no
credential ([The public workspace](../../docs/sign-in.md#the-public-workspace)).
Then load a seed into its store with `seed` and `load`, through a credential
made with `backup` and `restore`. `workers/api/test/node/provision.ts` runs
these steps against the Worker.

## Tests

```sh
pnpm --filter @ntasks/migrate test
pnpm --filter @ntasks/migrate typecheck
```

The tests use invented hubs only. [`test/fake-hub.ts`](test/fake-hub.ts)
builds a hub commit by commit and records each change as Dolt would;
[`test/scenario.ts`](test/scenario.ts) is a hub with claims, closes, an
approval, a decision, a duplicate, a reopen and a link across projects. The
tests import into store copies in memory and in temporary files, and
[`test/fake-dolt.mjs`](test/fake-dolt.mjs) stands in for the `dolt` client.
The task store's own loading is tested in workerd, in
[`workers/api/test/store-import.test.ts`](../../workers/api/test/store-import.test.ts).
[`test/backup.test.ts`](test/backup.test.ts) backs up a store copy holding
every kind of row through a stand-in for the backup route, and restores it;
the route itself is tested in workerd, in
[`workers/api/test/backup.test.ts`](../../workers/api/test/backup.test.ts).
[`test/load.test.ts`](test/load.test.ts) loads an export and a backup through
a stand-in for the restore routes; the routes themselves are tested in
workerd, in [`workers/api/test/load.test.ts`](../../workers/api/test/load.test.ts),
against a local store only.
