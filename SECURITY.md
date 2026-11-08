# Security

## Report a vulnerability

Send a private report with **Report a vulnerability** on the repository's
[Security tab](https://github.com/notice-cx/Ntasks/security/advisories/new),
or email **[hello@notice.cx](mailto:hello@notice.cx)**. Only the maintainers
see a report. Include the affected commit,
the steps to reproduce and the impact. Remove credentials and personal data
from examples and logs.

Keep vulnerability details out of public issues and pull requests until the
maintainers agree a fix or a disclosure plan with you.

## Deployment boundaries

Ntasks is designed to be reachable from the internet. Every API and MCP
request is signed in and checked against what its sender may do; only the
health check and the sign-in steps answer without it. The web app's files
are public and hold no task data. [Sign-in](docs/sign-in.md) describes who
can sign in and what each caller reaches.

A new deployment refuses every call that needs a signed-in sender until its
sign-in is set up; it never falls back to no checks. Its setup page, at
`/sign-in`, registers the GitHub App people sign in through only for a
request that carries the deployment's `AUTH_SECRET`, and only until sign-in
exists ([the setup page](docs/sign-in.md#the-setup-page)). After
`AUTH_SECRET` changes on a deployment set up that way, nobody signs in until
the setup runs again, while agent access tokens already issued, until they
expire, and service credentials still sign their calls in
([Changing AUTH_SECRET](docs/sign-in.md#changing-auth_secret)).

Keep secrets out of `wrangler.jsonc` and out of the repository. Set a deployed
secret on Cloudflare's deploy page for the Deploy to Cloudflare button or
with `wrangler secret put`; put local values in `.dev.vars` at the repository
root, which git ignores.

## Supported versions

Ntasks has no release yet. Security fixes land on `main`.
