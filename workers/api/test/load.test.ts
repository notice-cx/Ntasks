// Loading an empty store through POST /api/restore, page by page: a backup of
// a store with every kind of row lands as the same rows, in one transaction at
// the commit. A store that holds rows, a sender without the restore scope, a
// page that does not fit its table and a count that does not match are each
// refused, with nothing written.
import {
  BACKUP_TABLES,
  collectBackup,
  LoadRefused,
  sendLoad,
  type BackupFile,
  type BackupTable,
  type LoadPost,
} from '@ntasks/domain';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { SCOPES, type Principal } from '../src/auth.ts';
import type { TaskStore } from '../src/store/index.ts';
import { MIGRATIONS } from '../src/store/schema.ts';
import { AGENT } from './engine/helpers.ts';
import { ACME, ROWS } from './fixtures/every-row.ts';

const ORIGIN = 'https://ntasks.test';
const MIGRATION_NAMES = MIGRATIONS.map((migration) => migration.name);

const OWNER: Principal = Object.freeze({
  id: 'person:owner',
  name: 'owner',
  scopes: [SCOPES.read, SCOPES.write, SCOPES.backup, SCOPES.restore],
  projects: 'all',
});
/** A restore credential granted no project. */
const RESTORE_ONLY: Principal = Object.freeze({
  id: 'service:restore',
  name: 'service:restore',
  scopes: [SCOPES.restore],
  projects: new Map(),
});
const WRITER: Principal = Object.freeze({
  id: 'service:writer',
  name: 'service:writer',
  scopes: [SCOPES.read, SCOPES.write, SCOPES.backup],
  projects: 'all',
});

function freshStore(): DurableObjectStub<TaskStore> {
  return env.TASK_STORE.getByName(`load-${crypto.randomUUID()}`);
}

/** Sends load requests to a store's API as `principal`. */
function poster(stub: DurableObjectStub<TaskStore>, principal: Principal = OWNER): LoadPost {
  return async (path, body) => {
    const response = await stub.serve(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      principal,
    );
    return { status: response.status, body: await response.json() };
  };
}

async function tablesOf(stub: DurableObjectStub<TaskStore>) {
  const tables = {} as Record<BackupTable, Record<string, SqlStorageValue>[]>;
  for (const table of BACKUP_TABLES) tables[table] = [...(await stub.tableRows(table))];
  return tables;
}

/** A backup of a store holding a row of every kind, imported ones and ones the engine wrote. */
async function backupOfEveryRow(): Promise<{ file: BackupFile; source: DurableObjectStub<TaskStore> }> {
  const source = freshStore();
  await source.importRows(ROWS);
  await runInDurableObject(source, async (instance: TaskStore) => {
    const { task } = await instance.tasks.createTask(
      ACME,
      { title: 'Filed by the engine', labels: ['engine'] },
      AGENT,
      {
        principal: 'service:noticeos/agent',
        operation: 'create_task',
        key: 'key-00000009',
        requestHash: 'c'.repeat(64),
      },
    );
    await instance.tasks.addComment(ACME, task.id, 'A comment the engine wrote.', AGENT);
  });
  const { file } = await collectBackup(async (token) => {
    const answer = await source.backupPage(token);
    if (!answer.ok) throw new Error(answer.detail);
    return answer.page;
  });
  return { file, source };
}

async function stagedPages(stub: DurableObjectStub<TaskStore>): Promise<number> {
  return runInDurableObject(stub, (_instance: TaskStore, state) =>
    Number(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM store_load_pages').one().n),
  );
}

describe('a load into an empty store', () => {
  it('lands a backup of a store with every kind of row, page by page, as exactly its rows', async () => {
    const { file, source } = await backupOfEveryRow();
    const held = await tablesOf(source);
    for (const table of BACKUP_TABLES) expect(held[table].length, table).toBeGreaterThan(0);

    const target = freshStore();
    const result = await sendLoad(file.tables, file.migrations, poster(target), { rows: 2, bytes: 100_000 });
    const total = BACKUP_TABLES.reduce((sum, table) => sum + held[table].length, 0);
    expect(result.rows).toBe(total);
    expect(result.rowsWritten).toBeGreaterThanOrEqual(total);
    expect(result.pages).toBeGreaterThan(BACKUP_TABLES.length);
    expect(await tablesOf(target)).toEqual(held);
    expect(await stagedPages(target)).toBe(0);

    // The engine reads the loaded tasks, and numbers new history after the last change loaded.
    const lastSeq = Math.max(...held.task_events.map((event) => Number(event.seq)));
    const written = await runInDurableObject(target, (instance: TaskStore) =>
      instance.tasks.createTask(ACME, { title: 'After the load' }, AGENT),
    );
    const history = await runInDurableObject(target, (instance: TaskStore) =>
      instance.tasks.listHistory(ACME, written.task.id, { limit: 1 }),
    );
    expect(history[0]?.seq).toBe(lastSeq + 1);
  });

  it('refuses a store that holds rows when the load begins, and when it commits', async () => {
    const { file } = await backupOfEveryRow();
    const held = freshStore();
    await held.importRows({
      ...ROWS,
      tasks: [],
      task_labels: [],
      task_edges: [],
      task_external_links: [],
      task_comments: [],
      task_events: [],
      write_receipts: [],
      custom_fields: [],
    });
    await expect(sendLoad(file.tables, file.migrations, poster(held))).rejects.toThrow(
      '/api/restore answered 409 store_not_empty: the store already holds rows in projects; a load goes only into an empty store.',
    );

    // A write between the begin and the commit: the commit writes nothing, and the abort drops the pages.
    const target = freshStore();
    const post = poster(target);
    const begun = await post('/api/restore', { migrations: MIGRATION_NAMES });
    const load = (begun.body as { load: string }).load;
    expect(await post('/api/restore/rows', { load, table: 'projects', rows: file.tables.projects })).toMatchObject({
      status: 200,
    });
    await runInDurableObject(target, (instance: TaskStore) =>
      instance.tasks.createProject({ id: 'p-late', key: 'late.example.com', name: 'Late', prefix: 'late' }),
    );
    expect(await post('/api/restore/commit', { load, counts: { projects: file.tables.projects.length } })).toEqual({
      status: 409,
      body: {
        error: 'store_not_empty',
        detail: 'the store already holds rows in projects; a load goes only into an empty store',
      },
    });
    expect((await tablesOf(target)).projects.map((row) => row.id)).toEqual(['p-late']);
    expect(await stagedPages(target)).toBe(1);
    expect(await post('/api/restore/abort', { load })).toEqual({ status: 200, body: { aborted: true } });
    expect(await stagedPages(target)).toBe(0);
  });

  it('answers the owner and a restore credential granted no project, and refuses a sender without the restore scope', async () => {
    const begin = (principal: Principal) =>
      poster(freshStore(), principal)('/api/restore', { migrations: MIGRATION_NAMES });
    expect((await begin(OWNER)).status).toBe(200);
    expect((await begin(RESTORE_ONLY)).status).toBe(200);
    for (const path of ['/api/restore', '/api/restore/rows', '/api/restore/commit', '/api/restore/abort']) {
      expect(await poster(freshStore(), WRITER)(path, {})).toEqual({
        status: 403,
        body: { error: 'insufficient_scope', detail: 'this route needs tasks:restore' },
      });
    }
  });

  it('refuses rows made with other migrations, and pages that do not fit their table', async () => {
    const target = freshStore();
    const post = poster(target);
    expect(await post('/api/restore', { migrations: MIGRATION_NAMES.slice(0, 1) })).toMatchObject({
      status: 409,
      body: { error: 'schema_mismatch' },
    });
    const load = ((await post('/api/restore', { migrations: MIGRATION_NAMES })).body as { load: string }).load;
    const project = {
      id: 'p1',
      key: 'web.example.com',
      name: 'Web',
      prefix: 'web',
      created_at: '2026-03-02T09:00:00.000Z',
    };
    const pages: [unknown, string][] = [
      [{ load, table: 'store_migrations', rows: [project] }, 'table must be one of'],
      [{ load, table: 'projects', rows: [] }, 'rows must list 1 to 500 rows'],
      [{ load, table: 'projects', rows: Array.from({ length: 501 }, () => project) }, 'rows must list 1 to 500 rows'],
      [
        { load, table: 'projects', rows: [{ ...project, prefix: undefined }] },
        'rows[0] must hold exactly the columns of projects',
      ],
      [
        { load, table: 'projects', rows: [{ ...project, extra: 1 }] },
        'rows[0] must hold exactly the columns of projects',
      ],
      [
        { load, table: 'projects', rows: [{ ...project, name: { text: 'Web' } }] },
        'rows[0].name must be text, a number or null',
      ],
      [{ load, table: 'projects', rows: [project], more: true }, 'unknown field more'],
    ];
    for (const [body, detail] of pages) {
      const answer = await post('/api/restore/rows', body);
      expect([answer.status, (answer.body as { detail: string }).detail]).toEqual([
        400,
        expect.stringContaining(detail),
      ]);
    }
    expect(await post('/api/restore/rows', { load: 'another', table: 'projects', rows: [project] })).toMatchObject({
      status: 409,
      body: { error: 'no_such_load' },
    });
    expect(await stagedPages(target)).toBe(0);
  });

  it('writes nothing when the counts differ or a row breaks a rule of the store', async () => {
    const target = freshStore();
    const post = poster(target);
    const { file } = await backupOfEveryRow();
    const load = ((await post('/api/restore', { migrations: file.migrations })).body as { load: string }).load;
    await post('/api/restore/rows', { load, table: 'projects', rows: file.tables.projects });
    await post('/api/restore/rows', { load, table: 'task_labels', rows: [{ task_id: 'acme-a1', label: '' }] });
    expect(await post('/api/restore/commit', { load, counts: { projects: 1 } })).toMatchObject({
      status: 409,
      body: {
        error: 'counts_differ',
        detail: `the load holds ${file.tables.projects.length} rows of projects, not 1; send the missing pages, or abort the load and begin again`,
      },
    });
    const committed = await post('/api/restore/commit', {
      load,
      counts: { projects: file.tables.projects.length, task_labels: 1 },
    });
    expect(committed).toMatchObject({ status: 409, body: { error: 'load_refused' } });
    for (const [table, rows] of Object.entries(await tablesOf(target))) expect(rows, table).toEqual([]);
    expect(await stagedPages(target)).toBe(2);
  });

  it('reports a failure of the store itself as load_failed, not as a row breaking a rule', async () => {
    const target = freshStore();
    const post = poster(target);
    const load = ((await post('/api/restore', { migrations: MIGRATION_NAMES })).body as { load: string }).load;
    const project = {
      id: 'p1',
      key: 'web.example.com',
      name: 'Web',
      prefix: 'web',
      created_at: '2026-03-02T09:00:00.000Z',
    };
    await post('/api/restore/rows', { load, table: 'projects', rows: [project] });
    // A fault no row causes: a table the commit writes is gone.
    await runInDurableObject(target, (_instance: TaskStore, state) =>
      state.storage.sql.exec('DROP TABLE task_external_links'),
    );
    const committed = await post('/api/restore/commit', { load, counts: { projects: 1 } });
    expect(committed).toMatchObject({ status: 500, body: { error: 'load_failed' } });
    expect((committed.body as { detail: string }).detail).toMatch(
      /^the store could not write the load, so nothing was written: .*no such table/u,
    );
    expect(await stagedPages(target)).toBe(1);
  });

  it('aborts a load that a page refused, so the store keeps none of it', async () => {
    const target = freshStore();
    const { file } = await backupOfEveryRow();
    const broken = { ...file.tables, task_labels: [{ task_id: 'acme-a1', label: '' }] };
    await expect(sendLoad(broken, file.migrations, poster(target))).rejects.toBeInstanceOf(LoadRefused);
    expect(await stagedPages(target)).toBe(0);
    for (const [table, rows] of Object.entries(await tablesOf(target))) expect(rows, table).toEqual([]);
  });
});
