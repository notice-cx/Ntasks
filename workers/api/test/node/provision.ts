// Run by `node --test`. A deployment nobody signs in to, as a product demo
// runs one: its D1 database provisioned by tools/migrate's provision command,
// its public workspace's store loaded from a seed through the seed
// credential, read by visitors with no credential, and changed only through
// the credential granted its projects.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestHarness, unstable_readConfig } from 'wrangler';
import { copyAsBackup, loadIntoStore } from '../../../../tools/migrate/src/load.ts';
import { openLocalStore } from '../../../../tools/migrate/src/local-store.ts';
import { planProvision, PROVISION_REQUEST_FORMAT } from '../../../../tools/migrate/src/provision.ts';
import { planSeed, SEED_FORMAT } from '../../../../tools/migrate/src/seed.ts';

const WORKSPACE = 'b2222222-0000-4000-8000-000000000002';
const RECIPES = 'a1111111-0000-4000-8000-000000000001';
const LEDGER = 'a1111111-0000-4000-8000-000000000003';
const ORIGIN = 'http://localhost:8787';

const configPath = fileURLToPath(new URL('../../../../wrangler.jsonc', import.meta.url));
const config = unstable_readConfig({ config: configPath }, { hideWarnings: true });

const server = createTestHarness({
  workers: [
    {
      config: {
        name: config.name,
        main: config.main,
        compatibility_date: config.compatibility_date,
        d1_databases: config.d1_databases.map(
          ({ binding, database_name }: { binding: string; database_name?: string }) => ({
            binding,
            ...(database_name === undefined ? {} : { database_name }),
          }),
        ),
        ratelimits: config.ratelimits,
        durable_objects: config.durable_objects,
        migrations: config.migrations,
        rules: config.rules,
        // Sign-in is on, with invented GitHub values that nothing here reaches:
        // nobody signs in to this deployment.
        vars: {
          NTASKS_ORIGIN: ORIGIN,
          AUTH_SECRET: 'test-only-auth-secret-0123456789abcdef',
          GITHUB_CLIENT_ID: 'test-github-client-id',
          GITHUB_CLIENT_SECRET: 'test-github-client-secret',
          PUBLIC_WORKSPACE_ID: WORKSPACE,
        },
      },
    },
  ],
});

let tokens: Readonly<Record<string, string>> = {};

before(async () => {
  await server.listen();
  const { file } = planProvision({
    format: PROVISION_REQUEST_FORMAT,
    workspace: { id: WORKSPACE, name: 'Demo' },
    owner: { name: 'Mara' },
    credentials: [
      { name: 'seed', backup: true, restore: true },
      { name: 'activity', grants: [{ projectId: RECIPES, access: 'write' }] },
    ],
  });
  assert.ok(file);
  tokens = file.tokens;
  const { DB } = (await server.getWorker().getEnv()) as {
    DB: {
      prepare(sql: string): { bind(...values: unknown[]): unknown };
      batch(statements: unknown[]): Promise<unknown>;
    };
  };
  await DB.batch(file.statements.map(({ sql, values }) => DB.prepare(sql).bind(...values)));

  const { plan } = planSeed({
    format: SEED_FORMAT,
    projects: [
      { id: RECIPES, key: 'rcp', name: 'Recipes', prefix: 'rcp', createdAt: '2026-09-01T00:00:00.000Z' },
      { id: LEDGER, key: 'ldg', name: 'Ledger', prefix: 'ldg', createdAt: '2026-09-01T00:00:00.000Z' },
    ],
    tasks: [
      {
        id: 'rcp-a1b2',
        title: 'Shrink the recipe card images',
        createdAt: '2026-09-02T10:00:00.000Z',
        createdBy: 'Mara',
        changes: [
          {
            at: '2026-09-03T10:00:00.000Z',
            by: 'claude',
            model: 'Opus 5.5',
            status: 'in_progress',
            assignee: 'claude',
          },
        ],
      },
      { id: 'ldg-c3d4', title: 'Reconcile October', createdAt: '2026-09-02T11:00:00.000Z', createdBy: 'Mara' },
    ],
  });
  assert.ok(plan);
  const copy = await openLocalStore(':memory:', { create: true });
  try {
    copy.load(plan);
    await loadIntoStore(copyAsBackup(copy, '2026-09-04T00:00:00.000Z'), {
      api: ORIGIN,
      token: tokens.seed!,
      fetch: (async (input: string | URL, init?: RequestInit) =>
        server.fetch(new URL(String(input)).pathname, init as never)) as unknown as typeof fetch,
    });
  } finally {
    copy.close();
  }
});

after(async () => {
  await server.close();
});

/** A request to the deployment: with a token, or as a visitor naming the public workspace. */
async function call(
  method: string,
  path: string,
  options: { readonly token?: string; readonly json?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await server.fetch(path, {
    method,
    headers: {
      ...(options.token === undefined
        ? { 'x-ntasks-workspace': WORKSPACE }
        : { authorization: `Bearer ${options.token}` }),
      ...(options.json === undefined
        ? {}
        : { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }),
    },
    ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test('a visitor reads the seeded projects and tasks with no credential', async () => {
  const projects = await call('GET', '/api/tasks/projects');
  assert.equal(projects.status, 200);
  assert.deepEqual(
    (projects.body.projects as { prefix: string }[]).map((project) => project.prefix),
    ['ldg', 'rcp'],
  );
  const board = await call('GET', `/api/tasks?project=${RECIPES}`);
  const [task] = board.body.tasks as { id: string; status: string; assignee: string }[];
  assert.deepEqual([task?.id, task?.status, task?.assignee], ['rcp-a1b2', 'in_progress', 'claude']);
});

test('a visitor is refused every change', async () => {
  const comment = await call('POST', '/api/tasks/rcp-a1b2/comments', { json: { projectId: RECIPES, text: 'hello' } });
  assert.deepEqual([comment.status, comment.body.error], [403, 'insufficient_scope']);
  const created = await call('POST', '/api/tasks', { json: { projectId: RECIPES, title: 'A visitor task' } });
  assert.equal(created.status, 403);
  const detail = await call('GET', `/api/tasks/rcp-a1b2?project=${RECIPES}`);
  assert.deepEqual(detail.body.comments, []);
});

test('the credential granted a project changes its tasks there, and reaches no other', async () => {
  const comment = await call('POST', '/api/tasks/rcp-a1b2/comments', {
    token: tokens.activity!,
    json: { projectId: RECIPES, text: 'Checked: the images are a third of the size.' },
  });
  assert.equal(comment.status, 200);
  const elsewhere = await call('POST', '/api/tasks/ldg-c3d4/comments', {
    token: tokens.activity!,
    json: { projectId: LEDGER, text: 'Not mine.' },
  });
  assert.equal(elsewhere.status, 404);
  const detail = await call('GET', `/api/tasks/rcp-a1b2?project=${RECIPES}`);
  assert.deepEqual(
    (detail.body.comments as { author: string }[]).map((entry) => entry.author),
    ['service:activity'],
  );
});

test('the seed credential, made for loads, reads no task', async () => {
  const projects = await call('GET', '/api/tasks/projects', { token: tokens.seed! });
  assert.deepEqual([projects.status, projects.body.error], [403, 'insufficient_scope']);
});
