# @ntasks/lint

Tests for the repository's lint check. The check itself is
[`eslint.config.js`](../../eslint.config.js) at the repository root, run by
`pnpm lint`: it reports a promise that nothing handles, meaning it is not
awaited, returned, marked `void` or given a `.catch()`
(`@typescript-eslint/no-floating-promises`), and a promise used where the code
expects no promise (`@typescript-eslint/no-misused-promises`).

| File | Holds |
|---|---|
| [`fixtures/promises.ts`](fixtures/promises.ts) | Code that breaks those rules on purpose. A line that ends with a rule's name must be reported by that rule, and no other line may be reported |
| [`test/promises.test.ts`](test/promises.test.ts) | Lints the fixture with the repository's configuration and compares what it reports with the marked lines |

`pnpm lint` skips the fixture directory. If a change to the configuration
stops it reporting a marked line, or makes it report an unmarked one, the test
fails.

## Commands

```sh
pnpm --filter @ntasks/lint test
pnpm --filter @ntasks/lint typecheck
```
