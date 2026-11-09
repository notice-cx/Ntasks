# The Shared Work Protocol

**An open contract for shared work between people and AI agents. Draft,
v0, 2026-11-09.**

This folder holds the Shared Work Protocol: a draft specification of the
record people and AI agents
share when they work together: tasks, claims, decisions and approvals that
only a person can give, proof that work is done, and where a finished
change has reached. Any task tool, agent harness or adapter can implement
it. Ntasks is its reference implementation, and the draft was extracted
from what Ntasks does today.

Version 0 promises nothing beyond itself. Where Ntasks's behavior is
unclear, the draft asks a question instead of stating a rule.

## Implementations

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

### The GitHub Issues adapter

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

## What is here

| Path | Holds |
|---|---|
| [`protocol.md`](protocol.md) | The protocol: motivation, terms, objects, the state machine, authority rules, invariants, conformance levels, extensions, versioning and security |
| [`mcp-profile.md`](mcp-profile.md) | Section 11: the MCP tools a server offers, mapped from Ntasks's |
| [`http-binding.md`](http-binding.md) | Section 12: the HTTP routes, mapped from Ntasks's |
| [`tests.md`](tests.md) | Appendix A: each rule and the Ntasks test that proves it, and the rules no test covers yet |
| [`open-questions.md`](open-questions.md) | Appendix B: the open questions |
| [`schemas/`](schemas/) | A JSON Schema (draft 2020-12) for each object |
| [`examples/`](examples/) | Sample objects for each schema: `examples/<schema>/` must validate, `examples/<schema>/invalid/` must not |
| [`conformance/`](conformance/README.md) | The conformance suite: checks any server against each rule, by level, over MCP and HTTP, and runs against Ntasks in CI |
| [`test/`](test/) | The tests that validate the samples, keep Appendix A true, and show that the conformance suite fails a server that breaks a rule |

Start with sections 1 and 3 of [`protocol.md`](protocol.md), then the
[MCP tool profile](mcp-profile.md).

## Run the tests

From the repository root, after `pnpm install`:

```sh
pnpm --filter @ntasks/spec test
```

[`test/schemas.test.ts`](test/schemas.test.ts) compiles every schema and
checks each sample against it. [`test/appendix.test.ts`](test/appendix.test.ts)
fails when a test Appendix A names no longer exists, or when a rule of the
protocol is missing from it. [`test/conformance.test.ts`](test/conformance.test.ts)
runs the conformance suite through a server that breaks one rule at a time,
and fails unless exactly that rule's checks fail.

To check a server, or this repository's Worker run locally, follow
[`conformance/README.md`](conformance/README.md):

```sh
pnpm --filter @ntasks/spec run conformance -- --target target.json
pnpm --filter @ntasks/spec run conformance:ntasks
```

## Licenses

The specification is licensed separately from Ntasks's code, so that other
projects can adopt it:

| Paths | License |
|---|---|
| The text: `README.md`, `protocol.md`, `mcp-profile.md`, `http-binding.md`, `tests.md`, `open-questions.md` | [Creative Commons Attribution 4.0 International](LICENSE-CC-BY-4.0) (`CC-BY-4.0`) |
| The schemas, samples, tests and conformance suite: `schemas/`, `examples/`, `test/`, `conformance/`, `package.json`, `tsconfig.json` | [Apache License 2.0](LICENSE-APACHE-2.0) (`Apache-2.0`) |

The rest of this repository, Ntasks itself, stays under the
[GNU Affero General Public License, version 3](../LICENSE).

## Comments and changes

Open an issue or a pull request in this repository. A change to a rule
cites what Ntasks does, or a test, or names the open question it answers.
