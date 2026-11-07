# D1 migrations

This folder holds the Worker's D1 schema as numbered SQL files. D1 keeps the
data that is not tasks: sign-in's tables, and the workspaces with their
members, invitations, agent grants and service credentials. Tasks live in
each workspace's task store, a Durable Object with its own schema in
[`src/store/migrations`](../src/store/migrations).

Wrangler applies these files in number order and records each applied file in
the database's `d1_migrations` table, so a database only ever receives the
files it lacks.

## Add a migration

From the repository root:

```sh
pnpm --filter @ntasks/api exec wrangler d1 migrations create DB describe_the_change
```

Commands name the database by its binding, `DB`, because a deployment made
with the Deploy to Cloudflare button may give the database another name.

Wrangler writes the next numbered file here. Put the schema change in it and
add the tests that rely on it.

## Rules

- **A merged migration never changes.** A database that already applied the
  file would not see an edit, so a correction is a new migration.
- **The tests start from the full schema.** Before each test file,
  [`test/apply-migrations.ts`](../test/apply-migrations.ts) applies every
  migration here to a fresh local database.
- **`wrangler dev` keeps its own local database.** Apply new migrations to it
  with:

  ```sh
  pnpm --filter @ntasks/api exec wrangler d1 migrations apply DB --local
  ```

- **A deployed database changes only when its deployment runs
  `pnpm run deploy`.** That applies the migrations the database lacks before
  it deploys the Worker, so the new code finds its tables. The Deploy to
  Cloudflare button's builds run it. Tests and CI never apply migrations to a
  deployed database.
