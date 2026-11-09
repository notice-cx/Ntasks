# @ntasks/lint

Tests for the repository's checks of the
[rules for Worker code](../../CONTRIBUTING.md#rules-for-worker-code), and of
the files at the repository's root.

The lint check itself is [`eslint.config.js`](../../eslint.config.js) at the
repository root, run by `pnpm lint`. It reports:

- a promise that nothing handles, meaning it is not awaited, returned, marked
  `void` or given a `.catch()`
  (`@typescript-eslint/no-floating-promises`), and a promise used where the
  code expects no promise (`@typescript-eslint/no-misused-promises`);
- in `workers/*/src` and `packages/*/src`, a module-level `let` or `var`, a
  module-level collection that starts empty, and a comparison operator applied
  to a variable or property named like a secret (`no-restricted-syntax`);
- `Math.random` in `workers/` and `packages/` (`no-restricted-properties`).

| File | Holds |
|---|---|
| [`fixtures/promises.ts`](fixtures/promises.ts) | Code that breaks the promise rules on purpose. A line that ends with a rule's name must be reported by that rule, and no other line may be reported |
| [`test/promises.test.ts`](test/promises.test.ts) | Lints that fixture with the repository's configuration and compares what it reports with the marked lines |
| [`fixtures/worker-rules.ts`](fixtures/worker-rules.ts) | Code that breaks the other rules on purpose, marked the same way, with the code those rules must leave alone |
| [`test/worker-rules.test.ts`](test/worker-rules.test.ts) | Lints that fixture as if it sat in `workers/api/src`, `packages/domain/src`, `workers/api/test` and `apps/web/src`, and compares what it reports in each place with the marked lines that apply there |
| [`test/install-script.test.ts`](test/install-script.test.ts) | Runs the root [`install.sh`](../../install.sh) with a temporary `HOME` and stand-in `claude`, `codex` and `gemini` commands that record their arguments, and checks the servers it registers, the skill files it writes, that a second run changes nothing, that a registration at another address or as a local command is replaced only with `--yes`, that it fails when it cannot write the skill, and the addresses and agents it refuses. No test reaches the network |
| [`test/wrangler-vars.test.ts`](test/wrangler-vars.test.ts) | Fails when a variable under `vars` in the root `wrangler.jsonc` or a `workers/*/wrangler.jsonc` has a name that sounds like a secret, and when the secrets the Deploy to Cloudflare button asks for (`.dev.vars.example`, with descriptions under `cloudflare.bindings` in the root `package.json`) differ from `secrets.required` in `wrangler.jsonc`. Lint does not run these checks, because the files are not TypeScript |

`pnpm lint` skips the fixture directory. If a change to the configuration
stops it reporting a marked line, or makes it report an unmarked one, a test
fails.

## Commands

```sh
pnpm --filter @ntasks/lint test
pnpm --filter @ntasks/lint typecheck
```
