/**
 * Sending rows to an empty task store, page by page, through POST
 * /api/restore and the routes under it (docs/api.md): begin a load, send
 * each table's rows a page at a time, then commit with every table's count,
 * so the store writes them all in one transaction. A load that fails before
 * its commit lands is aborted, so the store keeps no pages of it. The load
 * command in tools/migrate and the store's tests send loads with it.
 */
import { BACKUP_TABLES, type BackupRow, type BackupTable } from './backup.ts';

/** The most a page holds: this many rows, or rows whose JSON takes about this many bytes, whichever comes first. */
export const LOAD_PAGE = Object.freeze({ rows: 500, bytes: 768 * 1024 });

/** Sends one load request: a POST of `body` as JSON to `path`. */
export type LoadPost = (path: string, body: unknown) => Promise<{ readonly status: number; readonly body: unknown }>;

/** Why a load did not land. */
export class LoadRefused extends Error {
  override name = 'LoadRefused';
}

export interface LoadResult {
  readonly pages: number;
  /** The rows the store wrote, and the rows Cloudflare counts as written for them, index entries included. */
  readonly rows: number;
  readonly rowsWritten: number;
}

/** The bytes a text takes in UTF-8. */
function utf8Length(text: string): number {
  let bytes = text.length;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    // Each UTF-16 unit is counted once already; add the rest of its character's UTF-8 bytes.
    if (code >= 0x80) bytes += code < 0x800 || (code >= 0xd800 && code <= 0xdfff) ? 1 : 2;
  }
  return bytes;
}

function field(body: unknown, key: string): unknown {
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
}

/**
 * Loads every table's rows into the store `post` reaches, which must be
 * empty and have exactly `migrations`. Each row holds every column of its
 * table, as the store holds it.
 */
export async function sendLoad(
  tables: Readonly<Partial<Record<BackupTable, readonly BackupRow[]>>>,
  migrations: readonly string[],
  post: LoadPost,
  most: { readonly rows: number; readonly bytes: number } = LOAD_PAGE,
): Promise<LoadResult> {
  const call = async (path: string, body: unknown): Promise<unknown> => {
    const answer = await post(path, body);
    if (answer.status !== 200) {
      const error = field(answer.body, 'error');
      const detail = field(answer.body, 'detail');
      throw new LoadRefused(
        `${path} answered ${answer.status}${typeof error === 'string' ? ` ${error}` : ''}${typeof detail === 'string' ? `: ${detail}` : ''}.`,
      );
    }
    return answer.body;
  };
  const load = field(await call('/api/restore', { migrations }), 'load');
  if (typeof load !== 'string') throw new LoadRefused('/api/restore answered no load.');
  try {
    let pages = 0;
    const counts: Partial<Record<BackupTable, number>> = {};
    for (const table of BACKUP_TABLES) {
      const rows = tables[table] ?? [];
      counts[table] = rows.length;
      let page: BackupRow[] = [];
      let bytes = 0;
      const send = async () => {
        await call('/api/restore/rows', { load, table, rows: page });
        pages += 1;
        page = [];
        bytes = 0;
      };
      for (const row of rows) {
        const size = utf8Length(JSON.stringify(row)) + 1;
        if (page.length > 0 && (page.length >= most.rows || bytes + size > most.bytes)) await send();
        page.push(row);
        bytes += size;
      }
      if (page.length > 0) await send();
    }
    const committed = await call('/api/restore/commit', { load, counts });
    return { pages, rows: Number(field(committed, 'rows')), rowsWritten: Number(field(committed, 'rowsWritten')) };
  } catch (error) {
    // The store keeps no pages of a load that did not land; a failed abort leaves them for the next begin to drop.
    await post('/api/restore/abort', { load }).catch(() => undefined);
    throw error;
  }
}
