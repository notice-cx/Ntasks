// The load command: an export or a backup is checked in a local copy, sent
// to an empty store page by page, committed, read back and verified against
// the file. The store here is a stand-in that answers the restore and backup
// routes over a local store copy; no request leaves the test.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BACKUP_FORMAT,
  BACKUP_TABLES,
  backupPageSql,
  type BackupRow,
  type BackupRows,
  type BackupTable,
} from '@ntasks/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli.ts';
import { openLocalStore, type LocalStore } from '../src/local-store.ts';
import { planImport } from '../src/plan.ts';
import { copyAsBackup } from '../src/load.ts';
import { scenario } from './scenario.ts';

const API = 'https://ntasks.test';
const TOKEN = 'ntasks_service.00000000-0000-4000-8000-000000000002.synthetic-secret';

/**
 * Stands in for a deployed Ntasks: the restore routes keep pages and load
 * them into `store` at the commit, and the backup route reads `store` back.
 * `drop` leaves one row of a table out at the commit, as a faulty store
 * would. `backup` refuses the backup route to the token, or fails it once
 * the load has landed.
 */
function standIn(
  store: LocalStore,
  options: { readonly drop?: BackupTable; readonly backup?: 'refused' | 'fails-after-commit' } = {},
) {
  const { drop } = options;
  const requests: string[] = [];
  let committed = false;
  let load: string | null = null;
  let pages: { table: BackupTable; rows: BackupRow[] }[] = [];
  const answer = (body: unknown, status = 200) => Response.json(body, { status });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.origin !== API) return answer({ error: 'not_found' }, 404);
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${TOKEN}`)
      return answer({ error: 'invalid_token' }, 401);
    if (url.pathname === '/api/backup') {
      if (options.backup === 'refused') return answer({ error: 'insufficient_scope' }, 403);
      if (options.backup === 'fails-after-commit' && committed) return answer({ error: 'internal_error' }, 500);
      const table = (url.searchParams.get('page') ?? BACKUP_TABLES[0]) as BackupTable;
      const rows = store.raw.prepare(backupPageSql(table, 'first')).all(100_000, 0);
      const next = BACKUP_TABLES[BACKUP_TABLES.indexOf(table) + 1] ?? null;
      return answer({ format: BACKUP_FORMAT, takenAt: 'now', migrations: store.migrations(), table, rows, next });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    switch (url.pathname) {
      case '/api/restore':
        if ((body.migrations as string[]).join() !== store.migrations().join())
          return answer({ error: 'schema_mismatch', detail: 'other migrations' }, 409);
        load = 'load-1';
        pages = [];
        return answer({ load });
      case '/api/restore/rows':
        if (body.load !== load) return answer({ error: 'no_such_load' }, 409);
        pages.push({ table: body.table as BackupTable, rows: body.rows as BackupRow[] });
        return answer({ table: body.table, page: pages.length, rows: (body.rows as unknown[]).length });
      case '/api/restore/commit': {
        if (body.load !== load) return answer({ error: 'no_such_load' }, 409);
        const tables = Object.fromEntries(
          BACKUP_TABLES.map((table) => [
            table,
            pages.filter((page) => page.table === table).flatMap((page) => page.rows),
          ]),
        ) as Record<BackupTable, BackupRow[]>;
        if (drop !== undefined) tables[drop] = tables[drop].slice(1);
        store.load(tables as unknown as BackupRows);
        committed = true;
        load = null;
        const rows = Object.values(tables).reduce((sum, list) => sum + list.length, 0);
        return answer({ rows, rowsWritten: rows });
      }
      case '/api/restore/abort':
        load = null;
        pages = [];
        return answer({ aborted: true });
      default:
        return answer({ error: 'not_found' }, 404);
    }
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { out: (line) => out.push(line), err: (line) => err.push(line) };
  return { io: value, out, err };
}

let folder = '';
let tokenFile = '';
let deployed: LocalStore;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'ntasks-load-test-'));
  tokenFile = path.join(folder, 'token');
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  deployed = await openLocalStore(':memory:', { create: true });
});
afterEach(async () => {
  deployed.close();
  await rm(folder, { recursive: true, force: true });
});

async function load(from: string, route: ReturnType<typeof standIn>) {
  const run = io();
  const code = await main(['load', '--api', API, '--token-file', tokenFile, '--from', from], run.io, route);
  return { code, ...run };
}

async function written(name: string, value: unknown): Promise<string> {
  const file = path.join(folder, name);
  await writeFile(file, JSON.stringify(value));
  return file;
}

describe('the load command', () => {
  it('loads an export from Beads into an empty store, and verifies the store against the export', async () => {
    const route = standIn(deployed);
    const loaded = await load(await written('export.json', scenario()), route);
    expect(loaded.err).toEqual([]);
    expect(loaded.code).toBe(0);
    expect(loaded.out.at(-1)).toBe('0 differences.');
    // It checks that it can read the store back before it sends anything.
    expect(route.requests.slice(0, 2)).toEqual(['GET /api/backup', 'POST /api/restore']);
    expect(route.requests).toContain('POST /api/restore/commit');
    const { plan } = planImport(scenario());
    expect(deployed.read('tasks').map((row) => row.id)).toEqual(plan!.tasks.map((row) => row.id).sort());
  });

  it('loads a backup, row for row', async () => {
    const source = await openLocalStore(':memory:', { create: true });
    source.load(planImport(scenario()).plan!);
    const backup = copyAsBackup(source, '2026-03-02T09:00:00.000Z');
    source.close();
    const loaded = await load(await written('backup.json', backup), standIn(deployed));
    expect(loaded.code).toBe(0);
    for (const table of BACKUP_TABLES) expect(deployed.read(table), table).toEqual(backup.tables[table]);
  });

  it('sends nothing when the export does not import', async () => {
    const data = scenario();
    const broken = { ...data, projects: [{ ...data.projects[0]!, prefix: 'not-a-prefix' }, ...data.projects.slice(1)] };
    const route = standIn(deployed);
    const loaded = await load(await written('export.json', broken), route);
    expect(loaded.code).toBe(1);
    expect(loaded.err[0]).toMatch(/^Refused: /u);
    expect(route.requests).toEqual([]);
  });

  it('finds a store that does not hold what was sent', async () => {
    const loaded = await load(await written('export.json', scenario()), standIn(deployed, { drop: 'task_labels' }));
    expect(loaded.code).toBe(1);
    expect(loaded.err[0]).toMatch(/^\d+ differences:$/u);
    expect(loaded.err.some((line) => line.includes('task_labels row'))).toBe(true);
  });

  it('sends nothing when the credential cannot read the store back', async () => {
    const route = standIn(deployed, { backup: 'refused' });
    const loaded = await load(await written('export.json', scenario()), route);
    expect(loaded.code).toBe(1);
    expect(loaded.err).toEqual([
      "The credential cannot read the store back through GET /api/backup (403 insufficient_scope), so nothing was sent. A load's credential needs the backup choice as well as the restore choice.",
    ]);
    expect(route.requests).toEqual(['GET /api/backup']);
  });

  it('says the load landed, and how to verify it, when reading the store back fails after the commit', async () => {
    const route = standIn(deployed, { backup: 'fails-after-commit' });
    const from = await written('export.json', scenario());
    const loaded = await load(from, route);
    expect(loaded.code).toBe(1);
    expect(loaded.err[0]).toMatch(
      /^The load landed: the store at https:\/\/ntasks\.test now holds the [\d,]+ rows sent, so loading again is refused\. Reading it back to verify them failed: The backup route answered 500 internal_error\.$/u,
    );
    expect(loaded.err[1]).toContain(`then run verify --from ${from} --store <that copy>.`);
    expect(route.requests).toContain('POST /api/restore/commit');
  });
});
