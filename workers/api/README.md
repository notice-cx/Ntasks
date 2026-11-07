# @ntasks/api

The Ntasks Worker. It answers the paths that
[`wrangler.jsonc`](../../wrangler.jsonc), at the repository root, lists in
`assets.run_worker_first`, and Cloudflare serves the web app's build for
every other path. Wrangler commands run in this folder read that file.

| Path | Holds |
|---|---|
| [`src/index.ts`](src/index.ts) | The request handler |
| [`src/access/`](src/access/) | Sign-in: the owner, AI agents over OAuth, service credentials, and the token verifier ([Sign-in](../../docs/sign-in.md)) |
| [`src/engine/`](src/engine/) | The task engine: the `TaskEngine` contract on D1 ([The task store](../../docs/task-store.md)) |
| [`migrations/`](migrations/) | The D1 schema, as numbered SQL files ([rules](migrations/README.md)) |
| [`test/`](test/) | Tests that run in workerd on a local D1 database |
| [`test/node/`](test/node/) | The tests Node runs: the routing test, which puts the Worker behind Cloudflare's static-file layer, with the real `wrangler.jsonc` and a fixture web build, and the migration test, which applies the task store's migrations to a database that already holds rows |
| `worker-configuration.d.ts` | The Worker's `Env` and runtime types, generated from `wrangler.jsonc` |

## Routes

| Route | Answer |
|---|---|
| `GET /healthz` | `200` with `{"ok":true}`. It shows the Worker is running and reads no binding |
| `/sign-in`, `/agent-access`, `/api/auth/`, `/api/access/` and the OAuth discovery documents under `/.well-known/` | Sign-in; [Sign-in](../../docs/sign-in.md#routes) lists each route |
| Any other path under `/api/` | `404` with `{"error":"not_found"}` |

## Commands

Run these from the repository root:

```sh
pnpm --filter @ntasks/api test       # the tests in workerd, then the routing test in Node
pnpm --filter @ntasks/api run types  # regenerate worker-configuration.d.ts after editing wrangler.jsonc
pnpm --filter @ntasks/api run dev    # the Worker at http://localhost:8787, serving the last web build
pnpm --filter @ntasks/api build      # wrangler deploy --dry-run; needs the web build, which `pnpm build` makes first
```

`pnpm run deploy`, from the repository root, runs this workspace's `deploy`
script: it applies the D1 migrations the deployed database lacks, then
deploys the Worker with the last web build, to the Cloudflare account
wrangler is signed in to. The Deploy to Cloudflare button's builds run it
([README](../../README.md#deploy-your-own)).
