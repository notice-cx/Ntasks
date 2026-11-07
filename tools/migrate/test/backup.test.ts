// A backup through the command line: `backup` reads every page from a stand-in
// for the route, `restore` loads the file into a new store copy, and the
// verifier finds no difference from the store the pages came from.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BACKUP_FORMAT,
  BACKUP_TABLES,
  backupKey,
  backupPageSql,
  type BackupFile,
  type BackupRow,
  type BackupRows,
  type BackupTable,
  type TaskRow,
} from '@ntasks/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli.ts';
import { openLocalStore, storeMigrations, type LocalStore } from '../src/local-store.ts';
import { verifyBackup } from '../src/verify.ts';

const API = 'https://ntasks.test';
const TOKEN = 'ntasks_service.00000000-0000-4000-8000-000000000001.synthetic-secret';
const ACME = 'a1111111-0000-4000-8000-00000000000a';
const BETA = 'b2222222-0000-4000-8000-00000000000b';
const AT = '2026-03-02T09:00:00.000Z';
const LATER = '2026-03-02T10:00:00.000Z';

const task = {
  parent_id: null,
  type: 'task',
  await_type: null,
  status: 'open',
  priority: 2,
  description: '',
  acceptance: '',
  assignee: null,
  assignee_model: null,
  defer_until: null,
  due_at: null,
  choices: null,
  choice: null,
  metadata: '{}',
  filed_by: 'agent-a',
  filed_model: 'model-a',
  close_reason: null,
  resolution: null,
  duplicate_of: null,
  closed_by: null,
  closed_model: null,
  version: 1,
  created_at: AT,
  updated_at: AT,
  started_at: null,
  closed_at: null,
} as const;

const TASKS: TaskRow[] = [
  // A child whose parent's id sorts after its own.
  { ...task, id: 'acme-a1', project_id: ACME, parent_id: 'acme-z9', title: 'Child', description: 'Ünïcode, "quotes"' },
  {
    ...task,
    id: 'acme-z9',
    project_id: ACME,
    type: 'epic',
    title: 'Parent',
    notes: 'Notes so far.',
    design: 'How it is built.',
    estimate_minutes: 90,
  },
  // A duplicate of a task whose id sorts after its own.
  {
    ...task,
    id: 'acme-b2',
    project_id: ACME,
    title: 'Filed twice',
    status: 'closed',
    version: 2,
    updated_at: LATER,
    closed_at: LATER,
    close_reason: 'Same as acme-c3.',
    resolution: 'duplicate',
    duplicate_of: 'acme-c3',
    closed_by: 'owner',
  },
  {
    ...task,
    id: 'acme-c3',
    project_id: ACME,
    type: 'decision',
    title: 'Pick one',
    choices: JSON.stringify({ question: 'Which?', options: [{ key: 'a', label: 'A', recommended: true }] }),
    choice: JSON.stringify({ key: 'a', by: 'owner', at: LATER }),
    metadata: JSON.stringify({ noticeos_card: { usd: 100 } }),
  },
  { ...task, id: 'beta-g1', project_id: BETA, type: 'gate', await_type: 'human', title: 'Approve it' },
  {
    ...task,
    id: 'beta-d1',
    project_id: BETA,
    status: 'deferred',
    priority: 0,
    title: 'Later',
    assignee: 'agent-b',
    assignee_model: 'model-b',
    defer_until: '2026-12-01T00:00:00.000Z',
    due_at: '2026-12-31T00:00:00.000Z',
    started_at: LATER,
  },
];

/** A row of every kind the store keeps. */
const ROWS: BackupRows = {
  projects: [
    { id: ACME, key: 'acme.example.com', name: 'Acme', prefix: 'acme', created_at: AT },
    { id: BETA, key: 'beta.example.com', name: 'Beta', prefix: 'beta', created_at: AT },
  ],
  tasks: TASKS,
  task_labels: [
    { task_id: 'acme-a1', label: 'backend' },
    { task_id: 'acme-a1', label: 'ünïcode' },
    { task_id: 'beta-g1', label: 'approval' },
  ],
  task_edges: [
    { task_id: 'acme-a1', depends_on_id: 'acme-c3', type: 'blocks', created_at: AT, created_by: 'agent-a' },
    { task_id: 'acme-c3', depends_on_id: 'beta-d1', type: 'related', created_at: AT, created_by: null },
    { task_id: 'beta-d1', depends_on_id: 'beta-g1', type: 'discovered-from', created_at: LATER, created_by: 'owner' },
    { task_id: 'acme-b2', depends_on_id: 'acme-c3', type: 'duplicates', created_at: LATER, created_by: 'owner' },
    { task_id: 'acme-z9', depends_on_id: 'acme-b2', type: 'supersedes', created_at: LATER, created_by: null },
  ],
  task_external_links: [
    {
      task_id: 'acme-a1',
      url: 'https://code.example.com/acme/pull/1',
      title: 'The pull request',
      kind: 'pull-request',
      created_at: AT,
      created_by: 'agent-a',
    },
    {
      task_id: 'beta-d1',
      url: 'https://docs.example.com/plan',
      title: 'The plan',
      kind: null,
      created_at: LATER,
      created_by: null,
    },
  ],
  task_comments: [{ id: 'k-0001', task_id: 'acme-a1', author: 'owner', text: 'Looks right.', created_at: LATER }],
  task_events: [
    ...TASKS.map((row, index) => ({
      seq: index + 1,
      task_id: row.id,
      project_id: row.project_id,
      version: 1,
      kind: 'created',
      actor: 'agent-a',
      model: 'model-a',
      at: AT,
      changes: JSON.stringify({ id: row.id, title: row.title }),
    })),
    {
      seq: 7,
      task_id: 'acme-b2',
      project_id: ACME,
      version: 2,
      kind: 'closed',
      actor: 'owner',
      model: null,
      at: LATER,
      changes: JSON.stringify({ status: 'closed' }),
    },
    {
      seq: 8,
      task_id: 'acme-a1',
      project_id: ACME,
      version: 1,
      kind: 'commented',
      actor: 'owner',
      model: null,
      at: LATER,
      changes: JSON.stringify({ commentId: 'k-0001', text: 'Looks right.' }),
    },
  ],
  write_receipts: [
    {
      principal: 'service:noticeos/agent',
      operation: 'create_task',
      idempotency_key: 'key-00000001',
      project_id: ACME,
      request_hash: 'a'.repeat(64),
      result: JSON.stringify({ taskId: 'acme-a1', created: [] }),
      created_at: AT,
    },
  ],
};

interface Position {
  readonly table: BackupTable;
  readonly after: readonly (string | number)[] | null;
}

/**
 * Stands in for GET /api/backup on a store copy: it pages each table by its
 * key, `rows` at a time, with the query the store runs, and answers
 * `store_changed` to the first `changes` requests after a first page.
 */
function backupRoute(db: DatabaseSync, options: { readonly rows: number; readonly changes?: number }) {
  let changes = options.changes ?? 0;
  const requests: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(`${url.pathname}${url.search}`);
    if (url.origin !== API || url.pathname !== '/api/backup')
      return Response.json({ error: 'not_found' }, { status: 404 });
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${TOKEN}`)
      return Response.json({ error: 'invalid_token' }, { status: 401 });
    const token = url.searchParams.get('page');
    if (token !== null && changes > 0) {
      changes -= 1;
      return Response.json({ error: 'store_changed', detail: 'start again' }, { status: 409 });
    }
    const { table, after }: Position =
      token === null
        ? { table: BACKUP_TABLES[0], after: null }
        : (JSON.parse(Buffer.from(token, 'base64url').toString()) as Position);
    const rows = db
      .prepare(backupPageSql(table, after === null ? 'first' : 'after'))
      .all(...(after ?? []), options.rows, 0) as Record<string, string | number>[];
    const last = rows.at(-1);
    const following = BACKUP_TABLES[BACKUP_TABLES.indexOf(table) + 1];
    const next: Position | null =
      rows.length === options.rows && last
        ? { table, after: backupKey(table).map((column) => last[column] ?? '') }
        : following
          ? { table: following, after: null }
          : null;
    return Response.json({
      format: BACKUP_FORMAT,
      takenAt: AT,
      migrations: storeMigrations(),
      table,
      rows,
      next: next === null ? null : Buffer.from(JSON.stringify(next)).toString('base64url'),
    });
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
let source: LocalStore;
let tokenFile = '';
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'ntasks-backup-test-'));
  source = await openLocalStore(':memory:', { create: true });
  source.load(ROWS);
  tokenFile = path.join(folder, 'token');
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
});
afterEach(async () => {
  source.close();
  await rm(folder, { recursive: true, force: true });
});

async function backup(route: ReturnType<typeof backupRoute>, out = path.join(folder, 'backup.json')) {
  const run = io();
  const code = await main(['backup', '--api', API, '--token-file', tokenFile, '--out', out], run.io, route);
  return { code, file: out, out: run.out, err: run.err };
}

describe('a backup through the command line', () => {
  it('writes every page to one private file, which restores into a new store copy with no difference', async () => {
    const route = backupRoute(source.raw, { rows: 2 });
    const taken = await backup(route);
    expect(taken.err).toEqual([]);
    expect(taken.code).toBe(0);
    expect(taken.out[0]).toBe(
      `Backed up 2 projects, 6 tasks, 3 task_labels, 5 task_edges, 2 task_external_links, 1 task_comments, 8 task_events, 1 write_receipts, as the store stood at ${AT}, in 20 pages.`,
    );
    expect((await stat(taken.file)).mode & 0o777).toBe(0o600);

    const restored = path.join(folder, 'restored.sqlite');
    const run = io();
    expect(await main(['restore', '--from', taken.file, '--store', restored], run.io)).toBe(0);
    expect(run.err).toEqual([]);
    expect(run.out).toContain('0 differences.');
    expect(run.out).toContain('  acme.example.com  closed: 1 / 1');

    const copy = await openLocalStore(restored, { create: false });
    try {
      for (const table of BACKUP_TABLES) expect(copy.read(table), table).toEqual(source.read(table));
    } finally {
      copy.close();
    }
    const verified = io();
    expect(await main(['verify', '--from', taken.file, '--store', restored], verified.io)).toBe(0);
    expect(verified.out).toContain('0 differences.');
  });

  it('starts again when the store changes during a backup, and gives up after three tries', async () => {
    const once = await backup(backupRoute(source.raw, { rows: 500, changes: 1 }));
    expect(once.code).toBe(0);
    expect(once.err).toEqual(['The store was written to during attempt 1; starting again.']);

    const always = await backup(backupRoute(source.raw, { rows: 500, changes: 3 }), path.join(folder, 'never.json'));
    expect(always.code).toBe(1);
    expect(always.err.at(-1)).toBe(
      'The store was written to during each of 3 attempts, so no backup was taken. Run it again when agents are quiet.',
    );
    expect(existsSync(always.file)).toBe(false);
  });

  it('finds a restored store that differs from its backup', async () => {
    const taken = await backup(backupRoute(source.raw, { rows: 500 }));
    const restored = path.join(folder, 'restored.sqlite');
    expect(await main(['restore', '--from', taken.file, '--store', restored], io().io)).toBe(0);
    const db = new DatabaseSync(restored);
    db.exec("UPDATE task_labels SET label = 'frontend' WHERE task_id = 'acme-a1' AND label = 'backend'");
    db.exec('DELETE FROM write_receipts');
    db.close();
    const run = io();
    expect(await main(['verify', '--from', taken.file, '--store', restored], run.io)).toBe(1);
    expect(run.err).toEqual([
      '3 differences:',
      '- acme-a1: its task_labels row ["acme-a1","backend"] is missing',
      '- acme-a1: task_labels row ["acme-a1","frontend"] is not in the backup',
      '- retry record of service:noticeos/agent: its write_receipts row ["service:noticeos/agent","create_task","key-00000001"] is missing',
    ]);
  });

  it('tells apart two keys whose columns would read the same joined with a space', async () => {
    const receipt = ROWS.write_receipts![0]!;
    const spaced = { ...receipt, principal: 'service:a b', operation: 'x' };
    const split = { ...receipt, principal: 'service:a', operation: 'b x' };
    const tables = Object.fromEntries(BACKUP_TABLES.map((table) => [table, [] as BackupRow[]])) as Record<
      BackupTable,
      BackupRow[]
    >;
    tables.projects = ROWS.projects.map((row) => ({ ...row }));
    tables.write_receipts = [spaced, split];
    const file: BackupFile = { format: BACKUP_FORMAT, takenAt: AT, migrations: storeMigrations(), tables };
    const report = await verifyBackup(file, (table) => (table === 'write_receipts' ? [split] : tables[table]));
    expect(report.differences).toEqual([
      {
        subject: 'retry record of service:a b',
        difference: 'its write_receipts row ["service:a b","x","key-00000001"] is missing',
      },
    ]);
  });

  it('refuses an address that would send the token unencrypted, a file that exists, and a refused page', async () => {
    const route = backupRoute(source.raw, { rows: 500 });
    const plain = io();
    expect(
      await main(
        ['backup', '--api', 'http://ntasks.test', '--token-file', tokenFile, '--out', path.join(folder, 'a.json')],
        plain.io,
        route,
      ),
    ).toBe(1);
    expect(plain.err).toEqual([
      'http://ntasks.test does not use https. The token is sent only over https, or to this machine.',
    ]);
    expect(route.requests).toEqual([]);

    const existing = path.join(folder, 'existing.json');
    await writeFile(existing, 'kept');
    expect((await backup(route, existing)).code).toBe(1);
    expect(await readFile(existing, 'utf8')).toBe('kept');

    await writeFile(tokenFile, 'ntasks_service.wrong\n');
    const refused = await backup(route, path.join(folder, 'b.json'));
    expect(refused.code).toBe(1);
    expect(refused.err).toEqual(['The backup route answered 401 invalid_token.']);
  });

  it('restores only into a new store file, from a backup taken with the same migrations', async () => {
    const taken = await backup(backupRoute(source.raw, { rows: 500 }));
    const contents = JSON.parse(await readFile(taken.file, 'utf8')) as Record<string, unknown>;
    const older = path.join(folder, 'older.json');
    await writeFile(older, JSON.stringify({ ...contents, migrations: ['0001_task_store'] }));
    const target = path.join(folder, 'restored.sqlite');
    const run = io();
    expect(await main(['restore', '--from', older, '--store', target], run.io)).toBe(1);
    expect(run.err[0]).toMatch(
      /^The backup was taken from a store with the migrations 0001_task_store, and this version/u,
    );
    expect(existsSync(target)).toBe(false);

    await writeFile(target, '');
    expect(await main(['restore', '--from', taken.file, '--store', target], io().io)).toBe(1);
  });
});
