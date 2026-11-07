/**
 * Loading an import or a backup into the task store, and reading its tables
 * back so the load can be verified. tools/migrate builds an import's rows
 * from a Beads hub, and a backup's from the store's own export (backup.ts);
 * the statements are the ones in packages/domain, which tools/migrate also
 * uses to load a local copy of the store.
 */
import { backupSelectSql, isBackupTable, loadStatements, type BackupRows, type BackupTable } from '@ntasks/domain';
import type { Meter } from './sqlite.ts';

export class ImportRefused extends Error {
  override name = 'ImportRefused';
}

export interface ImportResult {
  /** The rows inserted. */
  readonly rows: number;
  /** The rows written as Cloudflare counts them, index entries included. */
  readonly rowsWritten: number;
}

/**
 * Writes every row in one transaction, into a store that holds no projects
 * or tasks, so an import is whole or does not happen. The schema's checks
 * and triggers hold for each row, as for any write. Foreign keys are checked
 * when the transaction ends, so the rows may come in any order: a backup
 * lists tasks by id, and a parent's id can sort after its child's.
 */
export function loadRows(storage: DurableObjectStorage, rows: BackupRows, meter?: Meter): ImportResult {
  return storage.transactionSync(() => {
    storage.sql.exec('PRAGMA defer_foreign_keys = ON');
    const [held] = storage.sql
      .exec<{ n: number }>('SELECT (SELECT COUNT(*) FROM projects) + (SELECT COUNT(*) FROM tasks) AS n')
      .toArray();
    if (Number(held?.n) !== 0) {
      throw new ImportRefused('The store already holds projects or tasks. An import writes only into an empty store.');
    }
    let inserted = 0;
    let written = 0;
    for (const statement of loadStatements(rows)) {
      const cursor = storage.sql.exec(statement.sql, ...statement.values);
      cursor.toArray();
      inserted += 1;
      written += cursor.rowsWritten;
    }
    if (meter) {
      meter.statements += inserted;
      meter.rowsWritten += written;
    }
    return { rows: inserted, rowsWritten: written };
  });
}

/** Every row of one of the tables a backup holds, in key order. */
export function readRows(storage: DurableObjectStorage, table: BackupTable): Record<string, SqlStorageValue>[] {
  // The table name reaches the SQL text, so only a known table is read.
  if (!isBackupTable(table)) throw new ImportRefused(`${String(table)} is not a table of the task store.`);
  return storage.sql.exec<Record<string, SqlStorageValue>>(backupSelectSql(table)).toArray();
}
