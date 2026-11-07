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
  /** Null before the table's first row. Otherwise the key of the last row read, when `skip` is 0, and the next
   * page starts after it; or that key with each text cut short, when `skip` counts the rows read from there on. */
  readonly after: readonly StoreValue[] | null;
  readonly skip: number;
}

/**
 * The most characters of each key text a token holds. Some keys have no
 * limit, such as a project's id, and an external link's URL may be 2,048
 * characters, each up to 4 bytes. A character is at most 6 bytes in JSON, and
 * a key has at most 3 texts, so a token stays under TOKEN_CHARS.
 */
const KEY_CHARS = 128;

/** The longest page token the route reads. */
const TOKEN_CHARS = 4096;

const UTF8 = new TextEncoder();

function encode(position: Position): string {
  const bytes = UTF8.encode(
    JSON.stringify([position.run, position.changes, position.takenAt, position.table, position.after, position.skip]),
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
  if (!Array.isArray(value) || value.length !== 6) return null;
  const [run, changes, takenAt, table, after, skip] = value as unknown[];
  if (typeof run !== 'string' || typeof takenAt !== 'string' || !isBackupTable(table)) return null;
  const count = (item: unknown) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0;
  if (!count(changes) || !count(skip)) return null;
  const key = backupKey(table);
  const keyValue = (item: unknown) => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item));
  if (after === null ? skip !== 0 : !(Array.isArray(after) && after.length === key.length && after.every(keyValue)))
    return null;
  return {
    run,
    changes: changes as number,
    takenAt,
    table,
    after: after as readonly StoreValue[] | null,
    skip: skip as number,
  };
}

/** The first KEY_CHARS characters of a text, cut between characters, never inside one. */
function cut(text: string): string {
  if (text.length <= KEY_CHARS) return text;
  return Array.from(text).slice(0, KEY_CHARS).join('');
}

/**
 * Where the page after `last` starts. A key short enough goes in the token
 * whole. Otherwise its texts are cut short: a cut text is a byte prefix of
 * the text, so in SQLite it sorts at or before it, and the cut key at or
 * before the row. The rows from the cut key to the row were all read, since
 * nothing was written in between, so the next page skips that many.
 */
function positionAfter(storage: DurableObjectStorage, position: Position, last: BackupRow): Position {
  const columns = backupKey(position.table);
  const key = columns.map((column) => last[column] ?? null);
  const short = key.map((value) => (typeof value === 'string' ? cut(value) : value));
  if (short.every((value, index) => value === key[index])) return { ...position, after: key, skip: 0 };
  const row = `(${columns.join(', ')})`;
  const values = `(${columns.map(() => '?').join(', ')})`;
  const [read] = storage.sql
    .exec<{ rows: number }>(
      `SELECT COUNT(*) AS rows FROM ${position.table} WHERE ${row} >= ${values} AND ${row} <= ${values}`,
      ...short,
      ...key,
    )
    .toArray();
  return { ...position, after: short, skip: Number(read?.rows) };
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

/** About how many bytes a row takes in JSON: its text in UTF-8, and 8 for each other value. */
function sizeOf(row: BackupRow): number {
  let bytes = 0;
  for (const value of Object.values(row)) bytes += typeof value === 'string' ? UTF8.encode(value).byteLength : 8;
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
    position = { run, changes, takenAt: now(), table: BACKUP_TABLES[0], after: null, skip: 0 };
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
  const { table, after, skip } = position;
  const start = after === null ? 'first' : skip === 0 ? 'after' : 'at';
  const cursor = storage.sql.exec<BackupRow>(backupPageSql(table, start), ...(after ?? []), most.rows, skip);
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
      ? positionAfter(storage, position, last)
      : following === undefined
        ? null
        : { ...position, table: following, after: null, skip: 0 };
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
