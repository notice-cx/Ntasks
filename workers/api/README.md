# @ntasks/api

The Ntasks Worker. It answers the paths that
[`wrangler.jsonc`](wrangler.jsonc) lists in `assets.run_worker_first`, and
Cloudflare serves the web app's build for every other path.

| Path | Holds |
|---|---|
| [`src/index.ts`](src/index.ts) | The request handler |
| [`migrations/`](migrations/) | The D1 schema, as numbered SQL files ([rules](migrations/README.md)) |
| [`test/`](test/) | Tests, which run in workerd on a local D1 database |
| `worker-configuration.d.ts` | The Worker's `Env` and runtime types, generated from `wrangler.jsonc` |

## Routes

| Route | Answer |
|---|---|
| `GET /healthz` | `200` with `{"ok":true}`. It shows the Worker is running and reads no binding |
| Any other path under `/api/` | `404` with `{"error":"not_found"}` |

## Commands

Run these from the repository root:

```sh
pnpm --filter @ntasks/api test       # the tests, in workerd
pnpm --filter @ntasks/api run types  # regenerate worker-configuration.d.ts after editing wrangler.jsonc
pnpm --filter @ntasks/api run dev    # the Worker at http://localhost:8787, serving the last web build
pnpm --filter @ntasks/api build      # wrangler deploy --dry-run; needs the web build, which `pnpm build` makes first
```
