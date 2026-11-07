// The backup export: every row of every table, page by page through the
// task store's route, loads into an empty store as the same rows; a page
// refuses once the store has changed; only the backup scope reads it.
import {
  BACKUP_TABLES,
  backupKey,
  collectBackup,
  type BackupPage,
  type BackupRows,
  type BackupTable,
  type TaskRow,
} from '@ntasks/domain';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { SCOPES, type Principal } from '../src/auth.ts';
import { readBackupPage } from '../src/store/backup.ts';
import type { TaskStore } from '../src/store/index.ts';
import { MIGRATIONS } from '../src/store/schema.ts';
import { AGENT } from './engine/helpers.ts';

const ORIGIN = 'https://ntasks.test';
const ACME = 'a1111111-0000-4000-8000-00000000000a';
const BETA = 'b2222222-0000-4000-8000-00000000000b';
const AT = '2026-03-02T09:00:00.000Z';
const LATER = '2026-03-02T10:00:00.000Z';

const OWNER: Principal = Object.freeze({
  id: 'person:owner',
  name: 'owner',
  scopes: [SCOPES.read, SCOPES.write, SCOPES.backup],
  projects: 'all',
});
/** A backup credential granted no project. */
const BACKUP_ONLY: Principal = Object.freeze({
  id: 'service:backup',
  name: 'service:backup',
  scopes: [SCOPES.backup],
  projects: new Map(),
});
const WRITER: Principal = Object.freeze({
  id: 'service:writer',
  name: 'service:writer',
  scopes: [SCOPES.read, SCOPES.write],
  projects: 'all',
});

/** A store no other test touches. */
function freshStore(): DurableObjectStub<TaskStore> {
  return env.TASK_STORE.getByName(`backup-${crypto.randomUUID()}`);
}

const task = {
  parent_id: null,
  type: 'task',
  await_type: null,
  status: 'open',
  priority: 2,
  description: '',
  acceptance: '',
  assignee: null,
  assignee_model: null,
  defer_until: null,
  due_at: null,
  choices: null,
  choice: null,
  metadata: '{}',
  filed_by: 'agent-a',
  filed_model: 'model-a',
  close_reason: null,
  resolution: null,
  duplicate_of: null,
  closed_by: null,
  closed_model: null,
  version: 1,
  created_at: AT,
  updated_at: AT,
  started_at: null,
  closed_at: null,
} as const;

const TASKS: TaskRow[] = [
  // A child whose parent's id sorts after its own.
  { ...task, id: 'acme-a1', project_id: ACME, parent_id: 'acme-z9', title: 'Child', description: 'Ünïcode, "quotes"' },
  {
    ...task,
    id: 'acme-z9',
    project_id: ACME,
    type: 'epic',
    title: 'Parent',
    notes: 'Notes so far.',
    design: 'How it is built.',
    estimate_minutes: 90,
  },
  // A duplicate of a task whose id sorts after its own.
  {
    ...task,
    id: 'acme-b2',
    project_id: ACME,
    title: 'Filed twice',
    status: 'closed',
    version: 2,
    updated_at: LATER,
    closed_at: LATER,
    close_reason: 'Same as acme-c3.',
    resolution: 'duplicate',
    duplicate_of: 'acme-c3',
    closed_by: 'owner',
  },
  {
    ...task,
    id: 'acme-c3',
    project_id: ACME,
    type: 'decision',
    title: 'Pick one',
    choices: JSON.stringify({ question: 'Which?', options: [{ key: 'a', label: 'A', recommended: true }] }),
    choice: JSON.stringify({ key: 'a', by: 'owner', at: LATER }),
    metadata: JSON.stringify({ noticeos_card: { usd: 100 } }),
  },
  { ...task, id: 'beta-g1', project_id: BETA, type: 'gate', await_type: 'human', title: 'Approve it' },
  {
    ...task,
    id: 'beta-d1',
    project_id: BETA,
    status: 'deferred',
    priority: 0,
    title: 'Later',
    assignee: 'agent-b',
    assignee_model: 'model-b',
    defer_until: '2026-12-01T00:00:00.000Z',
    due_at: '2026-12-31T00:00:00.000Z',
    started_at: LATER,
  },
];

const ROWS: BackupRows = {
  projects: [
    { id: ACME, key: 'acme.example.com', name: 'Acme', prefix: 'acme', created_at: AT },
    { id: BETA, key: 'beta.example.com', name: 'Beta', prefix: 'beta', created_at: AT },
  ],
  tasks: TASKS,
  task_labels: [
    { task_id: 'acme-a1', label: 'backend' },
    { task_id: 'acme-a1', label: 'ünïcode' },
    { task_id: 'beta-g1', label: 'approval' },
  ],
  task_edges: [
    { task_id: 'acme-a1', depends_on_id: 'acme-c3', type: 'blocks', created_at: AT, created_by: 'agent-a' },
    { task_id: 'acme-c3', depends_on_id: 'beta-d1', type: 'related', created_at: AT, created_by: null },
    { task_id: 'beta-d1', depends_on_id: 'beta-g1', type: 'discovered-from', created_at: LATER, created_by: 'owner' },
    { task_id: 'acme-b2', depends_on_id: 'acme-c3', type: 'duplicates', created_at: LATER, created_by: 'owner' },
    { task_id: 'acme-z9', depends_on_id: 'acme-b2', type: 'supersedes', created_at: LATER, created_by: null },
  ],
  task_external_links: [
    {
      task_id: 'acme-a1',
      url: 'https://code.example.com/acme/pull/1',
      title: 'The pull request',
      kind: 'pull-request',
      created_at: AT,
      created_by: 'agent-a',
    },
    {
      task_id: 'beta-d1',
      url: 'https://docs.example.com/plan',
      title: 'The plan',
      kind: null,
      created_at: LATER,
      created_by: null,
    },
  ],
  task_comments: [{ id: 'k-0001', task_id: 'acme-a1', author: 'owner', text: 'Looks right.', created_at: LATER }],
  task_events: [
    ...TASKS.map((row, index) => ({
      seq: index + 1,
      task_id: row.id,
      project_id: row.project_id,
      version: 1,
      kind: 'created',
      actor: 'agent-a',
      model: 'model-a',
      at: AT,
      changes: JSON.stringify({ id: row.id, title: row.title }),
    })),
    {
      seq: 7,
      task_id: 'acme-b2',
      project_id: ACME,
      version: 2,
      kind: 'closed',
      actor: 'owner',
      model: null,
      at: LATER,
      changes: JSON.stringify({ status: 'closed' }),
    },
    {
      seq: 8,
      task_id: 'acme-a1',
      project_id: ACME,
      version: 1,
      kind: 'commented',
      actor: 'owner',
      model: null,
      at: LATER,
      changes: JSON.stringify({ commentId: 'k-0001', text: 'Looks right.' }),
    },
  ],
  write_receipts: [
    {
      principal: 'service:noticeos/agent',
      operation: 'create_task',
      idempotency_key: 'key-00000001',
      project_id: ACME,
      request_hash: 'a'.repeat(64),
      result: JSON.stringify({ taskId: 'acme-a1', created: [] }),
      created_at: AT,
    },
  ],
};

/** A store holding a row of every kind: imported ones, and ones the engine writes. */
async function seededStore(): Promise<DurableObjectStub<TaskStore>> {
  const stub = freshStore();
  await stub.importRows(ROWS);
  await runInDurableObject(stub, async (instance: TaskStore) => {
    const retry = {
      principal: 'service:noticeos/agent',
      operation: 'create_task',
      key: 'key-00000002',
      requestHash: 'b'.repeat(64),
    };
    const { task: filed } = await instance.tasks.createTask(
      ACME,
      {
        title: 'Filed by the engine',
        labels: ['engine'],
        links: [{ taskId: 'acme-z9', type: 'related', direction: 'depends-on' }],
      },
      AGENT,
      retry,
    );
    await instance.tasks.addComment(ACME, filed.id, 'A comment the engine wrote.', AGENT);
    await instance.tasks.writeTask(
      ACME,
      filed.id,
      { expectedVersion: filed.version, close: { reason: 'Done.', resolution: 'done' } },
      AGENT,
    );
  });
  return stub;
}

async function getPage(
  stub: DurableObjectStub<TaskStore>,
  principal: Principal,
  query: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await stub.serve(new Request(`${ORIGIN}/api/backup${query}`), principal);
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

/** The page a token names through the route, or the first when it is null. */
async function routePage(stub: DurableObjectStub<TaskStore>, token: string | null, principal = OWNER) {
  const { status, body } = await getPage(stub, principal, token === null ? '' : `?page=${encodeURIComponent(token)}`);
  if (status !== 200) throw new Error(`page refused: ${status} ${JSON.stringify(body)}`);
  return body;
}

/** Every table's rows, as the store reads them back. */
async function tablesOf(
  stub: DurableObjectStub<TaskStore>,
): Promise<Record<BackupTable, Record<string, SqlStorageValue>[]>> {
  const tables = {} as Record<BackupTable, Record<string, SqlStorageValue>[]>;
  for (const table of BACKUP_TABLES) tables[table] = [...(await stub.tableRows(table))];
  return tables;
}

describe('a backup of the task store', () => {
  it('exports every row of every table, which loads into an empty store as the same rows', async () => {
    const source = await seededStore();
    const { file } = await collectBackup((token) => routePage(source, token));
    const held = await tablesOf(source);
    for (const table of BACKUP_TABLES) {
      expect(held[table].length, table).toBeGreaterThan(0);
      expect(file.tables[table], table).toEqual(held[table]);
    }
    expect(file.migrations).toEqual(MIGRATIONS.map((migration) => migration.name));

    const restored = freshStore();
    await restored.importRows(file.tables as unknown as BackupRows);
    expect(await tablesOf(restored)).toEqual(held);

    // The restored store numbers new history after the last change it holds.
    const lastSeq = Math.max(...held.task_events.map((event) => Number(event.seq)));
    const written = await runInDurableObject(restored, (instance: TaskStore) =>
      instance.tasks.createTask(ACME, { title: 'After the restore' }, AGENT),
    );
    const history = await runInDurableObject(restored, (instance: TaskStore) =>
      instance.tasks.listHistory(ACME, written.task.id, { limit: 1 }),
    );
    expect(history[0]?.seq).toBe(lastSeq + 1);
  });

  it('pages each table in key order, across pages bounded by rows or by bytes', async () => {
    const source = await seededStore();
    const held = await tablesOf(source);
    const total = Object.values(held).reduce((sum, rows) => sum + rows.length, 0);
    const collect = (most: { rows: number; bytes: number }) =>
      collectBackup((token) =>
        runInDurableObject(source, (_instance: TaskStore, state): BackupPage => {
          const answer = readBackupPage(state.storage, 'test-run', token, () => AT, most);
          if (!answer.ok) throw new Error(answer.detail);
          return answer.page;
        }),
      );
    const byRows = await collect({ rows: 2, bytes: 1_000_000 });
    // One row per page, then an empty page that ends each table.
    const byBytes = await collect({ rows: 500, bytes: 1 });
    expect(byBytes.pages).toBe(total + BACKUP_TABLES.length);
    for (const table of BACKUP_TABLES) {
      expect(byRows.file.tables[table], table).toEqual(held[table]);
      expect(byBytes.file.tables[table], table).toEqual(held[table]);
    }
  });

  it('refuses a page once the store has changed since the first, and a new export then reads it whole', async () => {
    const source = await seededStore();
    const first = await routePage(source, null);
    await runInDurableObject(source, (instance: TaskStore) =>
      instance.tasks.createTask(BETA, { title: 'Written during the export' }, AGENT),
    );
    expect(await getPage(source, OWNER, `?page=${String(first.next)}`)).toEqual({
      status: 409,
      body: {
        error: 'store_changed',
        detail:
          'the store changed after this export began, so its pages would not fit together; start again from the first page',
      },
    });
    const { file } = await collectBackup((token) => routePage(source, token));
    expect(file.tables.tasks.map((row) => row.title)).toContain('Written during the export');
  });

  it('refuses a token from another store or another run of it', async () => {
    const first = await routePage(await seededStore(), null);
    const other = await seededStore();
    expect((await getPage(other, OWNER, `?page=${String(first.next)}`)).status).toBe(409);
  });

  it('refuses a page token it did not give, and any other parameter', async () => {
    const source = await seededStore();
    const forged = btoa(JSON.stringify(['run', 0, AT, 'store_migrations', null])).replace(/=+$/u, '');
    for (const query of ['?page=', '?page=not%20a%20token', `?page=${forged}`, '?limit=10']) {
      const { status, body } = await getPage(source, OWNER, query);
      expect([query, status, body.error]).toEqual([query, 400, 'invalid_request']);
    }
  });

  it('answers the owner and a backup credential granted no project, and refuses a sender without the backup scope', async () => {
    const source = await seededStore();
    expect((await getPage(source, OWNER, '')).status).toBe(200);
    expect((await getPage(source, BACKUP_ONLY, '')).status).toBe(200);
    expect(await getPage(source, WRITER, '')).toEqual({
      status: 403,
      body: { error: 'insufficient_scope', detail: 'this route needs tasks:backup' },
    });
  });

  it('pages every table by its primary key', async () => {
    const keys = await runInDurableObject(freshStore(), (_instance: TaskStore, state) =>
      Object.fromEntries(
        BACKUP_TABLES.map((table) => [
          table,
          state.storage.sql
            .exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk`)
            .toArray()
            .map((row) => row.name),
        ]),
      ),
    );
    for (const table of BACKUP_TABLES) expect(keys[table], table).toEqual(backupKey(table));
  });
});
