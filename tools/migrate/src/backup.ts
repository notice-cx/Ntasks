/**
 * A backup of a deployed task store, and its restore into a local copy of
 * the store. `downloadBackup` reads every page of GET /api/backup with a
 * credential that holds the backup scope and puts the pages together into
 * one backup file; `restoreBackup` loads a backup file into an empty store
 * copy (local-store.ts), which the verifier then compares with the file.
 */
import {
  BACKUP_FORMAT,
  BACKUP_TABLES,
  BackupRefused,
  collectBackup,
  type BackupFile,
  type BackupRow,
  type BackupRows,
  type BackupTable,
} from '@ntasks/domain';
import { isJsonObject } from './json.ts';
import type { LocalStore } from './local-store.ts';

/** How many times a backup starts again when the store is written to while the backup reads it. */
export const BACKUP_ATTEMPTS = 3;

/** The store answered that it changed after the export began. */
class StoreChanged extends Error {}

export interface DownloadOptions {
  /** The Ntasks address, such as https://tasks.example.com. */
  readonly api: string;
  /** A service credential made with the backup choice. */
  readonly token: string;
  readonly fetch: typeof fetch;
  readonly attempts?: number;
  /** Called before each new start after the store changed. */
  readonly onRestart?: (attempt: number) => void;
}

export interface Download {
  readonly file: BackupFile;
  readonly pages: number;
  readonly attempts: number;
}

/** The backup route's address, refusing any address that would send the token unencrypted to another machine. */
export function backupUrl(api: string): URL {
  let base: URL;
  try {
    base = new URL(api);
  } catch {
    throw new BackupRefused(`${api} is not an address.`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && local))
    throw new BackupRefused(`${api} does not use https. The token is sent only over https, or to this machine.`);
  return new URL('/api/backup', base.origin);
}

/** Reads every page of the store's backup, starting again when the store changes during it. */
export async function downloadBackup(options: DownloadOptions): Promise<Download> {
  const url = backupUrl(options.api);
  const attempts = options.attempts ?? BACKUP_ATTEMPTS;
  const page = async (token: string | null): Promise<unknown> => {
    const address = new URL(url);
    if (token !== null) address.searchParams.set('page', token);
    const response = await options.fetch(address, {
      headers: { authorization: `Bearer ${options.token}`, accept: 'application/json' },
      // A redirect would carry the token to an address nobody chose.
      redirect: 'error',
    });
    const body: unknown = await response.json().catch(() => null);
    const error = isJsonObject(body) && typeof body.error === 'string' ? body.error : null;
    if (response.status === 409 && error === 'store_changed') throw new StoreChanged();
    if (!response.ok) {
      const detail = isJsonObject(body) && typeof body.detail === 'string' ? `: ${body.detail}` : '';
      throw new BackupRefused(`The backup route answered ${response.status}${error ? ` ${error}` : ''}${detail}.`);
    }
    return body;
  };
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { ...(await collectBackup(page)), attempts: attempt };
    } catch (error) {
      if (!(error instanceof StoreChanged)) throw error;
      if (attempt >= attempts)
        throw new BackupRefused(
          `The store was written to during each of ${attempts} attempts, so no backup was taken. Run it again when agents are quiet.`,
        );
      options.onRestart?.(attempt);
    }
  }
}

/** A backup file's contents, checked to be whole. */
export function backupFrom(value: unknown): BackupFile {
  if (!isJsonObject(value) || value.format !== BACKUP_FORMAT)
    throw new BackupRefused(`The file is not a backup in the ${BACKUP_FORMAT} format.`);
  const { takenAt, migrations, tables } = value;
  if (typeof takenAt !== 'string') throw new BackupRefused('takenAt must be a time.');
  if (!Array.isArray(migrations) || !migrations.every((name) => typeof name === 'string'))
    throw new BackupRefused('migrations must be a list of names.');
  if (!isJsonObject(tables)) throw new BackupRefused('tables must be an object.');
  const unknown = Object.keys(tables).filter((name) => !(BACKUP_TABLES as readonly string[]).includes(name));
  if (unknown.length > 0) throw new BackupRefused(`tables holds ${unknown.join(', ')}, which this tool does not know.`);
  for (const table of BACKUP_TABLES) {
    const rows = tables[table];
    if (!Array.isArray(rows) || !rows.every(isJsonObject))
      throw new BackupRefused(`tables.${table} must be a list of rows.`);
  }
  return {
    format: BACKUP_FORMAT,
    takenAt,
    migrations: migrations as string[],
    tables: tables as unknown as Record<BackupTable, readonly BackupRow[]>,
  };
}

/**
 * Loads a backup into an empty store copy, in one transaction. The copy must
 * have exactly the backup's migrations: the same columns, and the same rules.
 */
export function restoreBackup(file: BackupFile, store: LocalStore): void {
  checkMigrations(file, store.migrations());
  store.load(file.tables as unknown as BackupRows);
}

/** Refuses a backup taken from a store with other migrations than `held`. */
export function checkMigrations(file: BackupFile, held: readonly string[]): void {
  if (held.join() !== file.migrations.join()) {
    throw new BackupRefused(
      `The backup was taken from a store with the migrations ${file.migrations.join(', ')}, and this version of ` +
        `Ntasks makes stores with ${held.join(', ')}. Restore it with the version of Ntasks it was taken from.`,
    );
  }
}

/** The rows of each table. */
export function rowCounts(tables: Readonly<Record<BackupTable, readonly unknown[]>>): Record<BackupTable, number> {
  return Object.fromEntries(BACKUP_TABLES.map((table) => [table, tables[table].length])) as Record<BackupTable, number>;
}

/** Rows per table, as a sentence. */
export function backupSummary(rows: Readonly<Record<BackupTable, number>>): string {
  return BACKUP_TABLES.map((table) => `${rows[table].toLocaleString('en-US')} ${table}`).join(', ');
}
