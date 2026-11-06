# @ntasks/domain

The Ntasks task model: the formats and rules that the Worker, the web app and
clients must agree on, kept in one place so they cannot drift apart. It has no
runtime dependencies and uses no platform's globals, so the same code runs in
workerd, in the browser and in Node.

| Export | What it does |
|---|---|
| `isTaskId(value)` | Whether a value has the form of a task id, such as `web-a1b2` or `web-a1b2.3` |

[Concepts](../../docs/concepts.md) describes the model these rules belong to.

## Commands

```sh
pnpm --filter @ntasks/domain test
pnpm --filter @ntasks/domain typecheck
```
