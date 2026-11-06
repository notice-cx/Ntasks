# Ntasks

**A task hub for people and AI agents, on Cloudflare Workers.**

[![CI](https://github.com/notice-cx/Ntasks/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/notice-cx/Ntasks/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPLv3-blue.svg)](LICENSE)

Ntasks is a task hub, being built for people and AI agents who share one
project's work. It keeps that work as a graph of tasks: each task records what
to do, the proof that it is done, and the other tasks it waits on. From that
graph, Ntasks will:

- list the work that can start now, the same way for every agent;
- give each task to one agent at a time;
- hold a task that needs a person's decision or approval until the person
  answers;
- record every change, with who made it.

AI agents will connect from wherever they run, over the
[Model Context Protocol](https://modelcontextprotocol.io) (MCP), the standard
way agents call tools on a server. People will use the web app.

Ntasks runs as a Cloudflare **Worker**, a program Cloudflare runs on its
servers in answer to web requests, and keeps its tasks in a **Durable
Object**, a single Cloudflare object with its own SQLite database. It stays available when your own computer is off, and it is
designed to fit Cloudflare's free plan.

## Status

Ntasks is under construction. The repository holds its skeleton:

| Part | Today |
|---|---|
| Worker | Answers a health check at `/healthz`, signs each API request in and hands it to the task store |
| Web app | The task pages: the board, a task's page, focus and the composer. Until sign-in and writes through the API are built they work only with invented tasks, on the server `pnpm --filter @ntasks/web dev` starts; `pnpm dev` serves them without tasks |
| Task model | The task id format, the vocabulary and the engine contract |
| Task store | One Durable Object that holds the tasks, applies its schema, enforces the database rules and answers repeated reads from memory |
| Task engine | Reads and writes tasks, works out ready work, and makes writes safe to retry |
| API | The MCP endpoint's read tools and the HTTP reads ([the API](docs/api.md)) |
| Sign-in | The owner signs in with GitHub, AI agents connect over OAuth 2.1, and services use revocable credentials, each reaching only the projects granted to it |
| Writes through the API | Being built |

Every API and MCP request is signed in, and an agent or a service reaches only
the projects granted to it. A deployment without its sign-in settings refuses
every request. [SECURITY.md](SECURITY.md) has the details.

## Learn how it works

- [Concepts](docs/concepts.md) introduces projects, tasks, dependencies, ready
  work, claims, decisions and approvals, one idea at a time.
- [Architecture](docs/architecture.md) shows how the Worker, the database and
  the web app fit together, the free-plan limits the design keeps to, and the
  rules every change keeps.
- [The API](docs/api.md) lists the MCP tools and the HTTP routes, and what
  each read costs.
- [The task store](docs/task-store.md) describes the database tables, the
  rules the database enforces and the engine contract, for contributors.
- [Sign-in](docs/sign-in.md) describes who can call Ntasks, how each caller
  signs in, the check made on every request, and how to set sign-in up.

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
| [`packages/domain/`](packages/domain/) | The task model, shared by the Worker, the web app and clients |
| [`tools/lint/`](tools/lint/) | The tests that `pnpm lint` reports the mistakes it exists to catch, and that no `wrangler.jsonc` names a secret in `vars` |
| [`tools/migrate/`](tools/migrate/) | The commands that move a Beads task hub into the task store, with a verifier |
| [`docs/`](docs/) | Concepts and architecture |

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
