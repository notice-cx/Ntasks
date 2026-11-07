import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli.ts';
import { exportOf, scenario, t } from './scenario.ts';
import { FakeHub, serverAnswers } from './fake-hub.ts';
import { acmeHub, betaHub } from './scenario.ts';
import { DatabaseSync } from 'node:sqlite';

const FAKE_DOLT = fileURLToPath(new URL('./fake-dolt.mjs', import.meta.url));

let folder = '';
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'ntasks-migrate-test-'));
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { out: (line) => out.push(line), err: (line) => err.push(line) };
  return { io: value, out, err };
}

async function writeJson(name: string, value: unknown): Promise<string> {
  const file = path.join(folder, name);
  await writeFile(file, JSON.stringify(value));
  return file;
}

async function hubFileFor(hubs: readonly FakeHub[]): Promise<string> {
  const answers = await writeJson('answers.json', {
    password: 'synthetic-password',
    home: homedir(),
    queries: Object.fromEntries(serverAnswers(hubs)),
  });
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
    const hub = await writeJson('hub.json', {
      client: [path.join(folder, 'no-such-client')],
      projects: [{ database: 'acme_tasks', key: 'acme', name: 'Acme' }],
    });
    const run = io();
    expect(await main(['export', '--hub', hub, '--describe'], run.io)).toBe(0);
    expect(run.out.join('\n')).toContain(
      'The export sends only these read-only queries. Each step runs as one read-only transaction,',
    );
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
  const COST = [
    /^Size: 0\.\d MB, 0\.0% of the 5 GB the free plan stores\.$/u,
    /^Rows written to load it: at most \d+, \d+\.\d% of the 100,000 the free plan writes in a day\.$/u,
  ];

  it('checks an export against the store schema without writing anything', async () => {
    const from = await writeJson('export.json', scenario());
    const run = io();
    expect(await main(['import', '--from', from, '--check'], run.io), run.err.join('\n')).toBe(0);
    expect(run.out[0]).toBe(
      'The export imports: 2 projects, 11 tasks, 28 history events, 4 comments, 5 links, 0 external links, 2 labels. Nothing was written.',
    );
    expect(run.out.slice(1)).toEqual([expect.stringMatching(COST[0]!), expect.stringMatching(COST[1]!)]);
  });

  it('imports into a new store copy, verifies it, and never writes over a store file', async () => {
    const from = await writeJson('export.json', scenario());
    const store = path.join(folder, 'store.sqlite');
    const run = io();
    expect(await main(['import', '--from', from, '--store', store], run.io), run.err.join('\n')).toBe(0);
    expect(run.out[0]).toBe(
      `Imported 2 projects, 11 tasks, 28 history events, 4 comments, 5 links, 0 external links, 2 labels into the store copy ${store}.`,
    );
    expect(run.out[1]).toMatch(COST[0]!);
    // The copy and any file SQLite keeps beside it are private to their owner.
    for (const name of (await readdir(folder)).filter((entry) => entry.startsWith('store.sqlite'))) {
      expect((await stat(path.join(folder, name))).mode & 0o077, name).toBe(0);
    }

    const check = io();
    expect(await main(['verify', '--from', from, '--store', store], check.io), check.err.join('\n')).toBe(0);
    expect(check.out).toContain('0 differences.');
    expect(check.out).toContain('  acme.example.com  closed: 4 / 4');

    const twice = io();
    expect(await main(['import', '--from', from, '--store', store], twice.io)).toBe(1);
    expect(twice.err).toEqual([`${store} already exists. The import writes only a new store file.`]);
  });

  it('lists the differences and fails when the store differs', async () => {
    const from = await writeJson('export.json', scenario());
    const store = path.join(folder, 'store.sqlite');
    await main(['import', '--from', from, '--store', store], io().io);
    const raw = new DatabaseSync(store);
    raw.exec("DELETE FROM task_labels WHERE task_id = 'acme-e1.1'");
    raw.close();
    const check = io();
    expect(await main(['verify', '--from', from, '--store', store], check.io)).toBe(1);
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
    const store = path.join(folder, 'store.sqlite');
    const run = io();
    expect(await main(['import', '--from', from, '--store', store], run.io)).toBe(1);
    expect(run.err).toEqual([
      'Refused: 1 problems in 1 tasks or projects. Nothing was written.',
      '- web-a1: its link to web-a2 has the type waits-for, which is out of scope',
    ]);
    expect(existsSync(store)).toBe(false);
  });

  it('explains how to call it when the command is wrong', async () => {
    const run = io();
    expect(await main(['import', '--check'], run.io)).toBe(2);
    expect(run.err[0]).toContain('--from is required.');
    const from = await writeJson('export.json', scenario());
    expect(await main(['import', '--from', from], run.io)).toBe(2);
    expect(await main(['import', '--from', from, '--check', '--store', 'x.sqlite'], run.io)).toBe(2);
    expect(await main(['launch'], run.io)).toBe(2);
    expect(await main(['verify', '--nope'], run.io)).toBe(2);
  });
});
