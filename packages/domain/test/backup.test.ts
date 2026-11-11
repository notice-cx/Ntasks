import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT,
  BACKUP_TABLES,
  backupKey,
  backupPageSql,
  backupSelectSql,
  collectBackup,
  isBackupTable,
  loadStatements,
  type BackupPage,
} from '../src/index.ts';

const EMPTY = {
  projects: [],
  tasks: [],
  task_labels: [],
  task_edges: [],
  task_comments: [],
  task_events: [],
};

function page(fields: Partial<BackupPage>): BackupPage {
  return {
    format: BACKUP_FORMAT,
    takenAt: '2026-03-02T09:00:00.000Z',
    migrations: ['0001_task_store'],
    table: 'projects',
    rows: [],
    next: null,
    ...fields,
  };
}

describe('backup rows', () => {
  it('holds the tables that hold tasks, then the retry records', () => {
    expect(BACKUP_TABLES.at(-1)).toBe('write_receipts');
    expect(isBackupTable('write_receipts')).toBe(true);
    expect(isBackupTable('store_migrations')).toBe(false);
    expect(backupKey('task_edges')).toEqual(['task_id', 'depends_on_id']);
    expect(backupKey('write_receipts')).toEqual(['principal', 'operation', 'idempotency_key']);
  });

  it('pages a table after or at a key, comparing the whole key as one value', () => {
    expect(backupPageSql('task_labels', 'after')).toBe(
      'SELECT task_id, label FROM task_labels WHERE (task_id, label) > (?, ?) ORDER BY task_id, label LIMIT ? OFFSET ?',
    );
    expect(backupPageSql('task_labels', 'at')).toBe(
      'SELECT task_id, label FROM task_labels WHERE (task_id, label) >= (?, ?) ORDER BY task_id, label LIMIT ? OFFSET ?',
    );
    expect(backupPageSql('task_events', 'first')).toBe(
      'SELECT seq, task_id, project_id, version, kind, actor, model, at, changes, actor_for, session FROM task_events ORDER BY seq LIMIT ? OFFSET ?',
    );
    expect(backupSelectSql('write_receipts')).toBe(
      'SELECT principal, operation, idempotency_key, project_id, request_hash, result, created_at FROM write_receipts ORDER BY principal, operation, idempotency_key',
    );
  });

  it('loads retry records after the tables that hold tasks', () => {
    const receipt = {
      principal: 'service:x',
      operation: 'create_task',
      idempotency_key: 'key-00000001',
      project_id: 'p1',
      request_hash: 'a'.repeat(64),
      result: '{}',
      created_at: '2026-03-02T09:00:00.000Z',
    };
    const statements = loadStatements({
      ...EMPTY,
      projects: [{ id: 'p1', key: 'web.example.com', name: 'Web', prefix: 'web', created_at: receipt.created_at }],
      write_receipts: [receipt],
    });
    expect(statements.map((statement) => statement.sql.split(' (')[0])).toEqual([
      'INSERT INTO projects',
      'INSERT INTO write_receipts',
    ]);
    expect(statements[1]?.values).toEqual(Object.values(receipt));
  });
});

describe('collecting a backup', () => {
  it('puts the pages together in order, table by table', async () => {
    const pages = new Map<string | null, BackupPage>([
      [null, page({ rows: [{ id: 'p1' }], next: 't1' })],
      ['t1', page({ table: 'tasks', rows: [{ id: 'web-a1' }], next: 't2' })],
      ['t2', page({ table: 'tasks', rows: [{ id: 'web-a2' }], next: null })],
    ]);
    const { file, pages: count } = await collectBackup(async (token) => pages.get(token));
    expect(count).toBe(3);
    expect(file.tables.projects).toEqual([{ id: 'p1' }]);
    expect(file.tables.tasks).toEqual([{ id: 'web-a1' }, { id: 'web-a2' }]);
    expect(file.tables.write_receipts).toEqual([]);
    expect(file).toMatchObject({ format: BACKUP_FORMAT, migrations: ['0001_task_store'] });
  });

  it('refuses a page that is not a backup page, a table it does not know, and a page of another export', async () => {
    await expect(collectBackup(async () => ({ error: 'not_found' }))).rejects.toThrow(
      'Page 1 is not a page of an Ntasks backup.',
    );
    await expect(collectBackup(async () => ({ ...page({}), table: 'store_migrations' }))).rejects.toThrow(
      'Page 1 holds a table this tool does not know.',
    );
    await expect(
      collectBackup(async (token) =>
        token === null ? page({ next: 't1' }) : page({ takenAt: '2026-03-03T09:00:00.000Z', next: null }),
      ),
    ).rejects.toThrow('Page 2 is from another export than the first.');
  });
});
