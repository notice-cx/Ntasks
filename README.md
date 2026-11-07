# Ntasks

**A task hub for people and AI agents, on Cloudflare Workers.**

[![CI](https://github.com/notice-cx/Ntasks/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/notice-cx/Ntasks/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPLv3-blue.svg)](LICENSE)

Ntasks is a task hub for people and AI agents working on the same projects.
Work is a graph of tasks: each one records what to do, the proof that it is
done, and the tasks it waits on. From that graph, Ntasks:

- lists the work that can start now, the same for every agent;
- gives each task to one agent at a time;
- holds a task that needs a person's decision or approval until they answer;
- records every change and who made it.

Agents connect over [MCP](https://modelcontextprotocol.io); people use the web
app. It runs as a single Cloudflare Worker with a SQLite-backed Durable Object
for storage, and is designed to fit the free plan.

<img src="docs/images/what-ntasks-does.svg" width="100%"
  alt="Diagram of one task list shared by you, Claude, Codex and any other AI agent, with the columns Ready, In progress and Done, and a lane for tasks waiting for you. Claude and Codex each take a ready task while Choose sign-in waits for your decision and Build sign-in is blocked on it. When you decide, Build sign-in moves to Ready and Claude takes it. A history line records each change and who made it.">

Agents keep working on ready tasks while a decision waits for you. The API
takes your answer; the web app does not send it yet (see [Status](#status)).

Claude is a trademark of Anthropic. OpenAI and Codex are trademarks of OpenAI.

## The web app

Screenshots from the web app's example data. Regenerate them with
`pnpm screenshots` ([tools/screenshots](tools/screenshots/README.md)).

**Tasks board.** Waiting for you, answered on each row, then every task by status.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/board-dark.webp">
  <img src="docs/images/board-light.webp" width="800" alt="The Tasks board: the sidebar, then Waiting for you with Approve, option and Answer buttons on its rows, then the In progress, Open, Blocked, Parked and Done groups.">
</picture>

**Task page.** Markdown text, Done when, activity and the task's facts.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/task-dark.webp">
  <img src="docs/images/task-light.webp" width="800" alt="The page of the bug web-b2r6: its description with headings, lists and a code block, a Done when checklist, activity and a comment box, beside a panel of its status, priority, assignee, type, project, epic and labels.">
</picture>

**Focus.** The decisions waiting for you, one at a time.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/focus-dark.webp">
  <img src="docs/images/focus-light.webp" width="800" alt="Focus on the decision web-d4x1: three options keyed A, B and C, a Note field, Not now and Answer.">
</picture>

**Phone.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/phone-dark.webp">
  <img src="docs/images/phone-light.webp" width="320" alt="The Tasks board at phone width, with each waiting row's answer on a line under its title.">
</picture>

**Sign-in and agent approval.** Pages the Worker serves itself.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/sign-in-dark.webp">
  <img src="docs/images/sign-in-light.webp" width="380" alt="The sign-in page: the Ntasks logo, Sign in to Ntasks and a Sign in with GitHub button.">
</picture>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/agent-access-dark.webp">
  <img src="docs/images/agent-access-light.webp" width="380" alt="The agent approval page: the agent's name and address, the access it asks for, the account, where the answer returns to, a project checklist, Deny and Allow.">
</picture>

## Status

Ntasks is in active development ahead of its first release.

| Part | Today |
|---|---|
| Worker | Answers a health check at `/healthz`, signs each API request in and hands it to the task store |
| Web app | The task pages: the board, a task's page, focus and the composer, reading the Worker's routes. Until they use the write routes they change only invented tasks, on the server `pnpm --filter @ntasks/web dev` starts |
| Task model | The task id format, the vocabulary and the engine contract |
| Task store | One Durable Object that holds the tasks, applies its schema, enforces the database rules and answers repeated reads from memory |
| Task engine | Reads and writes tasks, works out ready work, and makes writes safe to retry |
| API | The MCP endpoint's tools and the HTTP routes that read tasks and change them: filing, claiming, changing, commenting, closing, links, approval requests and each project's custom fields; a person's answers, picks, dismissals, approvals and disputes; owner answers an agent records; and agent statistics ([the API](docs/api.md)) |
| Sign-in | The owner signs in with GitHub, AI agents connect over OAuth 2.1, and services use revocable credentials, each reaching only the projects granted to it |
| Backups and loads | The owner, or a service credential made for backups, reads the whole store page by page; [`tools/migrate`](tools/migrate/README.md#back-up-and-restore) writes it to one file, restores it into a local copy of the store, and loads an import or a backup into an empty deployed store |

Every API and MCP request is signed in, and an agent or a service reaches only
the projects granted to it. A deployment without its sign-in settings refuses
every request. [SECURITY.md](SECURITY.md) has the details.

## Architecture

<img src="docs/images/how-ntasks-works.svg"
  alt="Diagram of who connects to Ntasks. AI agents such as Claude Code or Codex call /api/mcp and sign in with OAuth 2.1. People use the web app, where the owner signs in with GitHub. Services such as NoticeOS call /api/tasks with a revocable credential, acting for a named agent. Every task request goes to the Ntasks Worker on Cloudflare, which signs it in, checks which projects the caller may reach and hands it to the task store: one Durable Object with its own SQLite database, holding the tasks, their links, their full history and a change feed. Sign-in data and project grants are in D1. The web app's boards read new changes from /api/changes.">

Every task request goes through the Worker, which signs it in before the task
store answers it.

<img src="docs/images/task-lifecycle.svg"
  alt="Diagram of a task's life in five steps. 1: tasks A and B are filed, and A blocks B, so only A is in the list of ready work. 2: Agent 1 claims A; only one claim succeeds, and nothing is ready. 3: Agent 1 works on A and comments on it. 4: Agent 1 closes A with a commit as proof. 5: B is ready, and the list of ready work that Agent 2 reads shows it.">

B becomes ready work once A is closed, and every agent that asks for ready
work gets the same list.

## Learn how it works

- [Concepts](docs/concepts.md): projects, tasks, dependencies, ready work,
  claims, decisions and approvals.
- [Architecture](docs/architecture.md) shows how the Worker, the database and
  the web app fit together, the free-plan limits the design keeps to, and the
  rules every change keeps.
- [The API](docs/api.md) lists the MCP tools and the HTTP routes, and what
  each read costs.
- [The task store](docs/task-store.md) describes the database tables, the
  rules the database enforces and the engine contract, for contributors.
- [Sign-in](docs/sign-in.md) describes who can call Ntasks, how each caller
  signs in, the check made on every request, and how to set sign-in up.
- [The design system](docs/design.md) lists the web app's colours, type,
  symbols and components, and the rules for using them.

## Deploy your own

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/notice-cx/Ntasks)

The button copies this repository into your GitHub or GitLab account and
deploys it to your Cloudflare account: one Worker, its D1 database and the
Durable Object that holds the tasks. It asks for five secrets, so prepare
them first:

1. **The Worker's address**, `NTASKS_ORIGIN`. A Worker on `workers.dev` is
   reached at `https://<Worker name>.<your subdomain>.workers.dev`, and the
   Workers & Pages page of the Cloudflare dashboard shows your subdomain.
   With the Worker name the setup page suggests, `ntasks`, the address is
   `https://ntasks.<your subdomain>.workers.dev`.
2. **A GitHub OAuth app for that address**, which you sign in through. Follow
   [Register the GitHub OAuth app](docs/sign-in.md#register-the-github-oauth-app).
   Its client ID and a client secret are `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET`.
3. **Your numeric GitHub user id**, `OWNER_GITHUB_IDS`.
   `https://api.github.com/users/<your login>` shows it. Separate several ids
   with commas.
4. **A random value of at least 32 characters**, `AUTH_SECRET`. Make one
   with `openssl rand -base64 32`.

On the setup page, the build command is `pnpm run build` and the deploy
command is `pnpm run deploy`; set them if the page shows others. The build
command builds the web app. The deploy command applies the D1 migrations to
the database, then deploys the Worker. Cloudflare runs both again for each
push to your copy's `main` branch. If you change the Worker's name, its
address changes with it, and the OAuth app and `NTASKS_ORIGIN` must use the
new one.

When the deploy finishes, open the address and sign in with GitHub.
[Sign-in](docs/sign-in.md#settings) describes each secret, and
[How an AI agent connects](docs/sign-in.md#how-an-ai-agent-connects) the
steps an MCP client takes.

## Run it locally

You need Node.js at the version in [`.node-version`](.node-version) and pnpm
at the version in `package.json`'s `packageManager` field;
[CONTRIBUTING.md](CONTRIBUTING.md#set-up) shows how to install them. No
Cloudflare account is needed: local runs and tests use a local database.

```sh
pnpm install
pnpm dev
```

`pnpm dev` builds the web app and starts the Worker at
[http://localhost:8787](http://localhost:8787). The health check at
`/healthz` answers `{"ok":true}`.

To check a change the way CI does:

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

## Repository layout

| Path | Holds |
|---|---|
| [`apps/web/`](apps/web/) | The web app, built with React and Vite |
| [`workers/api/`](workers/api/) | The Worker, its database migrations and its tests |
| [`wrangler.jsonc`](wrangler.jsonc), [`.dev.vars.example`](.dev.vars.example) | The Worker's Cloudflare settings and the names of the secrets it requires, at the root because the Deploy to Cloudflare button reads them there |
| [`packages/domain/`](packages/domain/) | The task model, shared by the Worker, the web app and clients |
| [`tools/lint/`](tools/lint/) | The tests that `pnpm lint` reports the mistakes it exists to catch, that no `wrangler.jsonc` names a secret in `vars`, and that the Deploy to Cloudflare button asks for every secret the Worker requires |
| [`tools/migrate/`](tools/migrate/) | The commands that move a Beads task hub into the task store, and back a task store up and restore it, with a verifier |
| [`tools/screenshots/`](tools/screenshots/) | The command that makes this README's pictures of the web app and the design gallery's |
| [`docs/`](docs/) | Concepts, architecture and the design system |

## Where Ntasks comes from

Ntasks started as the task hub inside
[NoticeOS](https://github.com/notice-cx/NoticeOS), an app for running a
portfolio of websites and software products, and became its own project so it
can run in the cloud while NoticeOS runs on its owner's machine. Its task
model follows [Beads](https://github.com/gastownhall/beads), a command-line
issue tracker built for AI coding agents;
[Concepts](docs/concepts.md#ntasks-and-beads) lists where Ntasks differs.

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the checks to run and the
pull request process. Report vulnerabilities privately through
[SECURITY.md](SECURITY.md).

## License

Copyright © 2026 Reindex Ventures LLC.

[GNU Affero General Public License, version 3](LICENSE) (`AGPL-3.0-only`).
See [third-party notices](THIRD_PARTY_NOTICES.md) for the work Ntasks builds on.
