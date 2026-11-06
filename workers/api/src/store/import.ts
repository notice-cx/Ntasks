/**
 * Loading an import into the task store, and reading its tables back so the
 * import can be verified. tools/migrate builds the rows from a Beads hub; the
 * statements are the ones in packages/domain/src/store-rows.ts, which
 * tools/migrate also uses to check an import before it reaches a store.
 */
import { insertStatements, isStoreTable, selectAllSql, type StoreRows, type StoreTable } from '@ntasks/domain';
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
 * and triggers hold for each row, as for any write.
 */
export function loadRows(storage: DurableObjectStorage, rows: StoreRows, meter?: Meter): ImportResult {
  return storage.transactionSync(() => {
    const [held] = storage.sql
      .exec<{ n: number }>('SELECT (SELECT COUNT(*) FROM projects) + (SELECT COUNT(*) FROM tasks) AS n')
      .toArray();
    if (Number(held?.n) !== 0) {
      throw new ImportRefused('The store already holds projects or tasks. An import writes only into an empty store.');
    }
    let inserted = 0;
    let written = 0;
    for (const statement of insertStatements(rows)) {
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

/** Every row of one of the tables that hold tasks, in a fixed order. */
export function readRows(storage: DurableObjectStorage, table: StoreTable): Record<string, SqlStorageValue>[] {
  // The table name reaches the SQL text, so only a known table is read.
  if (!isStoreTable(table)) throw new ImportRefused(`${String(table)} is not a table of the task store.`);
  return storage.sql.exec<Record<string, SqlStorageValue>>(selectAllSql(table)).toArray();
}
