/**
 * The D1 database an import writes and a verify reads, reached through
 * wrangler. Only a local database is supported: `--local` with a
 * `--persist-to` folder, so nothing here reaches Cloudflare.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type Row = Record<string, unknown>;

export interface Database {
  /** Where the database is, for reports. */
  readonly description: string;
  /** The rows of one query. */
  all(sql: string): Promise<Row[]>;
  /** Runs the statements in order. */
  run(statements: readonly string[]): Promise<void>;
  /** Applies the Worker's migrations the database lacks. */
  migrate(): Promise<void>;
  /** The bytes the database takes, or null when unknown. */
  size(): Promise<number | null>;
}

export interface LocalD1 {
  /** The database's name in the wrangler config, such as `ntasks`. */
  readonly database: string;
  /** The folder wrangler keeps the local database in. */
  readonly persistTo: string;
  /** The Worker's wrangler config, which names the database. */
  readonly config: string;
}

const OUTPUT_LIMIT = 1024 * 1024 * 1024;

function wranglerBin(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
}

function wrangler(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [wranglerBin(), ...args],
      // CI makes wrangler go ahead without asking, as a person at a terminal would be asked.
      {
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
        maxBuffer: OUTPUT_LIMIT,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error(`wrangler ${args.slice(0, 3).join(' ')} failed:\n${stderr || stdout || error.message}`));
        else resolve(stdout);
      },
    );
  });
}

/**
 * The pages of the SQLite files wrangler keeps for local D1 databases in
 * `folder`, opened read-only. D1 refuses SQLite's page-count functions in a
 * query, so the size is read from the files.
 */
async function localBytes(folder: string): Promise<number> {
  // Loaded here, so only the commands that measure a database load Node's SQLite module.
  const { DatabaseSync } = await import('node:sqlite');
  let total = 0;
  for (const name of await readdir(folder)) {
    if (!name.endsWith('.sqlite') || name === 'metadata.sqlite') continue;
    const file = new DatabaseSync(path.join(folder, name), { readOnly: true });
    try {
      const row = file
        .prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()')
        .get() as { bytes: number };
      total += Number(row.bytes);
    } finally {
      file.close();
    }
  }
  return total;
}

export function localD1(target: LocalD1): Database {
  const where = ['--local', '--persist-to', target.persistTo, '--config', target.config];
  return {
    description: `${target.database} (local, in ${target.persistTo})`,
    async all(sql) {
      const output = await wrangler(['d1', 'execute', target.database, ...where, '--json', '--command', sql]);
      const parsed: unknown = JSON.parse(output);
      const first = Array.isArray(parsed) ? (parsed[0] as { results?: unknown } | undefined) : undefined;
      if (!Array.isArray(first?.results)) throw new Error('wrangler returned no rows for a query.');
      return first.results as Row[];
    },
    async run(statements) {
      // The statements hold the hub's task data, so the file is private and removed afterwards.
      const folder = await mkdtemp(path.join(tmpdir(), 'ntasks-import-'));
      try {
        const file = path.join(folder, 'import.sql');
        await writeFile(file, `${statements.join('\n')}\n`, { mode: 0o600 });
        await wrangler(['d1', 'execute', target.database, ...where, '--file', file, '--yes']);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
    async migrate() {
      await wrangler(['d1', 'migrations', 'apply', target.database, ...where]);
    },
    async size() {
      try {
        return await localBytes(path.join(target.persistTo, 'v3', 'd1', 'miniflare-D1DatabaseObject'));
      } catch {
        return null;
      }
    },
  };
}
