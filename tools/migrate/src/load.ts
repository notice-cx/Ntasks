/**
 * Loading an import from Beads or a backup into a deployed, empty task
 * store (the load command). The rows are first loaded into a local copy of
 * the store and verified there, so a load the store would refuse is found
 * before anything is sent. The copy's rows, every column as the store holds
 * it, then go to the store page by page through POST /api/restore, and are
 * committed in one transaction. Last, the store is read back through GET
 * /api/backup and compared with the copy, row by row.
 */
import {
  BACKUP_FORMAT,
  BACKUP_TABLES,
  sendLoad,
  type BackupFile,
  type BackupRow,
  type BackupTable,
  type LoadResult,
} from '@ntasks/domain';
import { backupUrl, downloadBackup } from './backup.ts';
import type { LocalStore } from './local-store.ts';
import { verifyBackup, type BackupReport } from './verify.ts';

export interface LoadOptions {
  /** The Ntasks address, such as https://tasks.example.com. */
  readonly api: string;
  /** A credential with the restore scope, and the backup scope to read the store back. */
  readonly token: string;
  readonly fetch: typeof fetch;
}

/** Every table of a store copy, each row with every column, as a backup holds them. */
export function copyAsBackup(store: LocalStore, takenAt: string): BackupFile {
  const tables = Object.fromEntries(BACKUP_TABLES.map((table) => [table, store.read(table) as BackupRow[]])) as Record<
    BackupTable,
    BackupRow[]
  >;
  return { format: BACKUP_FORMAT, takenAt, migrations: store.migrations(), tables };
}

/** Sends a store copy's rows to the empty store at `api`, page by page. */
export async function loadIntoStore(copy: BackupFile, options: LoadOptions): Promise<LoadResult> {
  const origin = backupUrl(options.api).origin;
  return sendLoad(copy.tables, copy.migrations, async (path, body) => {
    const response = await options.fetch(new URL(path, origin), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      // A redirect would carry the token to an address nobody chose.
      redirect: 'error',
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as unknown };
  });
}

/** Reads the store back through its backup route and compares it with the copy it was loaded from. */
export async function verifyLoaded(
  copy: BackupFile,
  options: LoadOptions,
): Promise<{ readonly report: BackupReport; readonly stored: BackupFile }> {
  const { file: stored } = await downloadBackup({ api: options.api, token: options.token, fetch: options.fetch });
  const report = await verifyBackup(copy, (table) => stored.tables[table]);
  return { report, stored };
}
