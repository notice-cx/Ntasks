/**
 * A local copy of the task store: a SQLite file with the store's schema,
 * applied from the store's own migration files, and loaded with the same
 * statements the store runs (packages/domain/src/store-rows.ts). A dry run
 * imports into one and verifies it on one machine, with no Worker and no
 * network. SQLite runs the schema's checks and triggers here as it does in
 * the store.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { insertStatements, selectAllSql, STORE_TABLES, type StoreRows, type StoreTable } from '@ntasks/domain';

export const STORE_MIGRATIONS = fileURLToPath(new URL('../../../workers/api/src/store/migrations/', import.meta.url));

export type Row = Record<string, unknown>;

export interface LocalStore {
  readonly description: string;
  /** Writes every row in one transaction, into a copy that holds no projects or tasks. */
  load(rows: StoreRows): void;
  /** One table's rows, in the order the store reads them back. */
  read(table: StoreTable): Row[];
  /** The bytes the database takes. */
  size(): number;
  /** At most how many rows the store writes to hold these, as Cloudflare counts them: each row and each index entry. */
  rowsWrittenAtMost(): number;
  close(): void;
  /** The database itself, for tests that change it behind the import. */
  readonly raw: DatabaseSync;
}

/** Applies the store's migration files in name order, each once and in one transaction, as the store does (schema.ts). */
function migrate(db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS store_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT');
  const applied = new Set(
    (db.prepare('SELECT name FROM store_migrations').all() as { name: string }[]).map((row) => row.name),
  );
  for (const file of readdirSync(STORE_MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const name = file.slice(0, -'.sql'.length);
    if (applied.has(name)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(path.join(STORE_MIGRATIONS, file), 'utf8'));
      db.prepare('INSERT INTO store_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

/**
 * Opens a local copy of the store. `create` makes a new one, refusing a file
 * that exists; otherwise the file must exist and is opened read-only.
 * `:memory:` makes one that lives only as long as the process.
 */
export async function openLocalStore(file: string, options: { readonly create: boolean }): Promise<LocalStore> {
  // Loaded here, so commands that never open a store do not load Node's SQLite module.
  const { DatabaseSync } = await import('node:sqlite');
  const memory = file === ':memory:';
  if (!memory && options.create && existsSync(file))
    throw new Error(`${file} already exists. The import writes only a new store file.`);
  if (!memory && !options.create && !existsSync(file)) throw new Error(`${file} does not exist.`);
  // The copy holds the hub's task data: made private to its owner before SQLite
  // opens it, and SQLite gives its journal files the database file's permissions.
  if (!memory && options.create) closeSync(openSync(file, 'wx', 0o600));
  const db = new DatabaseSync(file, { readOnly: !options.create && !memory });
  db.exec('PRAGMA foreign_keys = ON');
  if (options.create) migrate(db);
  return {
    raw: db,
    description: memory ? 'a store in memory' : `the store copy ${file}`,
    load(rows) {
      db.exec('BEGIN');
      try {
        const held = db.prepare('SELECT (SELECT COUNT(*) FROM projects) + (SELECT COUNT(*) FROM tasks) AS n').get() as {
          n: number;
        };
        if (held.n !== 0)
          throw new Error('The store already holds projects or tasks. An import writes only into an empty store.');
        for (const statement of insertStatements(rows)) db.prepare(statement.sql).run(...statement.values);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    read(table) {
      return db.prepare(selectAllSql(table)).all() as Row[];
    },
    size() {
      const row = db
        .prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()')
        .get() as { bytes: number };
      return Number(row.bytes);
    },
    rowsWrittenAtMost() {
      let total = 0;
      for (const table of STORE_TABLES) {
        const { rows } = db.prepare(`SELECT COUNT(*) AS rows FROM ${table}`).get() as { rows: number };
        const { indexes } = db
          .prepare("SELECT COUNT(*) AS indexes FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
          .get(table) as { indexes: number };
        total += rows * (1 + indexes);
      }
      return total;
    },
    close() {
      db.close();
    },
  };
}
