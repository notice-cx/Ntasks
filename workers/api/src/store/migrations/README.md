# Task store migrations

This folder holds the task store's schema as numbered SQL files.
[The task store](../../../../../docs/task-store.md) describes the tables and
the rules they enforce.

The store applies them itself: when the object starts, `migrate()` in
[`schema.ts`](../schema.ts) applies, in order, every file it has not applied
yet, each in one transaction, and records it in the `store_migrations` table.

## Add a migration

1. Add the next numbered file here, such as `0003_describe_the_change.sql`.
2. Import it in [`schema.ts`](../schema.ts) and add it to the end of
   `MIGRATIONS`.
3. Add the tests that rely on it.

## Rules

- **A merged migration never changes.** A store that already applied the file
  would not see an edit, so a correction is a new migration.
- **The tests start from the full schema.** Every test's store applies every
  file when it starts.
- **A deploy applies new files.** A deployed store applies a new file the
  first time it starts after the deploy, so a migration ships with the code
  that needs it, and a deploy is a maintainer's release step.
