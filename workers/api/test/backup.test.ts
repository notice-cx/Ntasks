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
import { ACME, AT, BETA, LATER, ROWS, task, TASKS } from './fixtures/every-row.ts';

const ORIGIN = 'https://ntasks.test';
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

/** Every page of a store's backup, read inside the object with these bounds, and the tokens between them. */
async function readPages(stub: DurableObjectStub<TaskStore>, most: { rows: number; bytes: number }) {
  const pages: { table: string; rows: number }[] = [];
  const tokens: string[] = [];
  const { file } = await collectBackup((token) =>
    runInDurableObject(stub, (_instance: TaskStore, state): BackupPage => {
      const answer = readBackupPage(state.storage, 'test-run', token, () => AT, most);
      if (!answer.ok) throw new Error(answer.detail);
      pages.push({ table: answer.page.table, rows: answer.page.rows.length });
      if (answer.page.next !== null) tokens.push(answer.page.next);
      return answer.page;
    }),
  );
  return { file, pages, tokens };
}

/** A three-byte character in UTF-8. */
const WIDE = '你';

/** Rows whose keys are long: keys no limit bounds, and URLs that share their first 1,500 characters. */
function longKeyRows(): BackupRows {
  const project = `p-${'é'.repeat(3000)}`;
  const base = `https://example.com/${WIDE.repeat(1500)}`;
  return {
    projects: [{ id: project, key: 'long.example.com', name: 'Long', prefix: 'long', created_at: AT }],
    tasks: [{ ...task, id: 'long-a1', project_id: project, title: 'Long keys' }],
    task_labels: [{ task_id: 'long-a1', label: WIDE.repeat(255) }],
    task_edges: [],
    task_external_links: [`${base}a`, `${base}b`, `${base}c`, 'https://example.com/short'].map((url) => ({
      task_id: 'long-a1',
      url,
      title: 'A page',
      kind: null,
      created_at: AT,
      created_by: null,
    })),
    task_comments: [1, 2].map((n) => ({
      id: `k-${'é'.repeat(3000)}-${n}`,
      task_id: 'long-a1',
      author: 'owner',
      text: 'A long id.',
      created_at: AT,
    })),
    task_events: [],
  };
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

  it('pages rows whose keys are too long for a token whole, with every token short enough for the route', async () => {
    const stub = freshStore();
    await stub.importRows(longKeyRows());
    const held = await tablesOf(stub);
    for (const rows of [1, 2]) {
      const { file, tokens } = await readPages(stub, { rows, bytes: 10_000_000 });
      for (const table of BACKUP_TABLES) expect(file.tables[table], `${table}, ${rows} a page`).toEqual(held[table]);
      expect(Math.max(...tokens.map((token) => token.length))).toBeLessThanOrEqual(4096);
    }
  });

  it('counts the size of a page in UTF-8 bytes, so text of three-byte characters fills a page sooner', async () => {
    const stub = freshStore();
    // Each description is 1,000 characters and 3,000 bytes, above a 2,500-byte page.
    await stub.importRows({ ...ROWS, tasks: TASKS.map((row) => ({ ...row, description: WIDE.repeat(1000) })) });
    const { pages } = await readPages(stub, { rows: 500, bytes: 2500 });
    const taskPages = pages.filter((page) => page.table === 'tasks' && page.rows > 0);
    expect(taskPages).toEqual(TASKS.map(() => ({ table: 'tasks', rows: 1 })));
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
