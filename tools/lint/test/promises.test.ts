// Run by `node --test`. It lints a file that breaks the promise rules on
// purpose, with the repository's own ESLint configuration, so the check cannot
// stop catching those mistakes without this test failing.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const root = join(import.meta.dirname, '../../..');
const fixture = join(import.meta.dirname, '../fixtures/promises.ts');

test('lint reports the promises the fixture marks, and no other line', async () => {
  // `ignore: false` lints the fixture, which the repository's lint run skips.
  const eslint = new ESLint({ cwd: root, ignore: false });
  const [result] = await eslint.lintFiles([fixture]);
  assert.ok(result, 'ESLint returned a result for the fixture');

  const reported = result.messages.map((message) => `${message.line} ${message.ruleId}`);
  const marked = (await readFile(fixture, 'utf8')).split('\n').flatMap((text, index) => {
    const rule = /\/\/ (no-[a-z-]+-promises)$/u.exec(text)?.[1];
    return rule ? [`${index + 1} @typescript-eslint/${rule}`] : [];
  });

  assert.ok(marked.length > 0, 'the fixture marks the lines that must be reported');
  assert.deepEqual(reported, marked, JSON.stringify(result.messages));
});
