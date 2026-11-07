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

A deployment with no sign-in settings refuses every call that needs a
signed-in sender; it never falls back to no checks.

Keep secrets out of `wrangler.jsonc` and out of the repository. Set a deployed
secret on the Deploy to Cloudflare button's setup page or with
`wrangler secret put`; put local values in `.dev.vars` at the repository root,
which git ignores.

## Supported versions

Ntasks has no release yet. Security fixes land on `main`.
