import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openLocalStore } from '../src/local-store.ts';

let folder = '';
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('a store copy', () => {
  it('keeps the file SQLite writes beside it during a write as private as itself', async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'ntasks-store-copy-'));
    const file = path.join(folder, 'store.sqlite');
    const store = await openLocalStore(file, { create: true });
    try {
      store.raw.exec('BEGIN');
      store.raw.exec(
        "INSERT INTO projects (id, key, name, prefix, created_at) VALUES ('p1', 'web.example.com', 'Web', 'web', '2026-01-01T00:00:00.000Z')",
      );
      const names = await readdir(folder);
      // The rollback journal exists only while the write is open.
      expect(names).toContain('store.sqlite-journal');
      for (const name of names) expect((await stat(path.join(folder, name))).mode & 0o077, name).toBe(0);
      store.raw.exec('ROLLBACK');
    } finally {
      store.close();
    }
  });
});
