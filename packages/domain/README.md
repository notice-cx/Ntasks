# @ntasks/domain

The Ntasks task model: the formats and rules that the Worker, the web app and
clients must agree on, kept in one place so they cannot drift apart. It has no
runtime dependencies and uses no platform's globals, so the same code runs in
workerd, in the browser and in Node.

| File | Holds |
|---|---|
| [`src/task-id.ts`](src/task-id.ts) | `isTaskId`: whether a value has the form of a task id, such as `web-a1b2` or `web-a1b2.3` |
| [`src/task.ts`](src/task.ts) | The vocabulary (statuses, types, link types, resolutions, history event kinds), the API's limits, and the shapes of a project, task, comment and history event |
| [`src/engine.ts`](src/engine.ts) | `TaskEngine`, the contract every read and write goes through, and the refusals it reports |
| [`src/lint.ts`](src/lint.ts) | `missingSections`: the sections a task's type expects that its text lacks, adapted from Beads |
| [`src/criteria.ts`](src/criteria.ts) | `criteriaOf`: a task's criteria, one for each line or list item of its acceptance, each with whether its box is ticked |
| [`src/store-rows.ts`](src/store-rows.ts) | The task store's tables as rows, and the statements that write and read them, shared by the store and the import from Beads |

[Concepts](../../docs/concepts.md) describes the model these rules belong to,
and [The task store](../../docs/task-store.md) the database behind the engine.

## Commands

```sh
pnpm --filter @ntasks/domain test
pnpm --filter @ntasks/domain typecheck
```

`test` runs the Vitest suite, then [`test/node-import.mjs`](test/node-import.mjs)
with `node --test`. That file imports the package by its name with no bundler,
so it fails if Node itself cannot load the package.
