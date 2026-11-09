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
2. Creates a D1 database named `ntasks`.
3. Applies the D1 migrations to it.
4. Makes an `AUTH_SECRET` and deploys a Worker named `ntasks` with it.
5. Prints the Worker's address and the setup steps: open `/sign-in`, enter
   the `AUTH_SECRET` it printed and choose **Create the GitHub App**. Keep a
   copy of `AUTH_SECRET`; the command shows it only on this run.

A later run finds the Worker and its database in the account by name, applies
the D1 migrations the database lacks, deploys the new release and prints the
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
and none is chosen, or when the account has a Worker of that name but no D1
database of that name, since that Worker is not an Ntasks deployment.

## Build and release

This package is built from [`tools/cli`](https://github.com/notice-cx/Ntasks/tree/main/tools/cli)
in the Ntasks repository. From the repository root, `pnpm build` builds the
web app, then this package in `tools/cli/dist`: `scripts/build.ts` bundles
the Worker with wrangler from the root `wrangler.jsonc`, copies the web app's
build and the D1 migrations, compiles `src` and writes the package's
`wrangler.json`, `package.json` and `THIRD_PARTY_LICENSES.md`. It then checks
the files `npm pack` would publish, and runs `wrangler deploy --dry-run` on the
configuration and bundle the command deploys.

The tests in `test/` run the command against `test/fake-wrangler.ts`, a
stand-in for wrangler and a Cloudflare account kept in a JSON file. They never
reach Cloudflare.

To release, raise `version` in `tools/cli/package.json` in a pull request.
After it merges, a maintainer pushes the tag `v<version>` on that commit of
`main`, and the Release workflow (`.github/workflows/release.yml`) checks and
builds the repository and publishes `tools/cli/dist` to npm.
