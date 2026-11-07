/**
 * A backup of the task store: every row of every table that holds tasks,
 * and the retry records, exactly as stored. The store hands a backup out
 * page by page (GET /api/backup, docs/api.md); a client puts the pages
 * together into one backup file, which loads into an empty store with the
 * statements an import uses.
 */
import {
  insertStatements,
  STORE_COLUMNS,
  STORE_TABLES,
  storeKey,
  type StoreRows,
  type StoreStatement,
  type StoreTable,
  type StoreValue,
} from './store-rows.ts';

export const BACKUP_FORMAT = 'ntasks-backup-v1';

/** A retry record: the answer a write with an idempotency key gave, which the store keeps seven days. */
export interface ReceiptRow {
  readonly principal: string;
  readonly operation: string;
  readonly idempotency_key: string;
  readonly project_id: string;
  readonly request_hash: string;
  /** JSON text. */
  readonly result: string;
  readonly created_at: string;
}

const RECEIPT_COLUMNS: readonly (keyof ReceiptRow & string)[] = Object.freeze([
  'principal',
  'operation',
  'idempotency_key',
  'project_id',
  'request_hash',
  'result',
  'created_at',
]);
const RECEIPT_KEY: readonly string[] = Object.freeze(['principal', 'operation', 'idempotency_key']);

/** Every table a backup holds, in an order their foreign keys accept. */
export const BACKUP_TABLES = Object.freeze([...STORE_TABLES, 'write_receipts'] as const);
export type BackupTable = StoreTable | 'write_receipts';

/** The rows an import or a restore loads. An import from Beads has no retry records. */
export interface BackupRows extends StoreRows {
  readonly write_receipts?: readonly ReceiptRow[];
}

/** One row as the store holds it: each column's value. */
export type BackupRow = Readonly<Record<string, StoreValue>>;

/** One page of an export, as GET /api/backup answers it. */
export interface BackupPage {
  readonly format: typeof BACKUP_FORMAT;
  /** When the export's first page was read. Every page holds the store as it stood then. */
  readonly takenAt: string;
  /** The store's schema migrations. A backup loads only into a store with exactly these. */
  readonly migrations: readonly string[];
  /** The table these rows are from, in key order. */
  readonly table: BackupTable;
  readonly rows: readonly BackupRow[];
  /** The token that asks for the next page; null after the last. */
  readonly next: string | null;
}

/** A whole export in one file: every table's rows, in key order. */
export interface BackupFile {
  readonly format: typeof BACKUP_FORMAT;
  readonly takenAt: string;
  readonly migrations: readonly string[];
  readonly tables: { readonly [T in BackupTable]: readonly BackupRow[] };
}

export function isBackupTable(value: unknown): value is BackupTable {
  return typeof value === 'string' && (BACKUP_TABLES as readonly string[]).includes(value);
}

/** A table's columns, in the order a backup's statements name them. */
export function backupColumns(table: BackupTable): readonly string[] {
  return table === 'write_receipts' ? RECEIPT_COLUMNS : (STORE_COLUMNS[table] as readonly string[]);
}

/** A table's primary key columns, which a backup orders and pages the table by. */
export function backupKey(table: BackupTable): readonly string[] {
  return table === 'write_receipts' ? RECEIPT_KEY : storeKey(table);
}

/** Every row of a table, in key order. */
export function backupSelectSql(table: BackupTable): string {
  return `SELECT ${backupColumns(table).join(', ')} FROM ${table} ORDER BY ${backupKey(table).join(', ')}`;
}

/** Where a page of a table starts: at its first row, after a key, or at a key. */
export type BackupStart = 'first' | 'after' | 'at';

/**
 * One page of a table, in key order: rows after the key bound first, or at
 * it or after, or from the table's first row, then at most as many rows as
 * the next bound value, past as many as the last. The key's columns compare
 * as one row value, so a page can start right after the last row of the page
 * before, and read no row twice.
 */
export function backupPageSql(table: BackupTable, start: BackupStart): string {
  const key = backupKey(table);
  const bound = `(${key.join(', ')}) ${start === 'after' ? '>' : '>='} (${key.map(() => '?').join(', ')})`;
  const where = start === 'first' ? '' : ` WHERE ${bound}`;
  return `SELECT ${backupColumns(table).join(', ')} FROM ${table}${where} ORDER BY ${key.join(', ')} LIMIT ? OFFSET ?`;
}

/** One INSERT per row, as insertStatements writes the tables that hold tasks, then one per retry record. */
export function loadStatements(rows: BackupRows): StoreStatement[] {
  const sql = `INSERT INTO write_receipts (${RECEIPT_COLUMNS.join(', ')}) VALUES (${RECEIPT_COLUMNS.map(() => '?').join(', ')})`;
  return [
    ...insertStatements(rows),
    ...(rows.write_receipts ?? []).map((row) => ({ sql, values: RECEIPT_COLUMNS.map((column) => row[column]) })),
  ];
}

/** Why the pages of an export do not make one backup. */
export class BackupRefused extends Error {
  override name = 'BackupRefused';
}

function isRow(value: unknown): value is BackupRow {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => item === null || typeof item === 'string' || typeof item === 'number')
  );
}

/**
 * Puts an export's pages together, from the first page to the last.
 * `page(null)` reads the first page and `page(token)` the one a token names.
 * Each page must be from the same export as the first, or the backup is
 * refused.
 */
export async function collectBackup(
  page: (token: string | null) => Promise<unknown>,
): Promise<{ readonly file: BackupFile; readonly pages: number }> {
  const tables = Object.fromEntries(BACKUP_TABLES.map((table) => [table, [] as BackupRow[]])) as Record<
    BackupTable,
    BackupRow[]
  >;
  let pages = 0;
  const read = async (token: string | null): Promise<BackupPage> => {
    const answer = (await page(token)) as Partial<BackupPage> | null;
    pages += 1;
    if (
      answer?.format !== BACKUP_FORMAT ||
      typeof answer.takenAt !== 'string' ||
      !Array.isArray(answer.migrations) ||
      !answer.migrations.every((name) => typeof name === 'string') ||
      !Array.isArray(answer.rows) ||
      !answer.rows.every(isRow) ||
      !(answer.next === null || typeof answer.next === 'string')
    )
      throw new BackupRefused(`Page ${pages} is not a page of an Ntasks backup.`);
    if (!isBackupTable(answer.table)) throw new BackupRefused(`Page ${pages} holds a table this tool does not know.`);
    return answer as BackupPage;
  };
  const first = await read(null);
  for (let current = first; ; current = await read(current.next)) {
    if (current.takenAt !== first.takenAt || current.migrations.join() !== first.migrations.join())
      throw new BackupRefused(`Page ${pages} is from another export than the first.`);
    const rows = tables[current.table];
    for (const row of current.rows) rows.push(row);
    if (current.next === null) break;
  }
  return {
    file: { format: BACKUP_FORMAT, takenAt: first.takenAt, migrations: [...first.migrations], tables },
    pages,
  };
}
