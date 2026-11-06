import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli.ts';
import { exportOf, scenario, t } from './scenario.ts';
import { FakeHub, serverAnswers } from './fake-hub.ts';
import { acmeHub, betaHub } from './scenario.ts';
import { sqliteDatabase } from './sqlite.ts';

const FAKE_DOLT = fileURLToPath(new URL('./fake-dolt.mjs', import.meta.url));

let folder = '';
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'ntasks-migrate-test-'));
});

function io(database = sqliteDatabase()) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { out: (line) => out.push(line), err: (line) => err.push(line), database: () => database };
  return { io: value, out, err, database };
}

async function writeJson(name: string, value: unknown): Promise<string> {
  const file = path.join(folder, name);
  await writeFile(file, JSON.stringify(value));
  return file;
}

async function hubFileFor(hubs: readonly FakeHub[]): Promise<string> {
  const answers = await writeJson('answers.json', { password: 'synthetic-password', home: homedir(), queries: Object.fromEntries(serverAnswers(hubs)) });
  const passwordFile = path.join(folder, 'password');
  await writeFile(passwordFile, 'synthetic-password\n', { mode: 0o600 });
  return writeJson('hub.json', {
    client: [process.execPath, FAKE_DOLT, answers],
    passwordFile,
    projects: hubs.map((hub) => ({ database: hub.database, key: hub.key, name: hub.name, id: hub.id })),
  });
}

describe('export', () => {
  it('describes its queries without running the client', async () => {
    const hub = await writeJson('hub.json', { client: [path.join(folder, 'no-such-client')], projects: [{ database: 'acme_tasks', key: 'acme', name: 'Acme' }] });
    const run = io();
    expect(await main(['export', '--hub', hub, '--describe'], run.io)).toBe(0);
    expect(run.out.join('\n')).toContain('The export sends only these read-only queries, in this order:');
  });

  it('writes a private export file through the SQL client, and never over an existing one', async () => {
    const hubs = [acmeHub(), betaHub()];
    const hub = await hubFileFor(hubs);
    const out = path.join(folder, 'export.json');
    const run = io();
    expect(await main(['export', '--hub', hub, '--out', out], run.io)).toBe(0);
    expect(run.out).toEqual([
      'acme.example.com (acme_tasks): 9 tasks, 3 comments, 20 commits, 19 task changes.',
      'beta.example.com (beta_tasks): 2 tasks, 1 comments, 2 commits, 3 task changes.',
      `Wrote ${out}. It holds task data: keep it private.`,
    ]);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    const written = JSON.parse(await readFile(out, 'utf8'));
    expect(written.projects.map((project: { id: string }) => project.id)).toEqual(hubs.map((h) => h.id));

    const again = io();
    expect(await main(['export', '--hub', hub, '--out', out], again.io)).toBe(1);
    expect(again.err).toEqual([`Refused: ${out} already exists. The export never writes over a file.`]);
  });

  it('stops when the client refuses the password', async () => {
    const hubs = [acmeHub()];
    const hub = await hubFileFor(hubs);
    await writeFile(path.join(folder, 'password'), 'wrong\n');
    const run = io();
    expect(await main(['export', '--hub', hub, '--out', path.join(folder, 'export.json')], run.io)).toBe(1);
    expect(run.err.join('\n')).toContain('Access denied for user');
  });
});

describe('import and verify', () => {
  it('checks an export without writing anything', async () => {
    const from = await writeJson('export.json', scenario());
    const run = io();
    expect(await main(['import', '--from', from, '--persist-to', folder, '--check'], run.io)).toBe(0);
    expect(run.out).toEqual(['The export imports: 2 projects, 11 tasks, 28 history events, 4 comments, 5 links, 2 labels. Nothing was written.']);
    expect(await run.database.all("SELECT name FROM sqlite_master WHERE name = 'tasks'")).toEqual([]);
  });

  it('imports into an empty database, verifies it, and refuses to import twice', async () => {
    const from = await writeJson('export.json', scenario());
    const run = io();
    expect(await main(['import', '--from', from, '--persist-to', folder], run.io)).toBe(0);
    expect(run.out[0]).toBe('Imported 2 projects, 11 tasks, 28 history events, 4 comments, 5 links, 2 labels into the test database.');
    expect(run.out[1]).toMatch(/^Database size: 0\.\d MB, 0\.0% of D1's 500 MB limit for one database\.$/u);

    const check = io(run.database);
    expect(await main(['verify', '--from', from, '--persist-to', folder], check.io)).toBe(0);
    expect(check.out).toContain('0 differences.');
    expect(check.out).toContain('  acme.example.com  closed: 4 / 4');

    const twice = io(run.database);
    expect(await main(['import', '--from', from, '--persist-to', folder], twice.io)).toBe(1);
    expect(twice.err).toEqual(['Refused: the test database already holds projects or tasks. The import writes only into an empty database.']);
  });

  it('lists the differences and fails when the database differs', async () => {
    const from = await writeJson('export.json', scenario());
    const run = io();
    await main(['import', '--from', from, '--persist-to', folder], run.io);
    run.database.raw.exec("DELETE FROM task_labels WHERE task_id = 'acme-e1.1'");
    const check = io(run.database);
    expect(await main(['verify', '--from', from, '--persist-to', folder], check.io)).toBe(1);
    expect(check.err[0]).toMatch(/^\d+ differences:$/u);
    expect(check.err).toContain('- acme-e1.1: label content is missing');
  });

  it('prints every refusal and writes nothing', async () => {
    const hub = new FakeHub({ database: 'web_tasks', key: 'web.example.com', name: 'Web', id: 'w-1', prefix: 'web' });
    hub.commit(t(0), 'beads', (c) => {
      c.create({ id: 'web-a1', title: 'One' });
      c.create({ id: 'web-a2', title: 'Two' });
      c.link('web-a1', 'web-a2', 'waits-for');
    });
    const from = await writeJson('export.json', exportOf(hub));
    const run = io();
    expect(await main(['import', '--from', from, '--persist-to', folder], run.io)).toBe(1);
    expect(run.err).toEqual([
      'Refused: 1 problems in 1 tasks or projects. Nothing was written.',
      '- web-a1: its link to web-a2 has the type waits-for, which is out of scope',
    ]);
    expect(await run.database.all("SELECT name FROM sqlite_master WHERE name = 'tasks'")).toEqual([]);
  });

  it('explains how to call it when the command is wrong', async () => {
    const run = io();
    expect(await main(['import', '--persist-to', folder], run.io)).toBe(2);
    expect(run.err[0]).toContain('--from is required.');
    expect(await main(['launch'], run.io)).toBe(2);
    expect(await main(['verify', '--nope'], run.io)).toBe(2);
  });
});
