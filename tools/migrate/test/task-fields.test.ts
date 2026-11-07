// Beads data that Ntasks now has fields for: notes, design and estimates
// become task fields with their history, relates-to becomes related, a
// supersedes link moves to the task that replaces, duplicates keeps its
// direction, and a link to a web address becomes an external link. Each
// passes the verifier.
import { describe, expect, it } from 'vitest';
import { openLocalStore } from '../src/local-store.ts';
import { planImport } from '../src/plan.ts';
import { verify } from '../src/verify.ts';
import { FakeHub, type Change } from './fake-hub.ts';
import { exportOf, t } from './scenario.ts';

function hub(...changes: ((c: Change) => void)[]): FakeHub {
  const made = new FakeHub({ database: 'web_tasks', key: 'web.example.com', name: 'Web', id: 'w-1', prefix: 'web' });
  changes.forEach((change, index) => made.commit(t(index), 'beads', change));
  return made;
}

async function imported(...hubs: FakeHub[]) {
  const data = exportOf(...hubs);
  const result = planImport(data);
  expect(result.refusals).toEqual([]);
  const store = await openLocalStore(':memory:', { create: true });
  store.load(result.plan!);
  const report = await verify(data, result.plan!, (table) => store.read(table));
  expect(report.differences).toEqual([]);
  return { ...result, store, report };
}

const twoTasks = (c: Change) => {
  c.create({ id: 'web-a1', title: 'First' });
  c.create({ id: 'web-a2', title: 'Second' });
};

/** Each task's history events, with their changes read back. */
function historyOf(plan: NonNullable<ReturnType<typeof planImport>['plan']>, taskId: string) {
  return plan.task_events
    .filter((event) => event.task_id === taskId)
    .map((event) => ({
      kind: event.kind,
      at: event.at,
      changes: JSON.parse(event.changes) as Record<string, unknown>,
    }));
}

describe('notes, design and estimates', () => {
  it('import into their own fields, with every change in history, read as the Dolt server prints them', async () => {
    const made = hub(
      (c) => c.create({ id: 'web-a1', title: 'First', notes: 'Started on the footer.' }),
      (c) => c.update('web-a1', { notes: '0', design: 'A grid of three.', estimated_minutes: 90 }),
      (c) => c.update('web-a1', { estimated_minutes: 0 }),
    );
    made.valuesAsText = true;
    const { plan } = await imported(made);
    expect(plan!.tasks[0]).toMatchObject({ notes: '0', design: 'A grid of three.', estimate_minutes: 0 });
    expect(historyOf(plan!, 'web-a1').map((event) => event.changes)).toEqual([
      expect.objectContaining({ notes: 'Started on the footer.', design: '', estimateMinutes: null }),
      { notes: '0', design: 'A grid of three.', estimateMinutes: 90 },
      { estimateMinutes: 0 },
    ]);
  });

  it('refuses an estimate that is not a whole number of minutes', () => {
    const { refusals } = planImport(
      exportOf(hub((c) => c.create({ id: 'web-a1', title: 'First', estimated_minutes: -5 }))),
    );
    expect(refusals).toEqual([
      { subject: 'web-a1', reason: 'its estimated_minutes "-5" is not a whole number of minutes' },
    ]);
  });
});

describe('links', () => {
  it('imports relates-to as related, in both directions bd relate writes, dated as Beads dated them', async () => {
    const { plan } = await imported(
      hub(twoTasks, (c) => {
        c.link('web-a1', 'web-a2', 'relates-to');
        c.link('web-a2', 'web-a1', 'relates-to');
      }),
    );
    expect(plan!.task_edges).toEqual([
      { task_id: 'web-a1', depends_on_id: 'web-a2', type: 'related', created_at: t(1), created_by: 'beads' },
      { task_id: 'web-a2', depends_on_id: 'web-a1', type: 'related', created_at: t(1), created_by: 'beads' },
    ]);
  });

  it('keeps a duplicates link on the later filing, pointing at the work it repeats', async () => {
    const { plan } = await imported(hub(twoTasks, (c) => c.link('web-a2', 'web-a1', 'duplicates')));
    expect(plan!.task_edges).toEqual([
      { task_id: 'web-a2', depends_on_id: 'web-a1', type: 'duplicates', created_at: t(1), created_by: 'beads' },
    ]);
  });

  it('moves a supersedes link to the task that replaces, in its history as well', async () => {
    // bd supersede web-a1 --with web-a2 records web-a1 -> web-a2: web-a1 is the one replaced.
    const { plan } = await imported(
      hub(twoTasks, (c) => {
        c.link('web-a1', 'web-a2', 'supersedes');
        c.update('web-a1', { status: 'closed', closed_at: t(1), close_reason: 'Replaced by web-a2.' });
      }),
    );
    expect(plan!.task_edges).toEqual([
      { task_id: 'web-a2', depends_on_id: 'web-a1', type: 'supersedes', created_at: t(1), created_by: 'beads' },
    ]);
    expect(historyOf(plan!, 'web-a2')).toEqual([
      expect.objectContaining({ kind: 'created' }),
      { kind: 'updated', at: t(1), changes: { dependencies: [{ taskId: 'web-a1', type: 'supersedes' }] } },
    ]);
    expect(historyOf(plan!, 'web-a1').map((event) => Object.keys(event.changes))).toEqual([
      expect.any(Array),
      ['status', 'close'],
    ]);
  });

  it('refuses a supersedes link whose replacement is in another project', () => {
    const web = hub((c) => {
      c.create({ id: 'web-a1', title: 'First' });
      c.link('web-a1', 'app-a1', 'supersedes');
    });
    const app = new FakeHub({ database: 'app_tasks', key: 'app.example.com', name: 'App', id: 'a-1', prefix: 'app' });
    app.commit(t(0), 'beads', (c) => c.create({ id: 'app-a1', title: 'Replacement' }));
    expect(planImport(exportOf(web, app)).refusals).toContainEqual({
      subject: 'project web.example.com',
      reason:
        'web-a1 is superseded by app-a1, which is not one of its issues; Ntasks records the link on the replacement',
    });
  });
});

describe('external links', () => {
  it('imports a link to a web address as an external link, written as the URL standard writes it', async () => {
    const { plan, store } = await imported(
      hub(
        (c) => c.create({ id: 'web-a1', title: 'First' }),
        (c) =>
          c.link('web-a1', 'docs', 'related', {
            depends_on_issue_id: null,
            depends_on_external: 'HTTPS://Docs.Example.com/plan',
          }),
      ),
    );
    const link = { url: 'https://docs.example.com/plan', title: 'https://docs.example.com/plan', kind: null };
    expect(plan!.task_external_links).toEqual([{ task_id: 'web-a1', ...link, created_at: t(1), created_by: 'beads' }]);
    expect(plan!.task_edges).toEqual([]);
    expect(historyOf(plan!, 'web-a1')[1]).toEqual({ kind: 'updated', at: t(1), changes: { externalLinks: [link] } });
    expect(store.read('task_external_links')).toHaveLength(1);
  });

  it('finds an external link missing from the store, and notes that differ', async () => {
    const made = hub(
      (c) => c.create({ id: 'web-a1', title: 'First', notes: 'A note.' }),
      (c) =>
        c.link('web-a1', 'docs', 'related', {
          depends_on_issue_id: null,
          depends_on_external: 'https://docs.example.com/plan',
        }),
    );
    const data = exportOf(made);
    const { plan } = planImport(data);
    const store = await openLocalStore(':memory:', { create: true });
    store.load(plan!);
    store.raw.exec("DELETE FROM task_external_links; UPDATE tasks SET notes = 'Changed.', version = version + 1");
    const report = await verify(data, plan!, (table) => store.read(table));
    expect(report.differences).toEqual(
      expect.arrayContaining([
        { subject: 'web-a1', difference: 'external link https://docs.example.com/plan is missing' },
        { subject: 'web-a1', difference: 'its notes differ' },
      ]),
    );
  });
});
