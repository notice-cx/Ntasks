// Run by `node --test`. It lints a file that breaks the Worker-code rules on
// purpose, with the repository's own ESLint configuration, as if the file sat
// in each place below. The check cannot stop catching those mistakes, or start
// applying outside the code it is meant for, without this test failing.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const root = join(import.meta.dirname, '../../..');
const fixture = join(import.meta.dirname, '../fixtures/worker-rules.ts');

const MODULE_STATE_AND_SECRETS = 'no-restricted-syntax';
const RANDOM = 'no-restricted-properties';

// A path the file is pretended to have, and the marked rules that apply there.
const places: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['workers/api/src/fixture.ts', [MODULE_STATE_AND_SECRETS, RANDOM]],
  ['packages/domain/src/fixture.ts', [MODULE_STATE_AND_SECRETS, RANDOM]],
  ['workers/api/test/fixture.ts', [RANDOM]],
  ['apps/web/src/fixture.ts', []],
];

const source = await readFile(fixture, 'utf8');
const marks = source.split('\n').flatMap((text, index) => {
  const rule = /\/\/ (no-restricted-(?:syntax|properties))$/u.exec(text)?.[1];
  return rule ? [{ line: index + 1, rule }] : [];
});

for (const [path, rules] of places) {
  test(`lint reports the marked lines that apply to ${path}, and no other line`, async () => {
    // `ignore: false` lints the fixture, which the repository's lint run skips.
    // The pretended paths belong to no tsconfig.json, and the rules under test
    // read no types, so the rules that need types are switched off.
    const eslint = new ESLint({
      cwd: root,
      ignore: false,
      overrideConfig: {
        languageOptions: { parserOptions: { projectService: false } },
        rules: { '@typescript-eslint/no-floating-promises': 'off', '@typescript-eslint/no-misused-promises': 'off' },
      },
    });
    const [result] = await eslint.lintText(source, { filePath: join(root, path) });
    assert.ok(result, 'ESLint returned a result');

    const reported = result.messages.map((message) => `${message.line} ${message.ruleId}`);
    const expected = marks.filter((mark) => rules.includes(mark.rule)).map((mark) => `${mark.line} ${mark.rule}`);

    assert.ok(marks.length > 0, 'the fixture marks the lines that must be reported');
    assert.deepEqual(reported, expected, JSON.stringify(result.messages));
  });
}
