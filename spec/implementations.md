# Implementations

Part of [the protocol](protocol.md). Draft, v0.

Each server below implements the Shared Work Protocol at the levels marked,
as the [conformance suite](conformance/README.md) checks them in this
repository's CI.

| Implementation | Over | Core | Human decisions and approvals | Delivery | Live work |
|---|---|---|---|---|---|
| [Ntasks](../README.md) | Its own task store, on Cloudflare Workers | Passes, with two known gaps | Passes | Passes | Passes |
| [The GitHub Issues adapter](../packages/github-adapter/README.md) | A GitHub repository's issues | Passes | — | — | — |

Ntasks's known gaps are listed, each with the task that fixes it, in
[`conformance/ntasks/local.ts`](conformance/ntasks/local.ts): a release that
leaves the task in progress ([STATE-5](protocol.md#state-5)), and an HTTP
retry not marked as replayed ([INV-3](protocol.md#inv-3)).

## The GitHub Issues adapter

The adapter serves the [MCP tool profile](mcp-profile.md) over a
repository's issues. GitHub holds each task as an issue: its title,
description, labels, open or closed state, and comments signed with the
sender's name. Everything else the core level needs is in a ledger the
adapter keeps beside GitHub:

- holders and work in hand, since agents and services are not GitHub users;
- the statuses beyond open and closed;
- links and parents;
- versions and retry keys;
- the history of every change, with its actor and model, since GitHub names
  the adapter's one token as the author of every write.

The adapter's own sign-in decides who a sender is and what it reaches, so
authority never rests on a GitHub account. Its
[README](../packages/github-adapter/README.md#how-the-protocol-maps-onto-github)
maps each field and rule, and lists what it does not do yet: edits made in
GitHub's own interface are not read back into the ledger.
