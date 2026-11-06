# Security

## Report a vulnerability

Email **[hello@notice.cx](mailto:hello@notice.cx)** with a private report.
Include the affected commit, the steps to reproduce and the impact. Remove
credentials and personal data from examples and logs.

Keep vulnerability details out of public issues and pull requests until the
maintainers agree a fix or a disclosure plan with you.

## Deployment boundaries

Ntasks is designed to be reachable from the internet. Every API and MCP
request will be signed in and checked against what its sender may do; only
the health check and the sign-in steps answer without it. The web app's files
are public and hold no task data.

**Sign-in is not built yet.** Until it is, the Worker refuses every API and
MCP request with `401`, so a deployment serves no task data. The
[README's status table](README.md#status) shows when sign-in is available.

Keep secrets out of `wrangler.jsonc` and out of the repository. Set a deployed
secret with `wrangler secret put`; put local values in `.dev.vars`, which git
ignores.

## Supported versions

Ntasks has no release yet. Security fixes land on `main`.
