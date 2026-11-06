// The import and the verifier through wrangler, on a local D1 database in a
// temporary folder: the path the dry run takes. Nothing reaches Cloudflare.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli.ts';
import { scenario } from './scenario.ts';

const folders: string[] = [];
afterAll(async () => {
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line) => out.push(line), err: (line) => err.push(line) };
  return { io, out, err };
}

describe('a local D1 database through wrangler', () => {
  it('takes the import and passes the verifier with zero differences', { timeout: 180_000 }, async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'ntasks-migrate-d1-'));
    folders.push(folder);
    const from = path.join(folder, 'export.json');
    await writeFile(from, JSON.stringify(scenario()));
    const persistTo = path.join(folder, 'd1');

    const imported = capture();
    expect(await main(['import', '--from', from, '--persist-to', persistTo], imported.io), imported.err.join('\n')).toBe(0);
    expect(imported.out[0]).toMatch(/^Imported 2 projects, 11 tasks, 28 history events/u);
    expect(imported.out[1]).toMatch(/^Database size: 0\.\d MB/u);

    const verified = capture();
    expect(await main(['verify', '--from', from, '--persist-to', persistTo], verified.io), verified.err.join('\n')).toBe(0);
    expect(verified.out).toContain('0 differences.');
  });
});
