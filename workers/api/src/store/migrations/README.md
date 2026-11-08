# Task store migrations

This folder holds the task store's schema as numbered SQL files.
[The task store](../../../../../docs/task-store.md) describes the tables and
the rules they enforce. `0001_task_store.sql` is the whole schema a new
store starts from; each later file changes it.

The store applies them itself: when the object starts, `migrate()` in
[`schema.ts`](../schema.ts) applies, in order, every file it has not applied
yet, each in one transaction, and records it in the `store_migrations` table.

## Add a migration

1. Add the next numbered file here, such as `0002_describe_the_change.sql`.
2. Import it in [`schema.ts`](../schema.ts) and add it to the end of
   `MIGRATIONS`.
3. Add the tests that rely on it. A migration that rebuilds a table or
   changes rows a store already holds also gets a case in
   [`test/node/migrations.ts`](../../../test/node/migrations.ts), which
   applies the migrations to a database with rows in it; the Worker's other
   tests start from an empty store.

## Rules

- **From the first deploy on, a merged migration never changes.** A store
  that already applied the file would not see an edit, so a correction is a
  new migration.
- **The tests start from the full schema.** Every test's store applies every
  file when it starts.
- **A deploy applies new files.** A deployed store applies a new file the
  first time it starts after the deploy, so a migration ships with the code
  that needs it, and a deploy is a maintainer's release step.
