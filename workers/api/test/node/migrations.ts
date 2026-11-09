// Run by `node --test`, not Vitest. The Vitest suite's task store applies
// every migration to an empty database, so it never shows what a migration
// does to a store that already holds tasks, as a deployed store does when a
// new migration ships. This file applies the task store's migration files in
// order to a SQLite database in memory, writing rows between them, with
// foreign keys enforced as the Durable Object enforces them. A migration that
// rebuilds a table or changes rows a store holds adds its own case here.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const FOLDER = new URL('../../src/store/migrations/', import.meta.url);
const FILES = readdirSync(FOLDER)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const AT = '2026-11-06T12:00:00.000Z';
const LATER = '2026-11-06T12:05:00.000Z';

/** Applies these migration files in order, each in one transaction, as the store does (src/store/schema.ts). */
function migrated(db: DatabaseSync, files: readonly string[]): void {
  for (const file of files) {
    db.exec('BEGIN');
    db.exec(readFileSync(new URL(file, FOLDER), 'utf8'));
    db.exec('COMMIT');
  }
}

type Row = Record<string, string | number | null>;

function insert(db: DatabaseSync, table: string, row: Row): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
    ...Object.values(row),
  );
}

/** A row in each table of the first migration that holds a workspace's tasks, as a deployed store holds them. */
function heldRows(db: DatabaseSync): void {
  insert(db, 'projects', { id: 'p1', key: 'web.example.com', name: 'Web', prefix: 'web', created_at: AT });
  const task = (id: string, fields: Row = {}) =>
    insert(db, 'tasks', {
      id,
      project_id: 'p1',
      type: 'task',
      status: 'open',
      priority: 2,
      title: `Task ${id}`,
      created_at: AT,
      updated_at: AT,
      ...fields,
    });
  task('web-a1', { type: 'epic' });
  task('web-a1.1', { parent_id: 'web-a1', status: 'in_progress', assignee: 'agent-a' });
  task('web-b2', { status: 'closed', resolution: 'done', closed_at: LATER, closed_by: 'agent-a' });
  insert(db, 'task_labels', { task_id: 'web-a1.1', label: 'backend' });
  insert(db, 'task_edges', { task_id: 'web-a1.1', depends_on_id: 'web-b2', type: 'blocks', created_at: AT });
  insert(db, 'task_external_links', {
    task_id: 'web-b2',
    url: 'https://example.com/pull/1',
    title: 'The change',
    created_at: AT,
  });
  insert(db, 'custom_fields', { project_id: 'p1', key: 'area', name: 'Area', type: 'text', created_at: AT });
  insert(db, 'task_comments', { id: 'c1', task_id: 'web-a1.1', author: 'agent-a', text: 'Started.', created_at: AT });
  insert(db, 'task_events', {
    task_id: 'web-a1.1',
    project_id: 'p1',
    version: 1,
    kind: 'created',
    actor: 'agent-a',
    at: AT,
    changes: '{"title":"Task web-a1.1"}',
  });
  insert(db, 'write_receipts', {
    principal: 'agent-a',
    operation: 'create_task',
    idempotency_key: 'key-0001',
    project_id: 'p1',
    request_hash: '0'.repeat(64),
    result: '{}',
    created_at: AT,
  });
}

/** How many rows each table holds. */
function rowCounts(db: DatabaseSync): Record<string, number> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name));
  return Object.fromEntries(
    tables.map((table) => [table, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n)]),
  );
}

test('every later migration applies to a store that holds rows, and keeps them', () => {
  assert.ok(FILES.length >= 1, 'the task store has a first migration');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrated(db, FILES.slice(0, 1));
  heldRows(db);
  const before = rowCounts(db);

  migrated(db, FILES.slice(1));

  const after = rowCounts(db);
  for (const [table, rows] of Object.entries(before)) assert.equal(after[table], rows, `${table} keeps its rows`);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('a store that holds tasks and approvals takes steps only on a gate', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const index = FILES.indexOf('0003_gate_steps.sql');
  assert.ok(index > 0, 'the steps migration is among the files');
  migrated(db, FILES.slice(0, index));
  heldRows(db);
  insert(db, 'tasks', {
    id: 'web-g1',
    project_id: 'p1',
    type: 'gate',
    await_type: 'human',
    status: 'open',
    priority: 2,
    title: 'Approve the deploy',
    created_at: AT,
    updated_at: AT,
  });

  migrated(db, FILES.slice(index));

  const steps = db.prepare('SELECT id, steps FROM tasks ORDER BY id').all();
  assert.ok(steps.length > 0 && steps.every((row) => row.steps === null), 'every task it held has no steps');
  const asked = JSON.stringify([{ text: 'Run it.', command: null, done: null, note: null, stuck: null }]);
  const set = (id: string, value: string) =>
    db.prepare('UPDATE tasks SET steps = ?, version = version + 1 WHERE id = ?').run(value, id);
  set('web-g1', asked);
  assert.throws(() => set('web-b2', asked), /CHECK constraint/u);
  assert.throws(() => set('web-g1', '[]'), /CHECK constraint/u);
  db.close();
});

test('a store that holds tasks takes an acceptance only on a task closed as done without a link', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const index = FILES.indexOf('0004_close_acceptance.sql');
  assert.ok(index > 0, 'the acceptance migration is among the files');
  migrated(db, FILES.slice(0, index));
  heldRows(db);
  insert(db, 'tasks', {
    id: 'web-c3',
    project_id: 'p1',
    type: 'task',
    status: 'closed',
    priority: 2,
    title: 'Publish the runbook',
    created_at: AT,
    updated_at: AT,
    closed_at: LATER,
    resolution: 'done',
    close_link: 'https://docs.example.com/runbook',
  });

  migrated(db, FILES.slice(index));

  const rows = db.prepare('SELECT id, close_acceptance FROM tasks ORDER BY id').all();
  assert.ok(rows.length > 0 && rows.every((row) => row.close_acceptance === null), 'no task it held is accepted');
  const accepted = JSON.stringify({ by: 'owner', criteria: [{ text: 'Merged.', met: false }] });
  const set = (id: string, value: string) =>
    db.prepare('UPDATE tasks SET close_acceptance = ?, version = version + 1 WHERE id = ?').run(value, id);
  set('web-b2', accepted);
  assert.throws(() => set('web-a1.1', accepted), /CHECK constraint/u, 'an open task');
  assert.throws(() => set('web-c3', accepted), /CHECK constraint/u, 'a close with a link');
  assert.throws(() => set('web-b2', '{"by":"owner"}'), /CHECK constraint/u, 'no criteria');
  db.close();
});
