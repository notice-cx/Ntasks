// Run by `node --test`, not Vitest. The Vitest suite's task store applies
// every migration to an empty database, so it never shows what a migration
// does to a store that already holds tasks, as a deployed store does when a
// new migration ships. This file applies the task store's migration files in
// order to a SQLite database in memory, writing rows between them, with
// foreign keys enforced as the Durable Object enforces them.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const FOLDER = new URL('../../src/store/migrations/', import.meta.url);
const FILES = readdirSync(FOLDER)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const AT = '2026-11-06T12:00:00.000Z';

/** Applies these migration files in order, each in one transaction, as the store does (src/store/schema.ts). */
function migrated(db: DatabaseSync, files: readonly string[]): void {
  for (const file of files) {
    db.exec('BEGIN');
    db.exec(readFileSync(new URL(file, FOLDER), 'utf8'));
    db.exec('COMMIT');
  }
}

function edges(db: DatabaseSync) {
  return db.prepare('SELECT * FROM task_edges ORDER BY task_id, depends_on_id').all();
}

test('0004 keeps every link a store holds, with its index, and takes the new link types', () => {
  const next = FILES.indexOf('0004_link_types_external_links.sql');
  assert.ok(next > 0, 'the migration that adds duplicates and supersedes is in the folder');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrated(db, FILES.slice(0, next));

  db.prepare('INSERT INTO projects (id, key, name, prefix, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'p1',
    'web.example.com',
    'Web',
    'web',
    AT,
  );
  const task = db.prepare(
    `INSERT INTO tasks (id, project_id, type, status, priority, title, created_at, updated_at)
     VALUES (?, 'p1', 'task', 'open', 2, ?, ?, ?)`,
  );
  for (const id of ['web-a1', 'web-b2', 'web-c3', 'web-d4']) task.run(id, `Task ${id}`, AT, AT);
  const edge = db.prepare(
    'INSERT INTO task_edges (task_id, depends_on_id, type, created_at, created_by) VALUES (?, ?, ?, ?, ?)',
  );
  edge.run('web-b2', 'web-a1', 'blocks', AT, 'agent-a');
  edge.run('web-c3', 'web-a1', 'related', AT, null);
  edge.run('web-d4', 'web-a1', 'discovered-from', AT, 'agent-b');
  edge.run('web-c3', 'web-b2', 'blocks', AT, null);
  const before = edges(db);

  migrated(db, FILES.slice(next, next + 1));

  assert.deepEqual(edges(db), before);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_edges'")
    .all()
    .map((row) => row.name);
  assert.deepEqual(indexes, ['task_edges_by_dependency']);
  edge.run('web-d4', 'web-b2', 'duplicates', AT, null);
  edge.run('web-d4', 'web-c3', 'supersedes', AT, null);
  assert.throws(() => edge.run('web-a1', 'web-d4', 'waits-for', AT, null), /CHECK constraint failed/u);
  assert.throws(() => edge.run('web-a1', 'web-none', 'related', AT, null), /FOREIGN KEY constraint failed/u);
  assert.throws(() => edge.run('web-a1', 'web-a1', 'related', AT, null), /CHECK constraint failed/u);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  // Every later migration applies on top of it.
  migrated(db, FILES.slice(next + 1));
  db.close();
});
