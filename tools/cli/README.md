# ntasks

`npx ntasks deploy` deploys [Ntasks](https://github.com/notice-cx/Ntasks), the
task list you share with your AI agents, to your own Cloudflare account. Run
it again to update that deployment to the latest release.

```sh
npx ntasks deploy
```

It needs Node.js and a Cloudflare account. No copy of the Ntasks repository
is involved: this package holds the built Worker, the web app and the D1
migrations, and deploys them with [wrangler](https://developers.cloudflare.com/workers/wrangler/).

## What it does

The first run:

1. Opens Cloudflare's login in your browser (`wrangler login`). It skips this
   when wrangler is logged in already or `CLOUDFLARE_API_TOKEN` is set.
2. Creates a D1 database named `ntasks`, or uses the one of that name the
   account already has, as after a first run that stopped. `--dry-run`
   names the database first; when it is not Ntasks's, choose another name
   with `--name`.
3. Applies the D1 migrations the database lacks.
4. Makes an `AUTH_SECRET` and deploys a Worker named `ntasks` with it.
5. Prints the Worker's address and the setup steps: open `/sign-in`, enter
   the `AUTH_SECRET` it printed and choose **Create the GitHub App**. Keep a
   copy of `AUTH_SECRET`; the command shows it only on this run.

A later run finds the Worker in the account by name and keeps the D1 database
the Worker is bound to, applies the D1 migrations that database lacks,
deploys the new release and prints the
release before and after. The Worker's secrets stay as they are. Each
workspace's task store applies its own migrations when it next starts.

The command keeps nothing on your machine between runs. Each deploy tags the
Worker's version with its release, such as `v0.1.0`, which is how a later run
knows the release deployed; the Cloudflare dashboard shows the tag on the
Worker's Deployments page.

## Options

| Option | What it does |
|---|---|
| `--name <name>` | Names the Worker and its D1 database. The default is `ntasks`. |
| `--account <id or name>` | Chooses the Cloudflare account when your login reaches several. `CLOUDFLARE_ACCOUNT_ID` chooses it too. |
| `--dry-run` | Prints the plan and changes nothing in the account. It still logs in to read the account. |
| `--version` | Prints the release this package deploys. |

`npx ntasks@<version> deploy` deploys that release in place of the latest.

A run stops without changing anything when the login reaches several accounts
and none is chosen, or when the account's Worker of that name is not an Ntasks
deployment: its deployed version lacks the `TASK_STORE` Durable Object
binding to the class `TaskStore` or the D1 binding `DB`, or it has no
deployed version and no D1 database of its name. An update replaces the
Worker's code and applies migrations to its database, so run it with
`--dry-run` first when the account holds other Workers: the plan names the
account, the Worker, the database and the migrations.

## Build and release

This package is built from [`tools/cli`](https://github.com/notice-cx/Ntasks/tree/main/tools/cli)
in the Ntasks repository. From the repository root, `pnpm build` builds the
web app, then `pnpm run package` builds this package in `tools/cli/dist`:
`scripts/build.ts` bundles the Worker with wrangler from the root
`wrangler.jsonc`, copies the web app's
build and the D1 migrations, compiles `src` and writes the package's
`wrangler.json`, `package.json` and `THIRD_PARTY_LICENSES.md`. It then checks
the files `npm pack` would publish, and runs `wrangler deploy --dry-run` on the
configuration and bundle the command deploys.

The tests in `test/` run the command against `test/fake-wrangler.ts`, a
stand-in for wrangler and a Cloudflare account kept in a JSON file. They never
reach Cloudflare.

### Releasing

A release is the owner approving the CI run of the ntasks release pull
request, merging the pull request, then pressing **Approve and deploy**. Agents
never approve, merge or turn on auto-merge for a release pull request.

After each push to `main`, the Release PRs workflow
(`.github/workflows/release-please.yml`) runs
[release-please](https://github.com/googleapis/release-please). While `main`
holds a `feat`, `fix`, `perf` or `revert` commit or a breaking change made
since the last release, it keeps one pull request open, titled
`chore(main): release ntasks <version>`. The pull
request raises `version` in `tools/cli/package.json` and in the MCP server's
`SERVER_INFO`, and adds those commits to the root `CHANGELOG.md`. Before 1.0.0,
a `feat` commit or a breaking change raises the minor version and any other
commit the patch version. A commit counts for this package unless every file it
changes is under one of the folders `exclude-paths` lists in
`release-please-config.json`: the website, the docs, the protocol, the skill,
the workflows and the tools other than `tools/cli`.

Merging the pull request creates the tag `v<version>` and its GitHub release,
then starts the Release workflow (`.github/workflows/release.yml`) on that tag.
The workflow waits for the owner to approve the `npm` environment. It then
checks and builds the repository and publishes `tools/cli/dist` to npm.

The owner's steps:

1. On the pull request `chore(main): release ntasks <version>`, open the
   **Files changed** tab, click **Awaiting approval** at the top right, then
   **Approve workflows to run**. GitHub holds the pull request's CI run until
   someone approves it, because a workflow, not a person, opened the pull
   request.
2. When its checks pass, click **Merge when ready**, then **Confirm merge when
   ready**, at the bottom of the **Conversation** tab.
3. When the Release run waits for review (GitHub emails the owner), open it,
   click **Review deployments**, tick **npm** and click **Approve and deploy**.

When more changes reach `main` before the pull request merges, release-please
rebuilds it, and the new CI run waits for approval again: repeat step 1.

To run a failed or rejected publish again, open **Actions**, choose
**Release**, click **Run workflow**, pick the tag `v<version>` under **Use
workflow from** and click **Run workflow**. The workflow stops if it is run on a
branch, or on a tag that does not name the version in `tools/cli/package.json`.
