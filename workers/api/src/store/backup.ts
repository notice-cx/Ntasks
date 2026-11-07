/**
 * The backup export: every row the task store keeps, page by page, for
 * GET /api/backup (docs/api.md). A page holds one table's rows in key order,
 * and few enough of them that a request stays well inside the free plan's
 * 10 ms of CPU, with a token that asks for the page after it.
 *
 * The pages of one export fit together only while nothing is written in
 * between: a task written after its table was read would be missing, or its
 * history would end past its version. So the first page notes how many rows
 * the store has changed so far, and every later page refuses once that
 * count has moved, so the client starts again.
 */
import {
  BACKUP_FORMAT,
  BACKUP_TABLES,
  backupKey,
  backupPageSql,
  isBackupTable,
  type BackupPage,
  type BackupRow,
  type BackupTable,
  type StoreValue,
} from '@ntasks/domain';

/** The most one page holds: this many rows, or rows holding about this many bytes, whichever comes first. */
export const BACKUP_PAGE = Object.freeze({ rows: 500, bytes: 512 * 1024 });

export type BackupAnswer =
  | { readonly ok: true; readonly page: BackupPage }
  | { readonly ok: false; readonly status: 400 | 409; readonly error: string; readonly detail: string };

/** Where an export stands: what a page token holds. */
interface Position {
  /** The run of the store object that began the export. */
  readonly run: string;
  /** The rows that run had changed when the export began. */
  readonly changes: number;
  readonly takenAt: string;
  readonly table: BackupTable;
  /** The key of the last row read from the table; null before its first. */
  readonly after: readonly StoreValue[] | null;
}

/** The longest page token the route reads: a table's longest key, encoded, fits well within it. */
const TOKEN_CHARS = 4096;

function encode(position: Position): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify([position.run, position.changes, position.takenAt, position.table, position.after]),
  );
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** The position a token names, or null when it is not a token an export gave. */
function decode(token: string): Position | null {
  if (token.length === 0 || token.length > TOKEN_CHARS || !/^[A-Za-z0-9_-]+$/u.test(token)) return null;
  let value: unknown;
  try {
    const binary = atob(token.replace(/-/gu, '+').replace(/_/gu, '/'));
    value = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 5) return null;
  const [run, changes, takenAt, table, after] = value as unknown[];
  if (typeof run !== 'string' || typeof takenAt !== 'string' || !isBackupTable(table)) return null;
  if (typeof changes !== 'number' || !Number.isSafeInteger(changes) || changes < 0) return null;
  const key = backupKey(table);
  const keyValue = (item: unknown) => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item));
  if (after !== null && !(Array.isArray(after) && after.length === key.length && after.every(keyValue))) return null;
  return { run, changes, takenAt, table, after: after as readonly StoreValue[] | null };
}

/**
 * The rows this run of the object has inserted, updated or deleted, as
 * SQLite counts them on its one connection. Every write the store makes
 * moves it, through the engine, an import or any other path.
 */
function changesSoFar(storage: DurableObjectStorage): number {
  const [row] = storage.sql.exec<{ changes: number }>('SELECT total_changes() AS changes').toArray();
  return Number(row?.changes);
}

/** About how many bytes a row takes in JSON: its text, and 8 for each other value. */
function sizeOf(row: BackupRow): number {
  let bytes = 0;
  for (const value of Object.values(row)) bytes += typeof value === 'string' ? value.length : 8;
  return bytes;
}

/**
 * One page of the export the token names, or its first page when the token
 * is null. `run` names this run of the store object: a new run counts its
 * changes from zero, so an export begun by another run starts again.
 */
export function readBackupPage(
  storage: DurableObjectStorage,
  run: string,
  token: string | null,
  now: () => string,
  most: { readonly rows: number; readonly bytes: number } = BACKUP_PAGE,
): BackupAnswer {
  const changes = changesSoFar(storage);
  let position: Position;
  if (token === null) {
    position = { run, changes, takenAt: now(), table: BACKUP_TABLES[0], after: null };
  } else {
    const named = decode(token);
    if (named === null) {
      return {
        ok: false,
        status: 400,
        error: 'invalid_request',
        detail: 'page is not a token this export gave; start again from the first page',
      };
    }
    if (named.run !== run || named.changes !== changes) {
      return {
        ok: false,
        status: 409,
        error: 'store_changed',
        detail:
          'the store changed after this export began, so its pages would not fit together; start again from the first page',
      };
    }
    position = named;
  }
  const migrations = storage.sql
    .exec<{ name: string }>('SELECT name FROM store_migrations ORDER BY name')
    .toArray()
    .map((row) => row.name);
  const { table, after } = position;
  const cursor = storage.sql.exec<BackupRow>(backupPageSql(table, after !== null), ...(after ?? []), most.rows);
  const rows: BackupRow[] = [];
  let bytes = 0;
  let full = false;
  for (const row of cursor) {
    rows.push(row);
    bytes += sizeOf(row);
    if (rows.length >= most.rows || bytes >= most.bytes) {
      full = true;
      break;
    }
  }
  const last = rows.at(-1);
  const following = BACKUP_TABLES[BACKUP_TABLES.indexOf(table) + 1];
  const next: Position | null =
    full && last !== undefined
      ? { ...position, after: backupKey(table).map((column) => last[column] ?? null) }
      : following === undefined
        ? null
        : { ...position, table: following, after: null };
  const page: BackupPage = {
    format: BACKUP_FORMAT,
    takenAt: position.takenAt,
    migrations,
    table,
    rows,
    next: next === null ? null : encode(next),
  };
  return { ok: true, page };
}
