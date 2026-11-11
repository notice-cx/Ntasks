import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { emptyAccount, release, runCli, writes, type Run } from './fake-account.ts';
import { fakeRegistry, unreachableRegistry } from './fake-registry.ts';

const FIRST = '0001_sign_in_and_workspaces.sql';

/** The release tag of the Worker version the account serves, if any. */
function deployedTag(run: Run): string | null | undefined {
  const [worker] = run.after.workers;
  return worker?.versions.find((version) => version.id === worker.deployed)?.tag;
}

test('an installed copy older than the latest release names both and deploys only when the person confirms', async () => {
  const registry = await fakeRegistry('0.2.0');
  try {
    const dir = await release('0.1.0', [FIRST]);
    const questions: string[] = [];
    const answering = (answer: string) => async (question: string) => {
      questions.push(question);
      return answer;
    };

    for (const [label, ask] of [
      ['no terminal', undefined],
      ['no', answering('n')],
      ['Enter', answering('')],
    ] as const) {
      const run = await runCli(['deploy'], dir, emptyAccount(), { registry: registry.url, ask });
      assert.equal(run.code, 1, label);
      assert.deepEqual(writes(run.after), [], label);
      assert.deepEqual(run.after.calls, [], `${label}: nothing reached wrangler`);
      for (const shown of ['0.1.0', '0.2.0', 'npx ntasks@latest deploy']) assert.ok(run.out.includes(shown), shown);
    }
    assert.equal(questions.length, 2);

    const confirmed = await runCli(['deploy'], dir, emptyAccount(), { registry: registry.url, ask: answering('y') });
    assert.equal(confirmed.code, 0, confirmed.err);
    assert.equal(deployedTag(confirmed), 'v0.1.0');

    const dryRun = await runCli(['deploy', '--dry-run'], dir, emptyAccount(), {
      registry: registry.url,
      ask: answering('n'),
    });
    assert.equal(dryRun.code, 0, dryRun.err);
    assert.deepEqual(writes(dryRun.after), []);
    assert.ok(dryRun.out.includes('npx ntasks@latest deploy'));
    assert.equal(questions.length, 3, '--dry-run asks nothing');
  } finally {
    await registry.close();
  }
});

test('the latest release, or a newer build, deploys with no question', async () => {
  for (const version of ['0.2.0', '0.3.0-beta.1']) {
    const registry = await fakeRegistry('0.2.0');
    try {
      const run = await runCli(['deploy'], await release(version, [FIRST]), emptyAccount(), {
        registry: registry.url,
        ask: () => Promise.reject(new Error('asked a question')),
      });
      assert.equal(run.code, 0, run.err);
      assert.equal(deployedTag(run), `v${version}`);
      assert.deepEqual(registry.requests, ['/-/package/ntasks/dist-tags']);
    } finally {
      await registry.close();
    }
  }
});

test('a registry that cannot be reached skips the check and deploys', async () => {
  const run = await runCli(['deploy'], await release('0.1.0', [FIRST]), emptyAccount(), {
    registry: await unreachableRegistry(),
  });

  assert.equal(run.code, 0, run.err);
  assert.equal(deployedTag(run), 'v0.1.0');
  assert.match(run.out, /skipped/u);
});

test("a copy in npx's own cache deploys the release npx resolved without reading the registry", async () => {
  const registry = await fakeRegistry('0.2.0');
  try {
    const cache = await mkdtemp(path.join(tmpdir(), 'ntasks-cli-npm-cache-'));
    const dir = await release('0.1.0', [FIRST], path.join(cache, '_npx', '3f2a', 'node_modules', 'ntasks'));

    const run = await runCli(['deploy'], dir, emptyAccount(), { registry: registry.url });

    assert.equal(run.code, 0, run.err);
    assert.equal(deployedTag(run), 'v0.1.0');
    assert.deepEqual(registry.requests, []);
  } finally {
    await registry.close();
  }
});
