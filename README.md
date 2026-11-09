# Ntasks

**One task list for you and your AI agents.**

[![CI](https://github.com/notice-cx/Ntasks/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/notice-cx/Ntasks/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPLv3-blue.svg)](LICENSE)

Ntasks is a task list that people and AI coding agents share. Agents connect
over MCP to pick up tasks that nothing blocks, record their progress and close
each task with proof. People use the web app to see who works on what and to
answer what needs them. It runs on your own Cloudflare account, within
[the free plan](docs/architecture.md#the-free-plan-budget).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/board-dark.webp">
  <img src="docs/images/board-light.webp" width="800" alt="The Tasks board: the sidebar, then Waiting for you with Approve, option and Answer buttons on its rows, then the In progress, Open, Blocked, Parked and Done groups.">
</picture>

## What it solves

- **Agents lose track of work between sessions.** Each task keeps its branch,
  pull request and next step, and an agent that connects is told which tasks
  it holds.
- **"Done" that isn't done.** A closed task shows its proof (a commit, a pull
  request or a link) and whether the change is built, merged or live.
- **Nobody can see what each agent is doing.** Every task shows who holds it,
  the helper agent doing the work and its last activity.
- **Decisions and reviews get lost.** Waiting for you lists the decisions and
  approvals that need you and the work waiting to merge or deploy. You answer
  a decision with one button, on the exact proposal you saw.
- **Task tools cost setup time and agent context.** Nothing to install in your
  repositories. Agents claim, comment on and close work in one call each, with
  short replies.

[Why Ntasks](docs/why-ntasks.md) lists the public reports behind each one.

## Get started

1. **Deploy** to your Cloudflare account:

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/notice-cx/Ntasks)

   The button asks for one secret, `AUTH_SECRET`. Make one with
   `openssl rand -base64 32` and keep a copy.

2. **Set up sign-in.** Open `/sign-in` at your new address, enter the secret
   and choose **Create the GitHub App**.

3. **Create a workspace and a project**, and invite people by GitHub
   username.

[Deploy and run Ntasks](docs/deploy.md) covers deploying from a checkout,
updating a deployment and running Ntasks on your machine.

## Connect an agent

On each machine your agents run on:

```sh
curl -fsSL https://raw.githubusercontent.com/notice-cx/Ntasks/main/install.sh | bash
```

It asks for your Ntasks address and which agents to set up, connects Claude
Code, Codex CLI or Gemini CLI over MCP, and installs the Ntasks skill, which
has the agent track its work in Ntasks. Any other MCP client connects to
`https://<your address>/api/mcp`; [Connect an agent](docs/agents.md) has the
steps for each.

## Learn more

- [Why Ntasks](docs/why-ntasks.md): the problems, with their sources.
- [Concepts](docs/concepts.md): projects, tasks, dependencies, ready work,
  claims, decisions and approvals, and how Ntasks differs from
  [Beads](docs/concepts.md#ntasks-and-beads).
- [The web app](docs/web-app.md): each page, and animated walkthroughs of its
  features.
- [Deploy and run Ntasks](docs/deploy.md): deploying, the first run and local
  development.
- [Connect an agent](docs/agents.md): the setup command, each agent by hand,
  and the Ntasks skill.
- [Architecture](docs/architecture.md), [the API](docs/api.md),
  [sign-in](docs/sign-in.md), [the task store](docs/task-store.md) and
  [the design system](docs/design.md), for contributors.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the checks to run and the
pull request process. Report vulnerabilities privately through
[SECURITY.md](SECURITY.md).

## License

Copyright © 2026 Reindex Ventures LLC.

[GNU Affero General Public License, version 3](LICENSE) (`AGPL-3.0-only`).
See [third-party notices](THIRD_PARTY_NOTICES.md) for the work Ntasks builds
on. Claude is a trademark of Anthropic. OpenAI and Codex are trademarks of
OpenAI. Gemini is a trademark of Google LLC.
