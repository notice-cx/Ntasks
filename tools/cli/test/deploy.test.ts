import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { compareReleases } from '../src/deploy.ts';
import { emptyAccount, EXAMPLE_ACCOUNT, release, runCli, writes, type FakeAccountState } from './fake-account.ts';

const FIRST = '0001_sign_in_and_workspaces.sql';
const SECOND = '0002_example_change.sql';

/** An account where npx ntasks deployed 0.1.0, with its first migration applied. */
function deployedAccount(): FakeAccountState {
  return emptyAccount({
    databases: [{ accountId: EXAMPLE_ACCOUNT.id, uuid: 'db-1', name: 'ntasks', applied: [FIRST] }],
    workers: [
      {
        accountId: EXAMPLE_ACCOUNT.id,
        name: 'ntasks',
        secrets: { AUTH_SECRET: 'secret-set-by-the-first-deploy-0000000000' },
        versions: [{ id: 'version-1', tag: 'v0.1.0', message: 'Ntasks 0.1.0' }],
        deployed: 'version-1',
      },
    ],
  });
}

function withoutCalls({ calls: _calls, ...rest }: FakeAccountState) {
  return rest;
}

test('a first deploy signs in, creates the database, applies its migrations and sets AUTH_SECRET with the Worker', async () => {
  const run = await runCli(['deploy'], await release('0.1.0', [FIRST]), emptyAccount({ loggedIn: false }));

  assert.equal(run.code, 0, run.err);
  assert.equal(run.after.loggedIn, true);
  const [database] = run.after.databases;
  assert.deepEqual(database && { name: database.name, applied: database.applied }, {
    name: 'ntasks',
    applied: [FIRST],
  });
  const [worker] = run.after.workers;
  assert.ok(worker);
  assert.equal(worker.name, 'ntasks');
  assert.equal(worker.versions.find((version) => version.id === worker.deployed)?.tag, 'v0.1.0');
  // The secret the Worker holds is the one printed for the setup page, and
  // none of the caller's environment.
  const secret = worker.secrets['AUTH_SECRET'] ?? '';
  assert.ok(secret.length >= 32);
  assert.ok(run.out.includes(secret));
  assert.ok(run.out.includes('https://ntasks.example.workers.dev/sign-in'));
  // Every command ran in the account the login reaches, and the folder that
  // held the secrets file is gone.
  assert.ok(
    run.after.calls
      .filter((call) => call.args[0] !== 'whoami' && call.args[0] !== 'login')
      .every((call) => call.account === EXAMPLE_ACCOUNT.id),
  );
  assert.ok(run.after.calls.every((call) => !existsSync(call.cwd)));
});

test('an update applies the one new migration and deploys the new release with the secrets it has', async () => {
  const run = await runCli(['deploy'], await release('0.2.0', [FIRST, SECOND]), deployedAccount());

  assert.equal(run.code, 0, run.err);
  assert.deepEqual(run.after.databases[0]?.applied, [FIRST, SECOND]);
  const [worker] = run.after.workers;
  assert.equal(worker?.versions.find((version) => version.id === worker.deployed)?.tag, 'v0.2.0');
  assert.deepEqual(worker?.secrets, run.before.workers[0]?.secrets);
  const changes = writes(run.after);
  assert.deepEqual(
    changes.map((args) => (args[0] === 'd1' ? args.slice(0, 3).join(' ') : args[0])),
    ['d1 migrations apply', 'deploy'],
  );
  assert.ok(!changes.some((args) => args.includes('--secrets-file')));
  // The output names the release before and after, and the migration applied.
  for (const shown of ['0.1.0', '0.2.0', SECOND]) assert.ok(run.out.includes(shown), shown);
  assert.ok(!run.out.includes(run.before.workers[0]?.secrets['AUTH_SECRET'] ?? 'unset'));
});

test('--dry-run reads the account, prints the plan and changes nothing', async () => {
  const run = await runCli(['deploy', '--dry-run'], await release('0.2.0', [FIRST, SECOND]), deployedAccount());

  assert.equal(run.code, 0, run.err);
  assert.deepEqual(writes(run.after), []);
  assert.deepEqual(withoutCalls(run.after), withoutCalls(run.before));
  for (const shown of ['0.1.0', '0.2.0', SECOND]) assert.ok(run.out.includes(shown), shown);
});

test('a login that reaches several accounts deploys only to the account --account names', async () => {
  const second = { id: 'fedcba9876543210fedcba9876543210', name: 'Second' };
  const account = emptyAccount({ accounts: [EXAMPLE_ACCOUNT, second] });
  const dir = await release('0.1.0', [FIRST]);

  const unchosen = await runCli(['deploy'], dir, account);
  assert.equal(unchosen.code, 1);
  assert.deepEqual(writes(unchosen.after), []);
  assert.ok(unchosen.err.includes(second.id));

  const chosen = await runCli(['deploy', '--account', 'Second'], dir, account);
  assert.equal(chosen.code, 0, chosen.err);
  assert.deepEqual(
    chosen.after.databases.map((database) => database.accountId),
    [second.id],
  );
  assert.deepEqual(
    chosen.after.workers.map((worker) => worker.accountId),
    [second.id],
  );
});

test('a Worker of that name with no database of that name is left alone', async () => {
  const account = deployedAccount();
  account.databases = [];

  const run = await runCli(['deploy'], await release('0.2.0', [FIRST]), account);

  assert.equal(run.code, 1);
  assert.deepEqual(writes(run.after), []);
});

test('a first deploy that stops after Cloudflare created the Worker shows the AUTH_SECRET it set', async () => {
  const run = await runCli(['deploy'], await release('0.1.0', [FIRST]), emptyAccount({ failDeployAfterUpload: true }));

  assert.equal(run.code, 1);
  const secret = run.after.workers[0]?.secrets['AUTH_SECRET'];
  assert.ok(secret);
  assert.ok(run.err.includes(secret));
});

test('releases are ordered by their numbers, with a pre-release before its release', () => {
  const ordered = ['0.1.0', '0.2.0-beta.1', '0.2.0', '0.10.0', '1.0.0'];
  for (const [index, older] of ordered.entries()) {
    for (const newer of ordered.slice(index + 1)) {
      assert.ok(compareReleases(older, newer) < 0, `${older} < ${newer}`);
      assert.ok(compareReleases(newer, older) > 0, `${newer} > ${older}`);
    }
    assert.equal(compareReleases(older, older), 0);
  }
});
