import { describe, expect, it } from 'vitest';
import { readExport } from '../src/beads.ts';
import { exportHub } from '../src/export.ts';
import { openLocalStore, type LocalStore } from '../src/local-store.ts';
import { planImport, type ImportPlan } from '../src/plan.ts';
import { verify } from '../src/verify.ts';
import { FakeHub, fakeServer } from './fake-hub.ts';
import { acmeHub, betaHub, exportOf, scenario, t } from './scenario.ts';

/** A store copy in memory with the plan loaded, by the statements the task store runs. */
async function loaded(plan: ImportPlan): Promise<LocalStore> {
  const store = await openLocalStore(':memory:', { create: true });
  store.load(plan);
  return store;
}

async function imported() {
  const data = scenario();
  const { plan, refusals } = planImport(data);
  expect(refusals).toEqual([]);
  const store = await loaded(plan!);
  const all = (sql: string) => store.raw.prepare(sql).all() as Record<string, unknown>[];
  return { data, plan: plan!, store, db: { all } };
}

const reader = (store: LocalStore) => (table: Parameters<LocalStore['read']>[0]) => store.read(table);

describe('export, import and verify', () => {
  it('carries a hub into the task store with zero differences', async () => {
    const acme = acmeHub();
    const beta = betaHub();
    const hub = {
      client: ['dolt'],
      projects: [acme, beta].map((h) => ({ database: h.database, key: h.key, name: h.name, id: h.id })),
    };
    const exported = await exportHub(hub, fakeServer([acme, beta]), () => new Date('2026-03-03T00:00:00.000Z'));
    // Through the file format and back, as the commands pass it.
    const data = readExport(JSON.stringify(exported));
    const { plan, refusals } = planImport(data);
    expect(refusals).toEqual([]);
    const store = await loaded(plan!);
    const report = await verify(data, plan!, reader(store));
    expect(report.differences).toEqual([]);
    expect(report.totals).toEqual({
      projects: 2,
      tasks: 11,
      labels: 2,
      links: 5,
      externalLinks: 0,
      comments: 4,
      events: plan!.task_events.length,
    });
    expect(report.approvals).toBe(1);
    expect(report.decisions).toBe(1);
    expect(report.frozenCards).toBe(1);
    expect(report.counts).toContainEqual({ project: 'acme.example.com', status: 'closed', expected: 4, actual: 4 });
  });

  it('carries a hub read through a Dolt server, which prints every value as text', async () => {
    const acme = acmeHub();
    const beta = betaHub();
    acme.valuesAsText = true;
    beta.valuesAsText = true;
    const hub = {
      client: ['dolt'],
      projects: [acme, beta].map((h) => ({ database: h.database, key: h.key, name: h.name, id: h.id })),
    };
    const data = readExport(JSON.stringify(await exportHub(hub, fakeServer([acme, beta]))));
    expect(data.projects[0]!.rows.issues[0]).toMatchObject({
      priority: '1',
      pinned: '0',
      metadata: expect.any(String),
    });
    const { plan, refusals } = planImport(data);
    expect(refusals).toEqual([]);
    const report = await verify(data, plan!, reader(await loaded(plan!)));
    expect(report.differences).toEqual([]);
    expect(report.totals.tasks).toBe(11);
  });

  it('keeps ids, project identities, timestamps and the close details', async () => {
    const { db } = await imported();
    const projects = await db.all('SELECT id, key, prefix, created_at FROM projects ORDER BY key');
    expect(projects).toEqual([
      {
        id: 'a1111111-0000-4000-8000-000000000001',
        key: 'acme.example.com',
        prefix: 'acme',
        created_at: '2026-03-02T09:00:00.000Z',
      },
      {
        id: 'b2222222-0000-4000-8000-000000000002',
        key: 'beta.example.com',
        prefix: 'beta',
        created_at: '2026-03-02T09:05:00.000Z',
      },
    ]);
    const [t1] = await db.all("SELECT * FROM tasks WHERE id = 'acme-t1'");
    expect(t1).toMatchObject({
      status: 'closed',
      assignee: 'agent-b',
      assignee_model: 'model-two',
      filed_by: 'agent-a',
      filed_model: 'model-one',
      closed_at: '2026-03-02T09:40:00.000Z',
      close_reason: 'Shipped in abc1234.',
      resolution: 'done',
      closed_by: 'agent-b',
      closed_model: 'model-two',
      created_at: '2026-03-02T09:10:00.000Z',
      updated_at: '2026-03-02T09:40:01.000Z',
      started_at: '2026-03-02T09:20:00.000Z',
      version: 5,
    });
    // Metadata keys that became columns leave metadata; every other key stays as given.
    expect(JSON.parse(String(t1!.metadata))).toEqual({
      noticeos_card: {
        valuePerMonth: 120,
        likelihood: 0.4,
        reviewMinutes: 5,
        daysToSignal: 14,
        measurability: 'cohort',
      },
      noticeos_change_class: 'feature',
      noticeos_operation_id: 'op-0001',
      noticeos_card_shipped: {
        card: { valuePerMonth: 120, likelihood: 0.4, reviewMinutes: 5, daysToSignal: 14, measurability: 'cohort' },
        closedAt: '2026-03-02T09:40:00.000Z',
        commit: 'abc1234',
      },
    });
    const [duplicate] = await db.all("SELECT resolution, duplicate_of, closed_by FROM tasks WHERE id = 'acme-t3'");
    expect(duplicate).toEqual({ resolution: 'duplicate', duplicate_of: 'acme-t2', closed_by: 'agent-a' });
    // Reopened: no close at all, though NoticeOS's closer is still in Beads' metadata.
    const [reopened] = await db.all(
      "SELECT status, closed_at, resolution, closed_by, metadata, defer_until, due_at FROM tasks WHERE id = 'acme-t4'",
    );
    expect(reopened).toEqual({
      status: 'open',
      closed_at: null,
      resolution: null,
      closed_by: null,
      metadata: '{}',
      defer_until: '2026-04-01T00:00:00.000Z',
      due_at: '2026-04-15T00:00:00.000Z',
    });
  });

  it('turns parents, links and NoticeOS related tasks into the schema shape', async () => {
    const { db } = await imported();
    expect(await db.all('SELECT id, parent_id FROM tasks WHERE parent_id IS NOT NULL ORDER BY id')).toEqual([
      { id: 'acme-e1.1', parent_id: 'acme-e1' },
      { id: 'acme-e1.2', parent_id: 'acme-e1' },
    ]);
    expect(
      await db.all(
        'SELECT task_id, depends_on_id, type, created_at, created_by FROM task_edges ORDER BY task_id, depends_on_id',
      ),
    ).toEqual([
      {
        task_id: 'acme-e1.2',
        depends_on_id: 'acme-e1.1',
        type: 'blocks',
        created_at: '2026-03-02T09:02:00.000Z',
        created_by: 'noticeos',
      },
      {
        task_id: 'acme-t2',
        depends_on_id: 'acme-g1',
        type: 'blocks',
        created_at: '2026-03-02T09:51:00.000Z',
        created_by: 'noticeos',
      },
      {
        task_id: 'acme-t3',
        depends_on_id: 'acme-t2',
        type: 'discovered-from',
        created_at: '2026-03-02T10:30:00.000Z',
        created_by: 'noticeos',
      },
      // From noticeos_related_tasks: dated by the change that added it, with no recorded author.
      {
        task_id: 'acme-t4',
        depends_on_id: 'beta-x1',
        type: 'related',
        created_at: '2026-03-02T10:50:00.000Z',
        created_by: null,
      },
      {
        task_id: 'beta-x2',
        depends_on_id: 'beta-x1',
        type: 'blocks',
        created_at: '2026-03-02T09:06:00.000Z',
        created_by: null,
      },
    ]);
    const [gate] = await db.all("SELECT type, await_type, status FROM tasks WHERE id = 'acme-g1'");
    expect(gate).toEqual({ type: 'gate', await_type: 'human', status: 'closed' });
    const [decision] = await db.all("SELECT choices, choice FROM tasks WHERE id = 'acme-d1'");
    expect(JSON.parse(String(decision!.choice))).toEqual({
      option: 'a',
      label: 'Carrier one',
      by: 'owner',
      at: '2026-03-02T10:20:00.000Z',
    });
    expect(JSON.parse(String(decision!.choices)).question).toBe('Which carrier?');
  });

  it('writes awkward text exactly as Beads stored it', async () => {
    const { db } = await imported();
    const [row] = await db.all("SELECT description FROM tasks WHERE id = 'acme-e1.1'");
    expect(row!.description).toBe(
      'Quotes \' and " ; semicolons; -- not a comment /* nor this */\nA second line, ünïcödé and 🧪.',
    );
  });

  it('numbers history events in time order across every task', async () => {
    const { db, plan } = await imported();
    const events = await db.all('SELECT seq, at FROM task_events ORDER BY seq');
    expect(events.map((event) => event.seq)).toEqual(plan.task_events.map((event) => event.seq));
    const times = events.map((event) => String(event.at));
    expect(times).toEqual([...times].sort());
  });
});

it("dates a related link to a task's own parent by the change that added it, not by the parent link", async () => {
  const hub = new FakeHub({ database: 'web_tasks', key: 'web.example.com', name: 'Web', id: 'w-1', prefix: 'web' });
  hub.commit(t(0), 'beads', (c) => {
    c.create({ id: 'web-e1', title: 'Epic', issue_type: 'epic' });
    c.create({ id: 'web-e1.1', title: 'Child' });
    c.link('web-e1.1', 'web-e1', 'parent-child');
  });
  hub.commit(t(5), 'beads', (c) =>
    c.update('web-e1.1', { metadata: { noticeos_related_tasks: [{ projectId: 'w-1', taskId: 'web-e1' }] } }),
  );
  const { plan, refusals } = planImport(exportOf(hub));
  expect(refusals).toEqual([]);
  expect(plan!.task_edges).toEqual([
    { task_id: 'web-e1.1', depends_on_id: 'web-e1', type: 'related', created_at: t(5), created_by: null },
  ]);
  expect(plan!.tasks.find((task) => task.id === 'web-e1.1')?.parent_id).toBe('web-e1');
});

describe('the verifier', () => {
  async function differencesAfter(change: (store: LocalStore) => void) {
    const { data, plan, store } = await imported();
    change(store);
    return (await verify(data, plan, reader(store))).differences;
  }

  it('reports a missing label', async () => {
    const differences = await differencesAfter((store) =>
      store.raw.exec("DELETE FROM task_labels WHERE task_id = 'acme-t1'"),
    );
    expect(differences).toContainEqual({ subject: 'acme-t1', difference: 'label backend is missing' });
    expect(
      differences.some(
        (d) => d.subject === 'acme-t1' && d.difference.startsWith('its history does not rebuild it (labels'),
      ),
    ).toBe(true);
  });

  it('reports a changed task, against the export, the plan and its own history', async () => {
    const differences = await differencesAfter((store) =>
      store.raw.exec("UPDATE tasks SET title = 'Edited', version = version + 1 WHERE id = 'acme-t2'"),
    );
    expect(differences).toEqual(
      expect.arrayContaining([
        { subject: 'acme-t2', difference: 'its title differs' },
        { subject: 'acme-t2', difference: 'its tasks row acme-t2 differs in title, version' },
        { subject: 'acme-t2', difference: 'it is at version 3, but its history has 2 versions' },
        { subject: 'acme-t2', difference: 'its history does not rebuild it (title differ)' },
      ]),
    );
  });

  it('reports a missing link and a comment not in the export', async () => {
    const differences = await differencesAfter((store) => {
      store.raw.exec("DELETE FROM task_edges WHERE task_id = 'acme-t2'");
      store.raw.exec(
        "INSERT INTO task_comments (id, task_id, author, text, created_at) VALUES ('k-9999', 'beta-x1', 'someone', 'Extra', '2026-03-03T00:00:00.000Z')",
      );
    });
    expect(differences).toEqual(
      expect.arrayContaining([
        { subject: 'acme-t2', difference: 'link blocks acme-g1 is missing' },
        { subject: 'beta-x1', difference: 'comment k-9999 is not in the export' },
        { subject: 'beta-x1', difference: 'comment k-9999 has no history event' },
      ]),
    );
  });

  it('reports a task missing from the store in the counts', async () => {
    const { data, plan } = await imported();
    const partial = await loaded({
      ...plan,
      tasks: plan.tasks.filter((task) => task.id !== 'beta-x2'),
      task_edges: plan.task_edges.filter((e) => e.task_id !== 'beta-x2'),
      task_comments: plan.task_comments.filter((c) => c.task_id !== 'beta-x2'),
      task_events: plan.task_events.filter((e) => e.task_id !== 'beta-x2'),
    });
    const report = await verify(data, plan, reader(partial));
    expect(report.counts).toContainEqual({ project: 'beta.example.com', status: 'open', expected: 2, actual: 1 });
    expect(report.differences).toEqual(
      expect.arrayContaining([
        { subject: 'project beta.example.com', difference: '2 tasks are open in the export, 1 in the store' },
        { subject: 'project beta.example.com', difference: 'task beta-x2 is missing' },
        { subject: 'beta-x2', difference: 'comment k-0100 is missing' },
      ]),
    );
  });
});
