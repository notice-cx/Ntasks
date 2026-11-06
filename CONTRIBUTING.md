# Contributing to Ntasks

Start with [Concepts](docs/concepts.md) and [Architecture](docs/architecture.md).
They introduce the task model and the rules the code keeps, and most review
comments come back to one of them.

## Set up

- **Node.js**, at the version in [`.node-version`](.node-version), which CI
  uses too. Version managers such as mise, fnm and nodenv read that file.
- **pnpm**, at the version in `package.json`'s `packageManager` field. On
  Node.js 24, `corepack enable` installs it. Later Node.js versions no longer
  include Corepack; use [pnpm's installer](https://pnpm.io/installation)
  there.

```sh
pnpm install
```

No Cloudflare account is needed. Tests and `pnpm dev` run the Worker in
[workerd](https://github.com/cloudflare/workerd), the open-source runtime that
runs Workers on Cloudflare, with a local D1 database.

## Commands

Run these from the repository root.

| Command | What it does |
|---|---|
| `pnpm dev` | Builds the web app and starts the Worker at http://localhost:8787 |
| `pnpm lint` | Runs ESLint on every workspace's TypeScript. It reports a promise that nothing handles (awaits, returns, marks `void` or gives a `.catch()`), and a promise used where the code expects none |
| `pnpm format:check` | Checks that every file is formatted the way Prettier formats it. `pnpm format` rewrites the files that are not |
| `pnpm typecheck` | Checks every workspace's TypeScript, and that the Worker's generated types match its `wrangler.jsonc` |
| `pnpm test` | Runs every workspace's tests |
| `pnpm build` | Builds the web app, then checks that the Worker would deploy, without deploying it |

CI runs `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` and
`pnpm build` on every pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). To run one
workspace's command, name it with `--filter`:

```sh
pnpm --filter @ntasks/domain test
```

## Make a change

- **Behavior changes come with tests.** A new test fails without the change and
  passes with it. The Worker's tests live in
  [`workers/api/test/`](workers/api/test/) and run inside workerd, except those
  in [`workers/api/test/node/`](workers/api/test/node/), which Node runs: they
  start the Worker behind Cloudflare's static-file layer to check which paths
  reach it. The task model's tests live in
  [`packages/domain/test/`](packages/domain/test/) and run in Node.
- **The database changes through migrations.** Follow
  [the migration rules](workers/api/migrations/README.md); a merged migration
  never changes.
- **Worker settings regenerate the Worker's types.** After editing
  [`workers/api/wrangler.jsonc`](workers/api/wrangler.jsonc), run
  `pnpm --filter @ntasks/api run types` and commit the regenerated
  `worker-configuration.d.ts`. `pnpm typecheck` fails while it is stale.
- **TypeScript is strict.** Every workspace extends
  [`tsconfig.base.json`](tsconfig.base.json). Add a library or types in the
  workspace's own `tsconfig.json`, never by loosening the base. No `any`.
- **ES modules only.**
- **Prettier formats the code**, with the settings in
  [`.prettierrc.json`](.prettierrc.json). Run `pnpm format` before you commit.
  [`.prettierignore`](.prettierignore) lists the files that were written
  before the formatter and are not yet formatted; do not add a file to it.
- **Comments say what the code cannot:** a reason, a rule, a trap, or the one
  place a fact lives. They do not narrate the code or record its history;
  that belongs in commit messages.
- **Documentation states what a thing does, in plain words.** Name the page,
  the command or the rule, and explain a term the first time it appears.

### Rules for Worker code

`pnpm lint` catches most breaks of the first rule. Review checks that rule's
remaining cases and the other four.

- Every promise is awaited, returned, or passed to `ctx.waitUntil()`. A
  promise left floating can be cut off when the response is sent, and its
  error is lost. `pnpm lint` reports a promise that is none of those
  (`@typescript-eslint/no-floating-promises`), and a promise passed where the
  code expects none, such as an `if` condition or the callback of `forEach`
  (`@typescript-eslint/no-misused-promises`). It reads the types, so it
  reports a D1 call such as `db.prepare(sql).run()` that nothing awaits. It
  also accepts `void promise` and `promise.catch(handler)`, which do not keep
  the Worker from cutting the promise off; use `ctx.waitUntil()` for work that
  must outlive the response.
- Never keep one request's data in a module-level variable. One Worker
  instance serves many requests, so the value would leak into the next one.
- Make tokens and ids with `crypto.randomUUID()` or
  `crypto.getRandomValues()`, never `Math.random()`.
- Compare secrets with `crypto.subtle.timingSafeEqual()`, never `===`.
- Never write a secret into `wrangler.jsonc`, the source or a test. Local
  values go in `.dev.vars`, which git ignores.

## Commit messages and pull request titles

Use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
for commit messages and pull request titles:

```text
type(scope): describe the change
```

- Choose `feat` for a new capability, `fix` for a bug, `perf` for
  performance, `refactor` for restructuring without changing behavior, `docs`
  for documentation, `test` for tests, `build` for dependencies or build
  tooling, `ci` for automation, or `chore` for other maintenance.
- Use a scope when it helps locate the change: `api`, `web`, `domain`,
  `migrations` or `docs`. Omit it for a change across the project.
- Keep the subject at most 72 characters, including the prefix. Start the
  description with a lowercase imperative verb, such as "add", "fix" or
  "keep", with no trailing period.
- Keep one coherent change per commit. Add a body when the reason or a
  tradeoff needs explaining.
- Put issue references in the footer (`Fixes: #12`).
- Mark a breaking change with `!` before the colon and a `BREAKING CHANGE:`
  footer that explains the impact.

```text
feat(api): list the ready tasks of a project
fix(domain): refuse a task id with an empty child number
docs: explain how a claim is released
```

Give the pull request the same title format, so it can serve as the commit
title when squash merging. Never amend or rewrite commits that others have
already pulled.

## Submit a pull request

Describe the behavior before and after, the paths you changed and the checks
you ran. Keep credentials, real task data and local settings out of the patch
and its test output.

Contributions are licensed under the project's licence,
[AGPL-3.0-only](LICENSE). Report vulnerabilities privately through the
[security policy](SECURITY.md), not in an issue.
