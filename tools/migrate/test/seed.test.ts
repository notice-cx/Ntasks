// A seed becomes a store whose tasks read as if they had been filed, claimed,
// commented on and closed through the API, each with a history that rebuilds
// it; a seed that does not map is refused whole, and the backup file the seed
// command writes restores into a store copy with every row as planned.
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli.ts';
import { openLocalStore } from '../src/local-store.ts';
import { planSeed, SEED_FORMAT } from '../src/seed.ts';
import { verifySeed } from '../src/verify.ts';

const PROJECT = 'a1111111-0000-4000-8000-000000000001';

/** A project with an epic, a task claimed and closed under it by an agent, a task it blocks, and a gate waiting on a person. */
function seed(): Record<string, unknown> {
  return {
    format: SEED_FORMAT,
    projects: [
      {
        id: PROJECT,
        key: 'recipes.example.com',
        name: 'Recipes',
        prefix: 'rcp',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    tasks: [
      {
        id: 'rcp-epic1',
        type: 'epic',
        title: 'Recipe cards load fast',
        createdAt: '2026-09-02T09:00:00.000Z',
        createdBy: 'Mara',
      },
      {
        id: 'rcp-a1b2',
        title: 'Shrink the recipe card images',
        description: 'WHAT: smaller images.',
        priority: 1,
        parent: 'rcp-epic1',
        labels: ['synthetic-demo', 'perf'],
        metadata: { noticeos_change_class: 'template' },
        createdAt: '2026-09-02T10:00:00.000Z',
        createdBy: 'Mara',
        changes: [
          {
            at: '2026-09-03T10:00:00.000Z',
            by: 'claude',
            model: 'Opus 5.5',
            status: 'in_progress',
            assignee: 'claude',
          },
          {
            at: '2026-09-04T10:00:00.000Z',
            by: 'claude',
            model: 'Opus 5.5',
            status: 'closed',
            close: { reason: 'Shipped in 1a2b3c4; the card page shows it.' },
          },
        ],
        comments: [
          { author: 'codex', text: 'Checked: the images are a third of the size.', at: '2026-09-04T09:00:00.000Z' },
        ],
      },
      {
        id: 'rcp-c3d4',
        title: 'Lazy-load the nutrition panel',
        links: [{ type: 'blocks', to: 'rcp-a1b2' }],
        createdAt: '2026-09-02T11:00:00.000Z',
        createdBy: 'Mara',
      },
      {
        id: 'rcp-g5h6',
        type: 'gate',
        title: 'Approve the new card layout',
        awaitsPerson: true,
        createdAt: '2026-09-05T08:00:00.000Z',
        createdBy: 'claude',
        createdModel: 'Sonnet 5.5',
      },
    ],
  };
}

describe('a seed', () => {
  it('makes rows whose history rebuilds each task, with who made each change and the model they named', async () => {
    const { plan, refusals } = planSeed(seed());
    expect(refusals).toEqual([]);
    const store = await openLocalStore(':memory:', { create: true });
    try {
      store.load(plan!);
      expect(await verifySeed(plan!, (table) => store.read(table))).toEqual([]);
      const tasks = new Map(store.read('tasks').map((row) => [row.id, row]));
      expect(tasks.get('rcp-a1b2')).toMatchObject({
        parent_id: 'rcp-epic1',
        status: 'closed',
        assignee: 'claude',
        assignee_model: 'Opus 5.5',
        started_at: '2026-09-03T10:00:00.000Z',
        closed_at: '2026-09-04T10:00:00.000Z',
        closed_by: 'claude',
        closed_model: 'Opus 5.5',
        close_reason: 'Shipped in 1a2b3c4; the card page shows it.',
        resolution: 'done',
        filed_by: 'Mara',
        version: 3,
        updated_at: '2026-09-04T10:00:00.000Z',
      });
      expect(tasks.get('rcp-g5h6')).toMatchObject({
        type: 'gate',
        await_type: 'human',
        status: 'open',
        filed_model: 'Sonnet 5.5',
      });
      const events = store
        .read('task_events')
        .filter((event) => event.task_id === 'rcp-a1b2')
        .map((event) => [event.kind, event.version, event.actor, event.model, event.at]);
      expect(events).toEqual([
        ['created', 1, 'Mara', null, '2026-09-02T10:00:00.000Z'],
        ['updated', 2, 'claude', 'Opus 5.5', '2026-09-03T10:00:00.000Z'],
        ['commented', 2, 'codex', null, '2026-09-04T09:00:00.000Z'],
        ['closed', 3, 'claude', 'Opus 5.5', '2026-09-04T10:00:00.000Z'],
      ]);
      expect(store.read('task_edges')).toMatchObject([
        { task_id: 'rcp-c3d4', depends_on_id: 'rcp-a1b2', type: 'blocks' },
      ]);
      expect(
        store
          .read('task_labels')
          .filter((row) => row.task_id === 'rcp-a1b2')
          .map((row) => row.label),
      ).toEqual(['perf', 'synthetic-demo']);
    } finally {
      store.close();
    }
  });

  it('makes the same rows each time', () => {
    expect(planSeed(seed())).toEqual(planSeed(seed()));
  });

  it('is refused whole, with every reason, when any part does not map', () => {
    const bad = seed();
    const tasks = bad.tasks as Record<string, unknown>[];
    tasks[0] = { ...tasks[0], changes: [{ at: '2026-09-01T00:00:00.000Z', by: 'claude', status: 'in_progress' }] };
    tasks[1] = { ...tasks[1], owner: 'Mara' };
    tasks[2] = { ...tasks[2], links: [{ type: 'blocks', to: 'rcp-zzzz' }] };
    tasks.push({ id: 'oth-1234', title: 'Elsewhere', createdAt: '2026-09-02T10:00:00.000Z', createdBy: 'Mara' });
    tasks.push({
      id: 'rcp-k7l8',
      title: 'Closed without a reason',
      createdAt: '2026-09-02T10:00:00.000Z',
      createdBy: 'Mara',
      changes: [{ at: '2026-09-03T10:00:00.000Z', by: 'claude', status: 'closed' }],
    });
    const { plan, refusals } = planSeed(bad);
    expect(plan).toBeNull();
    expect(refusals).toEqual([
      { subject: 'oth-1234', reason: 'no project in the seed has the prefix oth' },
      { subject: 'rcp-a1b2', reason: 'owner is not a field of a task' },
      { subject: 'rcp-c3d4', reason: 'its blocks link names rcp-zzzz, which is not a task in the seed' },
      { subject: 'rcp-epic1', reason: 'change 1: at is before the change before it, 2026-09-02T09:00:00.000Z' },
      { subject: 'rcp-k7l8', reason: 'change 1: closing takes close: { "reason", "resolution" }' },
    ]);
  });

  it('is refused when a time is in the right form but names no real instant', () => {
    for (const createdAt of ['2026-02-30T10:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-09-02T25:61:61.000Z']) {
      const impossible = seed();
      (impossible.tasks as Record<string, unknown>[])[3]!.createdAt = createdAt;
      expect(planSeed(impossible).refusals).toEqual([
        { subject: 'rcp-g5h6', reason: 'createdAt is a UTC time with milliseconds' },
      ]);
    }
  });

  it('is refused when its tasks wait on each other in a loop', () => {
    const looped = seed();
    const tasks = looped.tasks as Record<string, unknown>[];
    tasks[1] = { ...tasks[1], links: [{ type: 'blocks', to: 'rcp-c3d4' }] };
    expect(planSeed(looped).refusals.map((refusal) => refusal.subject)).toEqual(['rcp-a1b2', 'rcp-c3d4']);
  });
});

describe('the seed command', () => {
  let folder = '';
  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'ntasks-seed-test-'));
  });

  function io() {
    const out: string[] = [];
    const err: string[] = [];
    const value: Io = { out: (line) => out.push(line), err: (line) => err.push(line) };
    return { io: value, out, err };
  }

  it('writes a backup that restores into a store copy with every row as planned', async () => {
    const from = path.join(folder, 'seed.json');
    await writeFile(from, JSON.stringify(seed()));
    const out = path.join(folder, 'backup.json');
    expect(await main(['seed', '--from', from, '--out', out], io().io)).toBe(0);
    const restore = io();
    expect(await main(['restore', '--from', out, '--store', path.join(folder, 'restored.sqlite')], restore.io)).toBe(0);
    expect(restore.out).toContain('0 differences.');
    // A second run never writes over the file.
    const again = io();
    expect(await main(['seed', '--from', from, '--out', out], again.io)).toBe(1);
  });

  it('writes nothing with --check, and nothing when the seed is refused', async () => {
    const from = path.join(folder, 'seed.json');
    await writeFile(from, JSON.stringify(seed()));
    expect(await main(['seed', '--from', from, '--check'], io().io)).toBe(0);
    const bad = seed();
    (bad.tasks as Record<string, unknown>[])[0]!.title = '';
    await writeFile(from, JSON.stringify(bad));
    const out = path.join(folder, 'backup.json');
    const refused = io();
    expect(await main(['seed', '--from', from, '--out', out], refused.io)).toBe(1);
    expect(refused.err).toContain('- rcp-epic1: title is 1 to 1024 characters');
    expect(existsSync(out)).toBe(false);
  });
});
