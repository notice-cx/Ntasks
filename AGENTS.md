# AGENTS.md — Ntasks repository context

The facts and conventions an agent needs before changing this repository.
Where this file and the code disagree, the code is the fact and this file is
amended.

## What this repository is

Ntasks is a task hub for people and AI agents, being built as one Cloudflare
Worker and a Durable Object for each workspace that holds its tasks: an HTTP
API, an MCP endpoint and sign-in, with the web app served as the Worker's
static files. Sign-in's data and the workspaces are in D1.
[Architecture](docs/architecture.md) lists what is built today and describes
the system, [Concepts](docs/concepts.md) defines the task model, and
[The task store](docs/task-store.md) the database and the engine contract.
The [README](README.md) introduces the product to people deciding whether to
use it; technical material belongs in `docs/`.

The numbered rules in Architecture's "Rules every change keeps" are
invariants. A change that weakens one is the owner's decision, not a refactor.

## Product principles

Every feature and every change to an existing one meets all five:

- **It fills a real gap.** A feature exists because people or agents hit the
  problem it solves, and the task that adds it cites that evidence.
- **It is easy to understand.** One sentence in the web app or the agent
  guide explains each feature and each visible behavior. Familiar names come
  before new terms, and fewer concepts before more options.
- **It is easy to start with.** A new deployment, a new person and a new
  agent each reach their first task in a few steps, and each step is shown
  where it is needed.
- **It is elegant.** Its design and architecture are as clear and simple as
  the problems it solves require: every part, layer and option exists because
  one of those problems needs it, and there is one way to do each thing. The
  design is also ready to change: a new feature, an extension or a changed
  rule fits into it without redesigning it or working around one of its
  limits.
- **It is fast.** A call is answered from the workspace's task store in one
  hop, a reply carries only what the caller needs, and the free plan's
  limits hold.

## Layout

| Path | Owns |
|---|---|
| `workers/api/` | The Worker and the task store: request handling, the task store object in `src/store/` with its schema in `src/store/migrations/`, D1's migrations in `migrations/`, the HTTP API's versions in `api-versions/`, one file each, and tests that run in workerd in `test/` |
| `wrangler.jsonc`, `.dev.vars.example` | The Worker's Cloudflare settings and the names of the secrets it requires, with their descriptions under `cloudflare.bindings` in the root `package.json`. They sit at the root because the Deploy to Cloudflare button reads them there; wrangler commands run in `workers/api` find them, and `.dev.vars` for local runs goes beside them |
| `apps/web/` | The web app: the page that renders `@notice-cx/ntasks-ui` on the Worker's own origin. Its build in `dist/` is the Worker's static assets |
| `packages/ui/` | The npm package `@notice-cx/ntasks-ui`: the web app's pages as one React component, which `apps/web` and other sites render, its own invented tasks for development and tests, and the check that installs its packed tarball into an empty Vite and React project. Merging its release pull request publishes it once the owner approves ([its README](packages/ui/README.md#releasing)) |
| `packages/domain/` | The task model: formats and rules shared by every part. No runtime dependencies and no platform's globals |
| `packages/github-adapter/` | A Shared Work Protocol server over a GitHub repository's issues, at the protocol's core level: the MCP tools, a ledger for what GitHub cannot hold, and a stand-in for GitHub's API that its tests and CI run the conformance suite over ([its README](packages/github-adapter/README.md)) |
| `release-please-config.json`, `.release-please-manifest.json` | The two npm packages release-please releases, with their tags, and the version each last released. The Release PRs workflow (`.github/workflows/release-please.yml`) keeps one release pull request for both from them |
| `tools/lint/` | The tests that `pnpm lint` reports the mistakes it exists to catch, the test that no `wrangler.jsonc` names a secret in `vars`, the test that the Deploy to Cloudflare button asks for every secret `wrangler.jsonc` requires, and the tests of `install.sh`. The lint configuration itself is `eslint.config.js` at the root |
| `tools/migrate/` | The export from a Beads hub on Dolt, the import into the task store, a backup of a task store and its restore, the load into an empty deployed store, the seed of invented tasks, the provision of a deployment nobody signs in to, and the verifier |
| `tools/cli/` | The npm package `ntasks`, published as `ntasks` from `tools/cli/dist`: the command `npx ntasks deploy`, which deploys the release the package holds to a Cloudflare account and updates it, and the build that bundles the Worker, the web app and the D1 migrations into the package. Its tests run the command against a stand-in for wrangler. Merging its release pull request publishes it once the owner approves ([its README](tools/cli/README.md#releasing)) |
| `tools/screenshots/` | `pnpm screenshots`: the pictures of the web app in the README and the docs, and with `walkthroughs` the animated walkthroughs of its features, drawn from the fixture app by a local Chrome. CI never runs it |
| `install.sh`, `skills/ntasks/` | The command that connects a person's AI agents to Ntasks and installs the Ntasks skill, and the skill itself: the one copy of the standing rules an agent keeps. [Connect an agent](docs/agents.md) describes both. CI runs `shellcheck` on the script, which runs on the bash that macOS ships |
| `docs/` | Why Ntasks, concepts, deploying and running it, the web app, architecture, the API, sign-in, the task store and the design system ([design.md](docs/design.md)). `docs/index.md` lists the pages in the order the website's sidebar shows them |
| `apps/site/` | The website for ntasks.notice.cx: the landing page, and `docs/` rendered in place as the docs at `/docs/`. Its own `wrangler.jsonc` serves the build; no merge or CI run deploys it, so the agent that merges a change to it publishes it ([below](#never-without-the-owners-explicit-approval), [apps/site/README.md](apps/site/README.md#publishing)) |
| `spec/` | The Shared Work Protocol, a draft open contract for shared work that other tools can implement: its text, JSON Schemas, sample objects and the tests that check them. Its text is CC BY 4.0 and its schemas and tests Apache-2.0, apart from Ntasks's AGPL-3.0 code ([spec/README.md](spec/README.md)). A change to a rule Ntasks keeps updates the protocol and its appendix of tests |

A new workspace goes under `apps/`, `workers/`, `packages/` or `tools/`, or
is `spec/`, which stands alone so it can move to a home of its own; it is
named `@ntasks/<name>`, and follows an existing workspace's `package.json` and
`tsconfig.json`. A workspace published to npm takes its published name instead,
under the owner's npm organization: `packages/ui` is `@notice-cx/ntasks-ui`. A workspace with code has a `typecheck` script, and one with
tests a `test` script, so the root commands reach it.

## Commands

Run from the repository root, with the Node.js version in `.node-version` and
the pnpm version in `package.json`'s `packageManager` field:

```sh
pnpm install
pnpm lint          # ESLint: promises that nothing handles, and the other Worker-code rules it can see
pnpm format:check  # Prettier; `pnpm format` rewrites the files it would change
shellcheck install.sh  # the agent setup script
pnpm typecheck     # every workspace, plus the Worker's generated types
pnpm test          # every workspace's tests
pnpm build         # the web app, then `wrangler deploy --dry-run`
pnpm run package   # after the build: the npm package ntasks in tools/cli/dist, checked
pnpm site:build    # the website, then a check of every link and heading in it
pnpm dev           # the Worker and the web app at http://localhost:8787
```

These are the checks CI runs. Run the ones the change reaches before pushing.

## Conventions

- **TypeScript strict, ES modules only.** Every workspace extends
  `tsconfig.base.json`. Add libraries or types in the workspace's tsconfig,
  never by loosening the base. No new `any`.
- **Tests are vitest.** The Worker's tests run in workerd through
  `@cloudflare/vitest-plugin`, on a local task store, which applies its own
  schema, and a local D1 database that `workers/api/test/apply-migrations.ts`
  brings to the current schema. Tests
  that Node must run live in `workers/api/test/node/` and run with
  `node --test`: `routing.ts` there puts the Worker behind Cloudflare's
  static-file layer, and `migrations.ts` applies the task store's migrations
  to a database that already holds rows. A path added to
  `assets.run_worker_first` gets a case in `routing.ts`. A behavior counts as
  covered only when a test exercises it.
- **Generated files are regenerated, never edited:**
  `workers/api/worker-configuration.d.ts` (`pnpm --filter @ntasks/api run
  types`, after any `wrangler.jsonc` change) and `pnpm-lock.yaml`. Git
  ignores `workers/api/src/api-versions.generated.json`, which install, the
  Worker's builds and its tests write.
- **An addition to the HTTP API adds one file to `workers/api/api-versions/`,**
  named `<UTC time>-<what it adds>.json`, and edits no version number: the
  Worker's version is the number of files, so parallel pull requests never
  conflict over it ([Adding a version](docs/api.md#adding-a-version)).
- **Migrations are append-only**
  ([task store](workers/api/src/store/migrations/README.md),
  [D1](workers/api/migrations/README.md)).
- **Dependencies are pinned to exact versions.** `wrangler` and
  `@cloudflare/vitest-plugin` change together: the plugin depends on one exact
  wrangler version.
- **Comments say what the code cannot:** a reason, an invariant, a trap. No
  task ids, decision numbers, dates of past changes, attributions or histories
  of what the code used to do.
- **Documentation is literal and written for developers.** State what a page,
  command or rule shows or does. No metaphors or slogans. Explain an Ntasks
  term (ready work, a claim, a gate) the first time it appears; name widely
  used technology (Cloudflare Workers, Durable Objects, D1, MCP, OAuth,
  SQLite) without explaining it, and link its documentation where a reader
  may need it.
- **Worker code** follows the rules in
  [CONTRIBUTING.md](CONTRIBUTING.md#rules-for-worker-code): no floating
  promises, no request data in module scope, Web Crypto for tokens and secret
  comparisons, no secrets in config or source. `pnpm lint` and `pnpm test`
  check part of each rule, and CONTRIBUTING.md says which part. `pnpm lint`
  accepts `void promise` and `promise.catch(handler)`, which do not keep the
  Worker running after the response. Review checks that work which must
  outlive the response uses `ctx.waitUntil()`, and checks what the tools
  cannot see. A change to `eslint.config.js` keeps `tools/lint`'s tests
  passing.
- **Prettier formats `.ts`, `.tsx`, `.js` and `.mjs` files**
  (`.prettierrc.json`). `.prettierignore` lists only the generated file and
  the agent worktrees; never add a source file to it. Run `pnpm format`
  before committing.
- **This repository is public.** Code, tests, fixtures, docs and commit
  messages name no private installation, account, real task or personal data.
  Fixtures use `example.com` and `.test` hosts and invented task ids.
- **The web app links to its source code.** AGPL-3.0 section 13 requires a
  modified copy that people use over a network to offer them its source, so
  every version of the app keeps that link.

## Never without the owner's explicit approval

Anything that reaches Cloudflare's servers or a deployed Ntasks, reads
included: `wrangler deploy` without `--dry-run`, any `wrangler d1` command
with `--remote`, `wrangler secret put`, `wrangler login`, `pnpm run deploy`
(it runs `wrangler d1 migrations apply --remote`, then `wrangler deploy`),
the `ntasks` command (`npx ntasks deploy`, or `tools/cli/dist/lib/bin.js`),
`--dry-run` included, since it reads the account, and requests to a deployed
Worker. Publishing to npm is the owner's step too: `npm publish`, merging a
release pull request, pushing an `ntasks-v*` or `ui-v*` tag, and starting the Release
or the Release UI package workflow. A release is the owner approving the CI
run of the one release pull request for both packages, titled
`chore: release main`, merging that pull request, then pressing
**Approve and deploy** on each publish run it starts
([tools/cli](tools/cli/README.md#releasing),
[packages/ui](packages/ui/README.md#releasing)). Agents never approve a release
pull request's workflow runs, merge one or turn on auto-merge for one, even
where they may merge other pull requests. Prepare and verify the change
locally first, then ask with the exact command, its target and its effect.
Tests and CI never reach a deployed Worker, a remote database or npm.

Two exceptions need no further approval:

- **Task tools.** The task tools of the `ntasks` MCP server a maintainer
  connected for task work ([Open work](#open-work)) read and change that
  maintainer's tasks. Any other request to that deployment, such as an API
  call by hand, a backup, a load or a credential change, still needs it.
- **Publishing the website.** A merge to `main` that changes `docs/`,
  `spec/` or `apps/site/` is published to ntasks.notice.cx right after it
  lands, by the agent that merged it, without asking: `pnpm site:build`,
  then `wrangler deploy` for the `ntasks-site` Worker, from a clean checkout
  of `main`'s latest commit. After the deploy the agent reads `main`'s
  latest commit again and, if it has moved, publishes again from the new
  one. Two agents publishing at once can finish in either order, and an
  older build deployed last is replaced this way, so the site ends on
  `main`'s latest commit ([apps/site](apps/site/README.md#publishing)). The
  agent records the Cloudflare version it deployed on the task. This covers
  that Worker only; the app's Worker, D1, secrets and npm keep their
  approvals.

## Git

Changes go through a branch and a GitHub pull request; never commit to or push
`main` directly. Keep the repository's main checkout on `main`, and never
switch it to another branch: make each change in its own
[git worktree](https://git-scm.com/docs/git-worktree), then push its branch
and open the pull request from there. Never amend a commit, and never
force-push a branch someone else has. Stage only the intended changes. Commit messages and pull request
titles follow [Conventional Commits](CONTRIBUTING.md#commit-messages-and-pull-request-titles);
maintainer work carries its task id in a `Refs:` footer. Release pull
requests, which release-please opens on `release-please--` branches, are the
owner's to merge ([above](#never-without-the-owners-explicit-approval)).

## Open work

Public contributors use GitHub issues and pull requests, as
[CONTRIBUTING.md](CONTRIBUTING.md) describes, and need nothing below.

The maintainers track this repository's open work in their own Ntasks
deployment, never in TODO comments, docs or notes. Until it has a project for
this repository, its work is filed in the Notice project, whose task ids start
with `ro`. An agent working for a maintainer, connected to that deployment,
follows these rules:

- Tasks come from the `ntasks` MCP server ([Connect an agent](docs/agents.md)). Call `get_task_guide` before task work: it returns the workflow and the rules for filing, claiming and closing a task.
- Never run `bd`, `bv` or `br`, and never use task tools on the `noticeos` MCP server: the `ntasks` tools are the task interface.
- Work only a person can do carries the `human` label; a step that must wait for approval uses `request_human_approval`.
