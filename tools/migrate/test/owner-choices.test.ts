// What the owner chose for Beads data Ntasks has no place for: each is
// imported or left out as chosen, reported, and passes the verifier.
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

async function imported(made: FakeHub) {
  const data = exportOf(made);
  const result = planImport(data);
  expect(result.refusals).toEqual([]);
  const store = await openLocalStore(':memory:', { create: true });
  store.load(result.plan!);
  const report = await verify(data, result.plan!, (table) => store.read(table));
  expect(report.differences).toEqual([]);
  return result;
}

describe("the owner's choices", () => {
  it('imports a spike as a task labelled spike, in every version', async () => {
    const { plan } = await imported(
      hub((c) => c.create({ id: 'web-s1', title: 'Try the new cache', issue_type: 'spike' })),
    );
    expect(plan!.tasks[0]).toMatchObject({ id: 'web-s1', type: 'task' });
    expect(plan!.task_labels).toEqual([{ task_id: 'web-s1', label: 'spike' }]);
    expect(JSON.parse(plan!.task_events[0]!.changes)).toMatchObject({ type: 'task', labels: ['spike'] });
  });

  it('leaves out the owner column and lease rows, reporting the leases', async () => {
    const made = hub((c) => c.create({ id: 'web-a1', title: 'One', owner: 'someone@example.com' }));
    made.otherTables.push({ name: 'leases', rows: 2 });
    const { plan, leftOut } = await imported(made);
    expect(JSON.parse(plan!.tasks[0]!.metadata)).toEqual({});
    expect(leftOut).toEqual([
      {
        subject: 'project web.example.com',
        what: '2 rows of leases: they record when a claim expires; Ntasks never expires a claim, and the claim itself is the assignee',
      },
    ]);
  });

  it("leaves out a parent's blocks link onto its own child, from every version, and reports it", async () => {
    const { plan, leftOut } = await imported(
      hub(
        (c) => {
          c.create({ id: 'web-e1', title: 'Epic', issue_type: 'epic' });
          c.create({ id: 'web-e1.1', title: 'Child' });
          c.link('web-e1.1', 'web-e1', 'parent-child');
        },
        (c) => c.link('web-e1', 'web-e1.1', 'blocks'),
        (c) => c.update('web-e1', { title: 'Epic, renamed' }),
      ),
    );
    expect(leftOut).toEqual([{ subject: 'web-e1', what: 'its blocks link onto its own child web-e1.1' }]);
    expect(plan!.task_edges).toEqual([]);
    // The version that only added the link is gone: created, then renamed.
    const epic = plan!.task_events.filter((event) => event.task_id === 'web-e1');
    expect(epic.map((event) => [event.version, event.kind, JSON.parse(event.changes).title])).toEqual([
      [1, 'created', 'Epic'],
      [2, 'updated', 'Epic, renamed'],
    ]);
    expect(plan!.tasks.find((task) => task.id === 'web-e1')?.version).toBe(2);
  });

  it('still refuses any other loop, such as a parent waiting on its grandchild', () => {
    const made = hub((c) => {
      c.create({ id: 'web-e1', title: 'Epic', issue_type: 'epic' });
      c.create({ id: 'web-e1.1', title: 'Child' });
      c.create({ id: 'web-e1.1.1', title: 'Grandchild' });
      c.link('web-e1.1', 'web-e1', 'parent-child');
      c.link('web-e1.1.1', 'web-e1.1', 'parent-child');
      c.link('web-e1', 'web-e1.1.1', 'blocks');
    });
    const { plan, refusals } = planImport(exportOf(made));
    expect(plan).toBeNull();
    expect(refusals.map((refusal) => refusal.subject)).toEqual(['web-e1', 'web-e1.1', 'web-e1.1.1']);
  });
});
