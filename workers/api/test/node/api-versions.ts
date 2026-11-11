// Run by `node --test`. Each version of the HTTP API is one file in
// api-versions/, and the version the Worker answers is how many there are
// (scripts/api-versions.ts). Two pull requests that each add a version add
// one file each, so they merge in either order without a conflict, and the
// version goes up by one with each. This merges two such changes in a scratch
// git repository, in both orders, with git's own merge, the merge GitHub's
// merge queue makes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { apiVersionsIn, GENERATED_FILE, VERSIONS_DIR, writeApiVersions } from '../../scripts/api-versions.ts';

const scratch = mkdtempSync(path.join(tmpdir(), 'ntasks-api-versions-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs git in `repo`, apart from the machine's own git settings, and answers its exit status and output. */
function git(repo: string, ...args: string[]): { status: number | null; output: string } {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Ntasks test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      '-C',
      repo,
      ...args,
    ],
    { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Runs git in `repo` and fails the test when git does. */
function gitOk(repo: string, ...args: string[]): string {
  const { status, output } = git(repo, ...args);
  assert.equal(status, 0, `git ${args.join(' ')}: ${output}`);
  return output;
}

/** A repository whose main holds this repository's api-versions/ and `files`, with a branch per change. */
function repository(name: string, files: Record<string, string>, changes: Record<string, Record<string, string>>) {
  const repo = path.join(scratch, name);
  mkdirSync(repo);
  gitOk(repo, 'init', '--quiet');
  cpSync(VERSIONS_DIR, path.join(repo, 'api-versions'), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(repo, file), text);
  gitOk(repo, 'add', '.');
  gitOk(repo, 'commit', '--quiet', '-m', 'main');
  for (const [branch, written] of Object.entries(changes)) {
    gitOk(repo, 'switch', '--quiet', '-c', branch, 'main');
    for (const [file, text] of Object.entries(written)) writeFileSync(path.join(repo, file), text);
    gitOk(repo, 'add', '.');
    gitOk(repo, 'commit', '--quiet', '-m', branch);
  }
  gitOk(repo, 'switch', '--quiet', 'main');
  return repo;
}

/** A version's file, recording one field it adds to a task. */
const addingField = (field: string) =>
  `${JSON.stringify({ added: `\`${field}\` on a task`, shapes: { task: { [field]: 'string' } } }, null, 2)}\n`;

test('lists the files in api-versions/ oldest first, as the Worker counts them', () => {
  const versions = writeApiVersions();
  const files = readdirSync(VERSIONS_DIR)
    .filter((file) => !file.startsWith('.'))
    .sort();
  assert.deepEqual(
    versions,
    files.map((file) => file.replace(/\.json$/u, '')),
  );
  assert.deepEqual(JSON.parse(readFileSync(GENERATED_FILE, 'utf8')), versions);
  assert.ok(versions.length >= 8, 'versions 1 to 8 are recorded');
  assert.equal(versions[0], '2026-11-09T1946Z-routes');
});

test('refuses a file not named as a version, which would sort where its name puts it', () => {
  const dir = path.join(scratch, 'misnamed');
  mkdirSync(dir);
  writeFileSync(path.join(dir, '2026-11-10T0137Z-stalled-tasks.json'), addingField('stalled'));
  writeFileSync(path.join(dir, '.DS_Store'), '');
  assert.deepEqual(apiVersionsIn(dir), ['2026-11-10T0137Z-stalled-tasks']);
  writeFileSync(path.join(dir, 'release.json'), addingField('release'));
  assert.throws(() => apiVersionsIn(dir), /not named as a version.*release\.json/u);
});

test('merges two changes that each add a version, in either order, one version up per change', () => {
  // beta's file sorts first though it is written later, as when the change
  // opened first merges second. Both are dated after every real version, so
  // they sort last among them.
  const repo = repository(
    'two-changes',
    {},
    {
      alpha: { 'api-versions/2999-01-01T0900Z-alpha.json': addingField('alpha') },
      beta: { 'api-versions/2999-01-01T0800Z-beta.json': addingField('beta') },
    },
  );
  const before = apiVersionsIn(path.join(repo, 'api-versions')).length;
  const finals: string[][] = [];
  for (const order of [
    ['alpha', 'beta'],
    ['beta', 'alpha'],
  ]) {
    gitOk(repo, 'switch', '--quiet', '-c', `merged-${order.join('-')}`, 'main');
    const counts = [before];
    for (const branch of order) {
      const merged = git(repo, 'merge', '--no-ff', '--no-edit', branch);
      assert.equal(merged.status, 0, `merging ${branch} after ${order[0]}: ${merged.output}`);
      counts.push(apiVersionsIn(path.join(repo, 'api-versions')).length);
    }
    assert.deepEqual(counts, [before, before + 1, before + 2], `the versions as ${order.join(' then ')} merge`);
    finals.push(apiVersionsIn(path.join(repo, 'api-versions')));
    gitOk(repo, 'switch', '--quiet', 'main');
  }
  assert.deepEqual(finals[0], finals[1], 'both orders end with the same versions');
  assert.deepEqual(finals[0]!.slice(-2), ['2999-01-01T0800Z-beta', '2999-01-01T0900Z-alpha']);
});

test('finds the conflict two changes made when each added a row to one shared table', () => {
  const table = '| Version | Added |\n|---|---|\n| 8 | `stalled` on a task |\n';
  const repo = repository(
    'one-table',
    { 'versions.md': table },
    {
      alpha: { 'versions.md': `${table}| 9 | \`alpha\` on a task |\n` },
      beta: { 'versions.md': `${table}| 9 | \`beta\` on a task |\n` },
    },
  );
  gitOk(repo, 'switch', '--quiet', '-c', 'merged', 'main');
  gitOk(repo, 'merge', '--no-ff', '--no-edit', 'alpha');
  const second = git(repo, 'merge', '--no-ff', '--no-edit', 'beta');
  assert.notEqual(second.status, 0, 'the second change conflicts');
  assert.equal(gitOk(repo, 'diff', '--name-only', '--diff-filter=U').trim(), 'versions.md');
  gitOk(repo, 'merge', '--abort');
});
