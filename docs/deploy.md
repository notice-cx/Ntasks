# Deploy and run Ntasks

How to deploy Ntasks to your own Cloudflare account, set it up the first
time, and run it on your machine.

## Deploy your own

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/notice-cx/Ntasks)

The button copies this repository into your GitHub or GitLab account and
deploys it to your Cloudflare account: one Worker, its D1 database and the
Durable Object that holds the tasks. It asks for one secret, `AUTH_SECRET`:
a random value of at least 32 characters. Make one with
`openssl rand -base64 32`, and keep a copy for the setup page below.

On Cloudflare's deploy page, the build command is `pnpm run build` and the
deploy command is `pnpm run deploy`; set them if the page shows others. The
build command builds the web app. The deploy command applies the D1
migrations to the database, then deploys the Worker. Cloudflare runs both
again for each push to your copy's `main` branch.

When the deploy finishes, set up sign-in with GitHub on the deployment's
setup page:

1. Open `/sign-in` at the Worker's address, such as
   `https://ntasks.<your subdomain>.workers.dev/sign-in`. The Workers & Pages
   page of the Cloudflare dashboard shows the address. Sign-in is bound to
   the address the setup runs at, so use the one people will use.
2. Enter `AUTH_SECRET` and choose **Create the GitHub App**.
3. GitHub shows the app it will create under your GitHub account. Create it.
4. GitHub returns to Ntasks and asks you to authorize the app. You are
   signed in as the deployment's admin.

[The setup page](sign-in.md#the-setup-page) describes what each step
checks, and [Settings](sign-in.md#settings) the optional secrets that
replace it with a GitHub OAuth app you register yourself.
[How an AI agent connects](sign-in.md#how-an-ai-agent-connects)
describes the steps an MCP client takes.

## First run

A new deployment, or `pnpm dev`, needs `AUTH_SECRET` first
([Sign-in](sign-in.md#settings)). Then:

1. **Set up sign-in.** Open `/sign-in` at the deployment's address and run
   the [setup page](sign-in.md#the-setup-page). The GitHub account
   that creates the app is the deployment's admin.
2. **Create a workspace.** An admin who belongs to no workspace sees one
   step, New workspace, and owns the workspace it creates. A workspace keeps
   its own projects, tasks and members apart from every other.
3. **Create a project.** The Projects page opens with New project: a name and
   a prefix, the letters and digits that start every task id in the project
   (`web` gives `web-a1b2`). On the Members page, an owner invites people by
   GitHub username; each joins when they first sign in.
4. **Connect an agent.** Add the MCP endpoint, `<address>/api/mcp`, to an MCP
   client, such as Claude Code with
   `claude mcp add --transport http ntasks https://ntasks.example.com/api/mcp`.
   The client signs in with OAuth, and you allow it and choose its projects
   on the approval page
   ([How an AI agent connects](sign-in.md#how-an-ai-agent-connects)).

A person in two or more workspaces switches between them from the workspace
name at the top of the sidebar.

## Run it locally

You need Node.js at the version in [`.node-version`](../.node-version) and pnpm
at the version in `package.json`'s `packageManager` field;
[CONTRIBUTING.md](../CONTRIBUTING.md#set-up) shows how to install them. No
Cloudflare account is needed: local runs and tests use a local database.

```sh
pnpm install
pnpm --filter @ntasks/api exec wrangler d1 migrations apply DB --local
pnpm dev
```

The second command creates the local D1 database's tables. Run it again after
pulling a change that adds a D1 migration.

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
