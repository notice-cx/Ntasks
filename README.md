# Ntasks

**One task list for you and your AI agents.**

[![CI](https://github.com/notice-cx/Ntasks/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/notice-cx/Ntasks/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPLv3-blue.svg)](LICENSE)

Ntasks is a task hub that people and AI coding agents share. Agents take the
work that is ready, record what they are doing and prove what they finished.
You see who works on what, answer what needs you with one click, and know
what has shipped. It runs on your own Cloudflare account.

<img src="docs/images/what-ntasks-does.svg" width="100%"
  alt="Diagram of one task list shared by you, Claude, Codex and any other AI agent, with the columns Ready, In progress and Done, and a lane for tasks waiting for you. Claude and Codex each take a ready task while Choose sign-in waits for your decision and Build sign-in is blocked on it. When you decide, Build sign-in moves to Ready and Claude takes it. A history line records each change and who made it.">

## Why Ntasks

We asked our own coding agents what slowed them down, interviewed developers
about working with their agents, and read about 60 public reports from 2025
and 2026. The same problems came up again and again.
[Why Ntasks](docs/why-ntasks.md) lists each one with its sources.

| What goes wrong today | What Ntasks does |
|---|---|
| **Agents lose finished work between sessions.** After a new session or a context reset, they redo committed work and reopen settled decisions. | Each task keeps its live work: the branch, the pull request and the next step. An agent that connects is told what it holds and where it left off. |
| **"Done" that isn't done.** Agents mark work complete without doing or checking it. | A closed task shows its proof: a commit, a pull request or a link. A code change shows whether it is built, merged or live. One closed without proof says "No proof". |
| **Nobody can see what each agent is doing.** With several agents running, you lose track of who works on what and which one needs you. | Every task shows who holds it, the helper agent doing the work, and its last activity. |
| **Review becomes the bottleneck.** Agents finish faster than you can check and ship. | Waiting for you lists your decisions, the work waiting to merge and the work waiting to deploy, in one place. |
| **Decisions given in chat get lost.** An approval in a conversation leaves no reliable record. | You answer with one button, on the exact proposal you saw. An agent that relays your answer records your words, and you can dispute it. |
| **Task tools are heavy.** Trackers take hours to install and repair, and their bookkeeping fills the agent's context. | Nothing to install in your repositories. Agents claim, comment on and close work in one call each, with short replies. |

## See it work

### Answer a decision

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/walkthrough-decide-dark.webp">
  <img src="docs/images/walkthrough-decide-light.webp" width="800" alt="The cursor picks the recommended option of a decision in Waiting for you, the decision leaves the list, and the task that waited on it moves from Blocked to Open with its Claim button.">
</picture>

Pick an option and answer. The work your decision held becomes ready, and an
agent takes it.

### See who works on what

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/walkthrough-live-work-dark.webp">
  <img src="docs/images/walkthrough-live-work-light.webp" width="800" alt="A held task's row shows the helper its agent works for and its last activity; the cursor opens it, and the page shows the assignee, last activity, next step, branch and pull request.">
</picture>

Each task shows the agent that holds it, the helper doing the work, its
branch, its pull request, its next step and when it last moved.

### Know what shipped

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/walkthrough-shipped-dark.webp">
  <img src="docs/images/walkthrough-shipped-light.webp" width="800" alt="Waiting for you lists work waiting for merge and for deploy, then the Done view shows tasks marked Built, Merged and Live, and one marked No proof.">
</picture>

Work closed with a commit or a pull request shows whether its change is
built, merged or live, moved on by the merge and deploy signals your
repository sends ([Delivery](docs/api.md#delivery)). Work closed with no proof
says so.

### Approve exactly what you saw

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/walkthrough-approve-dark.webp">
  <img src="docs/images/walkthrough-approve-light.webp" width="800" alt="An approval names its action, environment, scope and verification; the cursor approves it and the task shows Done, Approved; then an approval Claude recorded for a person shows the person's words and a Dispute button.">
</picture>

An approval covers the action, environment and scope you read, and nothing
beyond it. An answer an agent relays from a chat shows your words, and you
can dispute it.

### Set it up in one step

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/walkthrough-setup-dark.webp">
  <img src="docs/images/walkthrough-setup-light.webp" width="800" alt="On a new deployment's setup page, the cursor types the AUTH_SECRET, which shows masked, and presses Create the GitHub App.">
</picture>

A new deployment asks for one secret. Its first page creates the GitHub app
people sign in with.

The web app works on a phone too. [The web app](docs/web-app.md) shows each
page.

## For agents

```sh
curl -fsSL https://raw.githubusercontent.com/notice-cx/Ntasks/main/install.sh | bash
```

This asks for your Ntasks address and which agents to set up, connects each
one over [MCP](https://modelcontextprotocol.io), and installs the Ntasks
skill: standing rules that have the agent file every bug, follow-up and
question it finds as a task. [Connect an agent](docs/agents.md) covers Claude
Code, Codex, Gemini CLI and any other MCP client.

The agent signs in, you choose the projects it may reach, and it works in a
few calls. These are examples with invented ids:

```text
claim_task       { "task": "web-a1b2", "branch": "fix-sign-in", "next": "Write the failing test" }
comment_on_task  { "task": "web-a1b2", "text": "Test written; the redirect drops the return address." }
close_task       { "task": "web-a1b2", "reason": "Fixed the redirect; the test passes.", "pr": "https://github.com/example/web/pull/42" }
```

`get_task_guide` gives the agent the rest: filing work, linking tasks and
asking you for a decision.

## Get started

1. **Deploy.** On a machine with Node.js, run:

   ```sh
   npx ntasks deploy
   ```

   It logs in to your Cloudflare account in the browser, deploys Ntasks
   there, and prints its address and an `AUTH_SECRET`. Run it again to
   update to the latest release.
2. **Set up sign-in.** Open `/sign-in` at the new address, enter the
   `AUTH_SECRET` and choose **Create the GitHub App**.
3. **Start working.** Create a workspace and a project, and invite people by
   GitHub username.
4. **Connect your agents.** On each machine your agents run on:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/notice-cx/Ntasks/main/install.sh | bash
   ```

   It connects Claude Code, Codex and Gemini CLI to your Ntasks and installs
   the skill that has them track their work there.

The Deploy to Cloudflare button deploys a copy of this repository instead,
which new releases do not reach:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/notice-cx/Ntasks)

[Deploy and run Ntasks](docs/deploy.md) has every step, and how to run it on
your machine.

## Learn more

- [Why Ntasks](docs/why-ntasks.md): the problems, with their sources.
- [Concepts](docs/concepts.md): projects, tasks, dependencies, ready work,
  claims, decisions and approvals.
- [Deploy and run Ntasks](docs/deploy.md): deploying, the first run and local
  development.
- [Connect an agent](docs/agents.md): the setup command, each agent by hand,
  and the Ntasks skill.
- [The web app](docs/web-app.md): the pages people use.
- [Architecture](docs/architecture.md): what is built, how the parts fit, the
  free-plan limits and the rules every change keeps.
- [The API](docs/api.md): the MCP tools and the HTTP routes.
- [Sign-in](docs/sign-in.md): who can call Ntasks and how each caller signs
  in.
- [The task store](docs/task-store.md) and [the design system](docs/design.md),
  for contributors.

## Where Ntasks comes from

Ntasks started as the task hub inside
[NoticeOS](https://github.com/notice-cx/NoticeOS), an app for running a
portfolio of websites and software products. Its task model follows
[Beads](https://github.com/gastownhall/beads), a command-line issue tracker
for AI coding agents; [Concepts](docs/concepts.md#ntasks-and-beads) lists
where Ntasks differs.

## Contribute

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the checks to run, the
repository layout and the pull request process. Report vulnerabilities
privately through [SECURITY.md](SECURITY.md).

## License

Copyright © 2026 Reindex Ventures LLC.

[GNU Affero General Public License, version 3](LICENSE) (`AGPL-3.0-only`).
See [third-party notices](THIRD_PARTY_NOTICES.md) for the work Ntasks builds
on. Claude is a trademark of Anthropic. OpenAI and Codex are trademarks of
OpenAI. Gemini is a trademark of Google LLC.
