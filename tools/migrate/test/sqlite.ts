/**
 * A database for tests: an in-memory SQLite database with the Worker's
 * migrations applied, enforcing foreign keys as D1 does. SQLite runs the
 * schema's CHECKs and triggers just as D1 does, so a row the schema refuses
 * here is refused in D1 too.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Database, Row } from '../src/d1.ts';

const MIGRATIONS = fileURLToPath(new URL('../../../workers/api/migrations/', import.meta.url));

export function sqliteDatabase(): Database & { readonly raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  let migrated = false;
  return {
    raw,
    description: 'the test database',
    async all(sql) {
      return raw.prepare(sql).all() as Row[];
    },
    async run(statements) {
      raw.exec('BEGIN');
      try {
        for (const statement of statements) raw.exec(statement);
        raw.exec('COMMIT');
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
    async migrate() {
      if (migrated) return;
      for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
        raw.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
      }
      migrated = true;
    },
    async size() {
      const row = raw.prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get() as { bytes: number };
      return row.bytes;
    },
  };
}
