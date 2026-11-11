/**
 * The task store's schema: the files in ./migrations, applied in order when
 * the object starts, each once and each in one transaction. Like the task
 * history, they are append-only: a change to the schema is a new file.
 */
import taskStore from './migrations/0001_task_store.sql';
import tasksByDuplicateOf from './migrations/0002_tasks_by_duplicate_of.sql';
import gateSteps from './migrations/0003_gate_steps.sql';
import closeAcceptance from './migrations/0004_close_acceptance.sql';
import parentContext from './migrations/0005_parent_context.sql';
import mergeOrder from './migrations/0006_merge_order.sql';
import projectSettings from './migrations/0007_project_settings.sql';
import projectIconSvg from './migrations/0008_project_icon_svg.sql';
import changedThroughAndTests from './migrations/0009_changed_through_and_tests.sql';

export const MIGRATIONS: readonly { readonly name: string; readonly sql: string }[] = Object.freeze([
  { name: '0001_task_store', sql: taskStore },
  { name: '0002_tasks_by_duplicate_of', sql: tasksByDuplicateOf },
  { name: '0003_gate_steps', sql: gateSteps },
  { name: '0004_close_acceptance', sql: closeAcceptance },
  { name: '0005_parent_context', sql: parentContext },
  { name: '0006_merge_order', sql: mergeOrder },
  { name: '0007_project_settings', sql: projectSettings },
  { name: '0008_project_icon_svg', sql: projectIconSvg },
  { name: '0009_changed_through_and_tests', sql: changedThroughAndTests },
]);

/** Applies every migration the storage lacks, oldest first. */
export function migrate(storage: DurableObjectStorage, now: () => string = () => new Date().toISOString()): void {
  const { sql } = storage;
  sql.exec('CREATE TABLE IF NOT EXISTS store_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT');
  const applied = new Set(
    sql
      .exec<{ name: string }>('SELECT name FROM store_migrations')
      .toArray()
      .map((row) => row.name),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    storage.transactionSync(() => {
      sql.exec(migration.sql);
      sql.exec('INSERT INTO store_migrations (name, applied_at) VALUES (?, ?)', migration.name, now());
    });
  }
}
