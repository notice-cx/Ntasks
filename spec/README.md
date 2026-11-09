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
| [`implementations.md`](implementations.md) | Each server that implements the protocol, and the levels it passes |
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
