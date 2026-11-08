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
runs Workers on Cloudflare, with a local task store and a local D1 database.

## Repository layout

| Path | Holds |
|---|---|
| [`apps/web/`](apps/web/) | The web app, built with React and Vite |
| [`workers/api/`](workers/api/) | The Worker, its database migrations and its tests |
| [`wrangler.jsonc`](wrangler.jsonc), [`.dev.vars.example`](.dev.vars.example) | The Worker's Cloudflare settings and the names of the secrets it requires, at the root because the Deploy to Cloudflare button reads them there |
| [`packages/domain/`](packages/domain/) | The task model, shared by the Worker, the web app and clients |
| [`tools/lint/`](tools/lint/) | The tests that `pnpm lint` reports the mistakes it exists to catch, that no `wrangler.jsonc` names a secret in `vars`, and that the Deploy to Cloudflare button asks for every secret the Worker requires |
| [`tools/migrate/`](tools/migrate/) | The commands that move a Beads task hub into the task store, and back a task store up and restore it, with a verifier |
| [`tools/screenshots/`](tools/screenshots/) | The command that makes the pictures and animated walkthroughs of the web app in the README and the docs |
| [`docs/`](docs/) | Concepts, architecture and the design system |

## Commands

Run these from the repository root.

| Command | What it does |
|---|---|
| `pnpm dev` | Builds the web app and starts the Worker at http://localhost:8787 |
| `pnpm lint` | Runs ESLint on every workspace's TypeScript. It reports a promise that nothing handles (awaits, returns, marks `void` or gives a `.catch()`), and a promise used where the code expects none. In Worker code it also reports the breaks of the other [rules for Worker code](#rules-for-worker-code) that it can see |
| `pnpm format:check` | Checks that every file is formatted the way Prettier formats it. `pnpm format` rewrites the files that are not |
| `pnpm typecheck` | Checks every workspace's TypeScript, and that the Worker's generated types match its `wrangler.jsonc` |
| `pnpm test` | Runs every workspace's tests. They include tests that `pnpm lint` reports what it should, a check that no `vars` setting in a `wrangler.jsonc` is named like a secret, and a check that the Deploy to Cloudflare button asks for every secret the Worker requires |
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
  reach it, and apply the task store's migrations to a database that already
  holds rows. The task model's tests live in
  [`packages/domain/test/`](packages/domain/test/) and run in Node.
- **The databases change through migrations.** Follow the migration rules
  for [the task store](workers/api/src/store/migrations/README.md) and for
  [D1](workers/api/migrations/README.md); from the first deploy on, a merged
  migration never changes.
- **Worker settings regenerate the Worker's types.** After editing
  [`wrangler.jsonc`](wrangler.jsonc) at the repository root, run
  `pnpm --filter @ntasks/api run types` and commit the regenerated
  `worker-configuration.d.ts`. `pnpm typecheck` fails while it is stale.
- **TypeScript is strict.** Every workspace extends
  [`tsconfig.base.json`](tsconfig.base.json). Add a library or types in the
  workspace's own `tsconfig.json`, never by loosening the base. No `any`.
- **ES modules only.**
- **Prettier formats the code**, with the settings in
  [`.prettierrc.json`](.prettierrc.json). Run `pnpm format` before you commit.
  Every `.ts`, `.tsx`, `.js` and `.mjs` file is checked, except the generated
  file and the agent worktrees that [`.prettierignore`](.prettierignore) lists;
  do not add a file to it.
- **Comments say what the code cannot:** a reason, a rule, a trap, or the one
  place a fact lives. They do not narrate the code or record its history;
  that belongs in commit messages.
- **Documentation states what a thing does, in plain words, for developers.**
  Name the page, the command or the rule. Explain an Ntasks term the first
  time it appears; name widely used technology (Cloudflare Workers, Durable
  Objects, D1, MCP, OAuth, SQLite) without explaining it.

### Rules for Worker code

A tool checks part of each rule, and CI runs the tools. Review checks the rest.
Each rule below says which part a tool checks.

- Every promise is awaited, returned, or passed to `ctx.waitUntil()`. A
  promise left floating can be cut off when the response is sent, and its
  error is lost. `pnpm lint` reports a promise that is none of those
  (`@typescript-eslint/no-floating-promises`), and a promise passed where the
  code expects none, such as an `if` condition or the callback of `forEach`
  (`@typescript-eslint/no-misused-promises`). It reads the types, so it
  reports a database call such as `db.prepare(sql).run()` that nothing awaits. It
  also accepts `void promise` and `promise.catch(handler)`, which do not keep
  the Worker from cutting the promise off; use `ctx.waitUntil()` for work that
  must outlive the response.
- Never keep one request's data in a module-level variable. One Worker
  instance serves many requests, so the value would leak into the next one.
  In `workers/*/src` and `packages/*/src`, `pnpm lint` reports a module-level
  `let` or `var`, and a module-level `const` that starts as an empty `Map`,
  `Set`, `WeakMap`, `WeakSet`, object or array (`no-restricted-syntax`). A
  constant that nothing fills at run time, such as
  `new Set(['GET', 'HEAD'])`, passes. Review checks a `const` object or
  collection that code writes request data into later.
- Make tokens and ids with `crypto.randomUUID()` or
  `crypto.getRandomValues()`, never `Math.random()`. `pnpm lint` reports
  `Math.random` in `workers/` and `packages/`, tests included
  (`no-restricted-properties`).
- Compare secrets with `crypto.subtle.timingSafeEqual()`, never `===`. In
  `workers/*/src` and `packages/*/src`, `pnpm lint` reports `===`, `!==`, `==`
  or `!=` when an operand is a variable or property whose name ends in
  `secret`, `token`, `password`, `passcode`, `signature`, `hmac` or `apiKey`
  (`no-restricted-syntax`). The property can be written `session.token` or
  `session['token']`, and `!`, `as` or `?.` can wrap the operand, as in
  `token! === expected` or `(session?.token as string) === expected`. A key
  held in a variable, as in `record[token]`, names nothing and passes, and so
  does a comparison with `null`, `undefined` or `''`. Review checks a secret
  held under another name, and one compared inside a helper.
- Never write a secret into `wrangler.jsonc`, the source or a test. Local
  values go in `.dev.vars` at the repository root, which git ignores, and
  `.dev.vars.example` holds only the names. `pnpm test` fails when a
  variable under `vars` in a `wrangler.jsonc` has a name that contains
  `secret`, `token`, `password`, `passcode`, `credential`, `api_key`,
  `private_key` or `signing_key`; a secret is set with `wrangler secret put`.
  Review checks the source and the tests.

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
