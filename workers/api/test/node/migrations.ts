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

test('a store that holds comments keeps each unpinned, and lets a comment only be unpinned', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const index = FILES.indexOf('0005_parent_context.sql');
  assert.ok(index > 0, 'the pinned comments migration is among the files');
  migrated(db, FILES.slice(0, index));
  heldRows(db);

  migrated(db, FILES.slice(index));

  const held = db.prepare('SELECT id, pinned FROM task_comments').all();
  assert.deepEqual(
    held.map((row) => [row.id, row.pinned]),
    [['c1', 0]],
    'the comment it held is unpinned',
  );
  insert(db, 'task_comments', {
    id: 'c2',
    task_id: 'web-a1',
    author: 'agent-a',
    text: 'Every page shares the header.',
    created_at: LATER,
    pinned: 1,
  });
  const update = (sql: string) => () => db.prepare(`UPDATE task_comments SET ${sql} WHERE id = 'c2'`).run();
  assert.throws(update("text = 'Edited.'"), /comments are never edited/u, 'its text');
  assert.throws(update("author = 'agent-b'"), /comments are never edited/u, 'its author');
  update('pinned = 0')();
  assert.throws(update('pinned = 1'), /comments are never edited/u, 'pinned again');
  assert.throws(() => db.prepare("DELETE FROM task_comments WHERE id = 'c2'").run(), /never deleted/u);
  assert.throws(
    () =>
      insert(db, 'task_comments', { id: 'c3', task_id: 'web-a1', author: 'a', text: 'b', created_at: AT, pinned: 2 }),
    /CHECK constraint/u,
    'a pin is 0 or 1',
  );
  db.close();
});

test('a store that holds history, comments and closes takes helpers, sessions and test runs only where they belong', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const index = FILES.indexOf('0009_changed_through_and_tests.sql');
  assert.ok(index > 0, 'the migration is among the files');
  migrated(db, FILES.slice(0, index));
  heldRows(db);

  migrated(db, FILES.slice(index));

  const events = db.prepare('SELECT actor_for, session FROM task_events').all();
  assert.ok(events.length > 0 && events.every((row) => row.actor_for === null && row.session === null));
  assert.deepEqual(
    db
      .prepare('SELECT id, test FROM task_comments')
      .all()
      .map((row) => [row.id, row.test]),
    [['c1', null]],
    'the comment it held reports no test',
  );
  const run = JSON.stringify({ command: 'pnpm test', result: 'passed' });
  const setClose = (id: string, value: string) =>
    db.prepare('UPDATE tasks SET close_test = ?, version = version + 1 WHERE id = ?').run(value, id);
  setClose('web-b2', run);
  assert.throws(() => setClose('web-a1.1', run), /CHECK constraint/u, 'an open task');
  assert.throws(() => setClose('web-b2', '"passed"'), /CHECK constraint/u, 'not an object');
  insert(db, 'task_comments', {
    id: 'c2',
    task_id: 'web-a1',
    author: 'a',
    text: 'Ran it.',
    created_at: LATER,
    test: run,
  });
  assert.throws(
    () => db.prepare("UPDATE task_comments SET test = NULL WHERE id = 'c2'").run(),
    /comments are never edited/u,
    'its test',
  );
  db.close();
});

test('a store that holds links keeps each one when the links table takes merges-after', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const index = FILES.indexOf('0006_merge_order.sql');
  assert.ok(index > 0, 'the merge order migration is among the files');
  migrated(db, FILES.slice(0, index));
  heldRows(db);
  const links = () =>
    db
      .prepare('SELECT task_id, depends_on_id, type, created_at, created_by FROM task_edges ORDER BY task_id')
      .all()
      .map((row) => ({ ...row }));
  const before = links();

  migrated(db, FILES.slice(index));

  assert.deepEqual(links(), before, 'every link it held, unchanged');
  const link = (task: string, type: string) =>
    insert(db, 'task_edges', { task_id: task, depends_on_id: 'web-a1', type, created_at: LATER });
  link('web-b2', 'merges-after');
  assert.throws(() => link('web-a1.1', 'merges-before'), /CHECK constraint/u, 'a type the model does not have');
  assert.throws(() => link('web-a1', 'related'), /CHECK constraint/u, 'a link onto itself');
  assert.throws(() => link('web-none', 'related'), /FOREIGN KEY/u, 'a task that does not exist');
  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'task_edges_by_dependency'").get(),
    'the index of links by the task they name',
  );
  db.close();
});

test('a store that holds project icons keeps each one when the icons table takes SVG', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const index = FILES.indexOf('0008_project_icon_svg.sql');
  assert.ok(index > 0, 'the SVG icon migration is among the files');
  migrated(db, FILES.slice(0, index));
  heldRows(db);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  db.prepare(
    'INSERT INTO project_icons (project_id, source_url, content_type, bytes, read_at) VALUES (?, ?, ?, ?, ?)',
  ).run('p1', 'https://web.example.com/touch.png', 'image/png', png, AT);
  const icons = () =>
    db
      .prepare('SELECT project_id, source_url, content_type, bytes, read_at FROM project_icons')
      .all()
      .map((row) => ({ ...row, bytes: [...(row.bytes as Uint8Array)] }));
  const before = icons();
  const svg = (type: string) => () =>
    db.prepare('UPDATE project_icons SET content_type = ? WHERE project_id = ?').run(type, 'p1');
  assert.throws(svg('image/svg+xml'), /CHECK constraint/u, 'no SVG before the migration');

  migrated(db, FILES.slice(index));

  assert.deepEqual(icons(), before, 'every icon it held, unchanged');
  svg('image/svg+xml')();
  assert.throws(svg('text/html'), /CHECK constraint/u, 'a type that is not an image');
  assert.throws(
    () =>
      db
        .prepare(
          'INSERT INTO project_icons (project_id, source_url, content_type, bytes, read_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('p-none', 'https://example.com/a.svg', 'image/svg+xml', png, AT),
    /FOREIGN KEY/u,
    'a project that does not exist',
  );
  db.close();
});
