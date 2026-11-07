/**
 * Loading rows into an empty store in pages, such as an import from Beads or
 * a backup (tools/migrate's load command, docs/api.md). The owner begins a
 * load; each page of one table's rows waits in store_load_pages
 * (migrations/0006_store_loads.sql); the commit inserts every waiting row in
 * one transaction and removes the load. So a load lands whole or not at all,
 * the store never shows part of one, and each request stays small.
 */
import { BACKUP_TABLES, backupColumns, isBackupTable, type BackupTable } from '@ntasks/domain';
import type { Meter } from './sqlite.ts';

/** The most rows one page holds. A page's request body holds at most 1 MB (docs/api.md). */
export const LOAD_PAGE_ROWS = 500;

export type LoadAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: 400 | 409 | 500; readonly error: string; readonly detail: string };

function refused(status: 400 | 409 | 500, error: string, detail: string): LoadAnswer<never> {
  return { ok: false, status, error, detail };
}

function invalid(detail: string): LoadAnswer<never> {
  return refused(400, 'invalid_request', detail);
}

/** A refusal found inside the commit's transaction, which rolls it back. */
class LoadRefused extends Error {
  constructor(readonly answer: LoadAnswer<never>) {
    super('load refused');
  }
}

function migrationsOf(storage: DurableObjectStorage): string[] {
  return storage.sql
    .exec<{ name: string }>('SELECT name FROM store_migrations ORDER BY name')
    .toArray()
    .map((row) => row.name);
}

/** The first table that holds a row, or null when the store is empty. */
function tableWithRows(storage: DurableObjectStorage): BackupTable | null {
  for (const table of BACKUP_TABLES) {
    const [row] = storage.sql.exec<{ held: number }>(`SELECT EXISTS (SELECT 1 FROM ${table}) AS held`).toArray();
    if (Number(row?.held) === 1) return table;
  }
  return null;
}

function notEmpty(table: BackupTable): LoadAnswer<never> {
  return refused(
    409,
    'store_not_empty',
    `the store already holds rows in ${table}; a load goes only into an empty store`,
  );
}

/** Whether `load` names the load that is waiting. */
function waiting(storage: DurableObjectStorage, load: unknown): load is string {
  if (typeof load !== 'string' || load.length === 0 || load.length > 64) return false;
  return storage.sql.exec('SELECT 1 FROM store_loads WHERE id = ?', load).toArray().length === 1;
}

function noSuchLoad(): LoadAnswer<never> {
  return refused(409, 'no_such_load', 'no load with this id is waiting; begin a load first');
}

function removeLoad(storage: DurableObjectStorage, load: string): void {
  storage.sql.exec('DELETE FROM store_load_pages WHERE load_id = ?', load);
  storage.sql.exec('DELETE FROM store_loads WHERE id = ?', load);
}

/**
 * Begins a load into this store, which must be empty and have exactly the
 * migrations the rows were made with. A load that was waiting is dropped,
 * with its pages: one load waits at a time.
 */
export function beginLoad(
  storage: DurableObjectStorage,
  migrations: unknown,
  by: string,
  now: () => string,
): LoadAnswer<{ readonly load: string }> {
  if (!Array.isArray(migrations) || !migrations.every((name) => typeof name === 'string'))
    return invalid('migrations must list the names of the store migrations the rows were made with');
  const held = migrationsOf(storage);
  if (held.join() !== migrations.join()) {
    return refused(
      409,
      'schema_mismatch',
      `the rows were made with the migrations ${migrations.join(', ')}, and this store has ${held.join(', ')}; ` +
        'load them with the version of Ntasks the store runs',
    );
  }
  const table = tableWithRows(storage);
  if (table !== null) return notEmpty(table);
  const load = crypto.randomUUID();
  storage.transactionSync(() => {
    for (const { id } of storage.sql.exec<{ id: string }>('SELECT id FROM store_loads').toArray())
      removeLoad(storage, id);
    storage.sql.exec(
      'INSERT INTO store_loads (id, started_at, started_by) VALUES (?, ?, ?)',
      load,
      now(),
      by.slice(0, 255),
    );
  });
  return { ok: true, value: { load } };
}

/** Adds one page of one table's rows to the waiting load. Each row holds exactly the table's columns. */
export function stageRows(
  storage: DurableObjectStorage,
  load: unknown,
  table: unknown,
  rows: unknown,
): LoadAnswer<{ readonly table: BackupTable; readonly page: number; readonly rows: number }> {
  if (!isBackupTable(table)) return invalid(`table must be one of ${BACKUP_TABLES.join(', ')}`);
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > LOAD_PAGE_ROWS)
    return invalid(`rows must list 1 to ${LOAD_PAGE_ROWS} rows`);
  const columns = backupColumns(table);
  for (const [index, row] of rows.entries()) {
    if (row === null || typeof row !== 'object' || Array.isArray(row))
      return invalid(`rows[${index}] must be an object`);
    const keys = Object.keys(row as object);
    if (keys.length !== columns.length || !columns.every((column) => Object.hasOwn(row, column)))
      return invalid(`rows[${index}] must hold exactly the columns of ${table}: ${columns.join(', ')}`);
    for (const column of columns) {
      const value: unknown = (row as Record<string, unknown>)[column];
      if (!(value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))))
        return invalid(`rows[${index}].${column} must be text, a number or null`);
    }
  }
  if (!waiting(storage, load)) return noSuchLoad();
  const [last] = storage.sql
    .exec<{ page: number }>('SELECT COALESCE(MAX(page), 0) AS page FROM store_load_pages WHERE load_id = ?', load)
    .toArray();
  const page = Number(last?.page) + 1;
  storage.sql.exec(
    'INSERT INTO store_load_pages (load_id, page, table_name, rows) VALUES (?, ?, ?, ?)',
    load,
    page,
    table,
    JSON.stringify(rows),
  );
  return { ok: true, value: { table, page, rows: rows.length } };
}

/**
 * Inserts every row of the waiting load, in one transaction, and removes the
 * load. `counts` gives the rows of each table the sender sent, so a page
 * that never arrived is found before anything is written. The store must
 * still be empty, and every row must keep the schema's rules; otherwise
 * nothing is written and the load keeps waiting, to be committed again or
 * aborted.
 */
export function commitLoad(
  storage: DurableObjectStorage,
  load: unknown,
  counts: unknown,
  meter?: Meter,
): LoadAnswer<{ readonly rows: number; readonly rowsWritten: number }> {
  if (counts === null || typeof counts !== 'object' || Array.isArray(counts))
    return invalid('counts must give the rows sent for each table');
  for (const [table, count] of Object.entries(counts)) {
    if (!isBackupTable(table)) return invalid(`counts names ${table}, which is not a table a load writes`);
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
      return invalid(`counts.${table} must be a whole number`);
  }
  if (!waiting(storage, load)) return noSuchLoad();
  const staged = new Map(
    storage.sql
      .exec<{ table_name: string; rows: number }>(
        'SELECT table_name, SUM(json_array_length(rows)) AS rows FROM store_load_pages WHERE load_id = ? GROUP BY table_name',
        load,
      )
      .toArray()
      .map((row) => [row.table_name, Number(row.rows)]),
  );
  const sent = counts as Record<string, number>;
  for (const table of BACKUP_TABLES) {
    const expected = sent[table] ?? 0;
    const arrived = staged.get(table) ?? 0;
    if (arrived !== expected) {
      return refused(
        409,
        'counts_differ',
        `the load holds ${arrived} rows of ${table}, not ${expected}; send the missing pages, or abort the load and begin again`,
      );
    }
  }
  try {
    return storage.transactionSync(() => {
      const table = tableWithRows(storage);
      if (table !== null) throw new LoadRefused(notEmpty(table));
      // Checked when the transaction ends: rows arrive table by table, and a backup lists tasks by id.
      storage.sql.exec('PRAGMA defer_foreign_keys = ON');
      let rows = 0;
      let written = 0;
      for (const name of BACKUP_TABLES) {
        const columns = backupColumns(name);
        const cursor = storage.sql.exec(
          `INSERT INTO ${name} (${columns.join(', ')})
           SELECT ${columns.map((column) => `json_extract(r.value, '$.${column}')`).join(', ')}
           FROM store_load_pages p, json_each(p.rows) r
           WHERE p.load_id = ? AND p.table_name = ?
           ORDER BY p.page, r.key`,
          load,
          name,
        );
        cursor.toArray();
        rows += staged.get(name) ?? 0;
        written += cursor.rowsWritten;
      }
      removeLoad(storage, load);
      if (meter) {
        meter.statements += BACKUP_TABLES.length;
        meter.rowsWritten += written;
      }
      return { ok: true, value: { rows, rowsWritten: written } } as const;
    });
  } catch (error) {
    if (error instanceof LoadRefused) return error.answer;
    const message = error instanceof Error ? error.message : String(error);
    if (brokenRule(message))
      return refused(409, 'load_refused', `a row breaks a rule of the store, so nothing was written: ${message}`);
    return refused(500, 'load_failed', `the store could not write the load, so nothing was written: ${message}`);
  }
}

/**
 * Whether SQLite refused a row for breaking one of the schema's rules: a
 * constraint, a column's type in a STRICT table, or one of the store's
 * triggers. Any other failure is the store's, not the rows'.
 */
function brokenRule(message: string): boolean {
  return /constraint failed|SQLITE_CONSTRAINT|cannot store \S+ value in \S+ column|\bntasks(?: refused)?: /u.test(
    message,
  );
}

/** Drops the waiting load and its pages, writing nothing else. */
export function abortLoad(storage: DurableObjectStorage, load: unknown): LoadAnswer<{ readonly aborted: true }> {
  if (!waiting(storage, load)) return noSuchLoad();
  storage.transactionSync(() => removeLoad(storage, load));
  return { ok: true, value: { aborted: true } };
}
