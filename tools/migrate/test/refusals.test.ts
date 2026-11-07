import { describe, expect, it } from 'vitest';
import { planImport } from '../src/plan.ts';
import { FakeHub, type Change } from './fake-hub.ts';
import { exportOf, t } from './scenario.ts';

function hubWith(change: (c: Change) => void, options: Partial<{ prefix: string; id: string }> = {}): FakeHub {
  const prefix = options.prefix ?? 'web';
  const hub = new FakeHub({
    database: 'web_tasks',
    key: 'web.example.com',
    name: 'Web',
    id: options.id ?? 'w-1',
    prefix,
  });
  hub.commit(t(0), 'beads', (c) => {
    c.create({ id: `${prefix}-a1`, title: 'First' });
    c.create({ id: `${prefix}-a2`, title: 'Second' });
  });
  hub.commit(t(1), 'beads', change);
  return hub;
}

function refusalsOf(...hubs: FakeHub[]) {
  const { plan, refusals } = planImport(exportOf(...hubs));
  expect(plan).toBeNull();
  return refusals;
}

describe('the import refuses what is out of scope, naming it', () => {
  it.each(['waits-for', 'conditional-blocks', 'replies-to'])('a %s link', (type) => {
    expect(refusalsOf(hubWith((c) => c.link('web-a1', 'web-a2', type)))).toEqual([
      { subject: 'web-a1', reason: `its link to web-a2 has the type ${type}, which is out of scope` },
    ]);
  });

  it('a prefix with a hyphen, and the ids that use it', () => {
    const refusals = refusalsOf(hubWith(() => {}, { prefix: 'web-app' }));
    expect(refusals).toEqual(
      expect.arrayContaining([
        {
          subject: 'project web.example.com',
          reason:
            'its prefix "web-app" is not 1 to 32 lowercase letters and digits; prefixes with hyphens are out of scope',
        },
        { subject: 'web-app-a1', reason: 'its id "web-app-a1" is not a task id Ntasks accepts' },
      ]),
    );
  });

  it("a status or type outside Ntasks' lists", () => {
    const refusals = refusalsOf(
      hubWith((c) => {
        c.update('web-a1', { status: 'pinned' });
        c.update('web-a2', { issue_type: 'molecule' });
      }),
    );
    expect(refusals).toEqual(
      expect.arrayContaining([
        { subject: 'web-a1', reason: 'its status "pinned" is not one of Ntasks\' statuses' },
        { subject: 'web-a2', reason: 'its type "molecule" is not one of Ntasks\' types' },
      ]),
    );
  });

  it('a column Ntasks has no field for, quoting what it holds', () => {
    expect(refusalsOf(hubWith((c) => c.update('web-a1', { external_ref: 'gh-123' })))).toEqual([
      { subject: 'web-a1', reason: 'its column external_ref holds "gh-123", and Ntasks has no field for it' },
    ]);
  });

  it('accepts what a Dolt server prints for empty number and JSON columns, and Beads bookkeeping', () => {
    const hub = hubWith((c) => {
      c.update('web-a1', {
        pinned: '0',
        ephemeral: '0',
        estimated_minutes: '0',
        compaction_level: '0',
        row_lock: '-8564433141813951760',
      });
      c.link('web-a1', 'web-a2', 'blocks', { metadata: '{}' });
    });
    hub.otherTables.push({ name: 'bd_events_seq', rows: 1 });
    const { plan, refusals } = planImport(exportOf(hub));
    expect(refusals).toEqual([]);
    expect(plan!.task_edges).toHaveLength(1);
  });

  it('text that looks like zero or an empty list, which someone still wrote', () => {
    const refusals = refusalsOf(
      hubWith((c) => {
        c.update('web-a1', { external_ref: '0', spec_id: '[]' });
        c.update('web-a2', { external_ref: '{}' });
      }),
    );
    expect(refusals).toEqual([
      { subject: 'web-a1', reason: 'its column external_ref holds "0", and Ntasks has no field for it' },
      { subject: 'web-a1', reason: 'its column spec_id holds "[]", and Ntasks has no field for it' },
      { subject: 'web-a2', reason: 'its column external_ref holds "{}", and Ntasks has no field for it' },
    ]);
  });

  it('a wisp, a molecule and an approval waiting on something other than a person', () => {
    const refusals = refusalsOf(
      hubWith((c) => {
        c.update('web-a1', { ephemeral: 1, mol_type: 'swarm' });
        c.create({ id: 'web-a3', title: 'Wait for CI', issue_type: 'gate', await_type: 'gh:run', await_id: '123' });
      }),
    );
    expect(refusals).toEqual(
      expect.arrayContaining([
        { subject: 'web-a1', reason: 'its column ephemeral holds "1": it is a wisp, and wisps are out of scope' },
        { subject: 'web-a1', reason: 'its column mol_type holds "swarm": molecules are out of scope' },
        { subject: 'web-a3', reason: 'it waits on "gh:run": only approvals a person answers are in scope' },
        { subject: 'web-a3', reason: 'its column await_id holds "123": only approvals a person answers are in scope' },
      ]),
    );
  });

  it('a link outside the hub that is not a web address', () => {
    const hub = hubWith((c) => {
      c.link('web-a1', 'web-a2', 'blocks', { depends_on_issue_id: null, depends_on_external: 'external:other:thing' });
    });
    expect(refusalsOf(hub)).toEqual([
      {
        subject: 'web-a1',
        reason:
          'its link to "external:other:thing" is not a web address; Ntasks links outside itself only to http and https addresses',
      },
    ]);
  });

  it('a table of out-of-scope data, and one the import does not know', () => {
    const hub = hubWith(() => {});
    hub.otherTables.push({ name: 'mystery', rows: 1 });
    hub.otherTables.find((table) => table.name === 'wisps')!.rows = 3;
    expect(refusalsOf(hub)).toEqual([
      {
        subject: 'project web.example.com',
        reason: 'its table mystery holds 1 rows: the import does not know what it holds',
      },
      { subject: 'project web.example.com', reason: 'its table wisps holds 3 rows: wisps are out of scope' },
    ]);
  });

  it('a Dolt branch besides the one read', () => {
    const hub = hubWith(() => {});
    hub.branches = [...hub.branches, { name: 'experiment', hash: 'h9' }];
    expect(refusalsOf(hub)).toEqual([
      {
        subject: 'project web.example.com',
        reason:
          'its database has 2 Dolt branches (main, experiment); branches are out of scope, and the export reads only one',
      },
    ]);
  });
});

describe('the import refuses data it cannot carry whole', () => {
  it('a link to a task that is not in the export', () => {
    expect(refusalsOf(hubWith((c) => c.link('web-a1', 'web-zz', 'related')))).toEqual([
      { subject: 'web-a1', reason: 'its related link names web-zz, which is not a task in the export' },
    ]);
  });

  it('a task whose history does not rebuild it', () => {
    const hub = hubWith(() => {});
    // Changed outside any commit or working-set change Dolt reports.
    hub.issues.set('web-a2', { ...hub.issues.get('web-a2')!, title: 'Edited behind Dolt' });
    expect(refusalsOf(hub)).toEqual([
      { subject: 'web-a2', reason: 'its Dolt history does not rebuild it as it stands now (title differ)' },
    ]);
  });

  it("out-of-scope data in a task's past, saying when", () => {
    const hub = hubWith((c) => c.update('web-a1', { external_ref: 'gh-1' }));
    hub.commit(t(2), 'beads', (c) => c.update('web-a1', { external_ref: null }));
    expect(refusalsOf(hub)).toEqual([
      {
        subject: 'web-a1',
        reason: `its column external_ref holds "gh-1", and Ntasks has no field for it (in its history, at ${t(1)})`,
      },
    ]);
  });

  it('tasks that wait on each other in a loop', () => {
    const refusals = refusalsOf(
      hubWith((c) => {
        c.link('web-a1', 'web-a2', 'blocks');
        c.link('web-a2', 'web-a1', 'blocks');
      }),
    );
    expect(refusals).toEqual([
      { subject: 'web-a1', reason: 'it is in a loop of tasks that wait on each other through blocks links or parents' },
      { subject: 'web-a2', reason: 'it is in a loop of tasks that wait on each other through blocks links or parents' },
    ]);
  });

  it('an empty comment and metadata that is not an object', () => {
    const hub = hubWith((c) => c.update('web-a1', { metadata: '[1, 2]' }));
    hub.comment('web-a2', 'k-1', 'someone', '', t(3));
    expect(refusalsOf(hub)).toEqual(
      expect.arrayContaining([
        { subject: 'web-a1', reason: 'its metadata is not a JSON object' },
        { subject: 'web-a2', reason: 'comment k-1 is empty or holds a NUL character' },
      ]),
    );
  });

  it('two projects with the same prefix', () => {
    const one = hubWith(() => {});
    const two = new FakeHub({
      database: 'web2_tasks',
      key: 'web2.example.com',
      name: 'Web 2',
      id: 'w-2',
      prefix: 'web',
    });
    two.commit(t(0), 'beads', (c) => c.create({ id: 'web-b1', title: 'Other' }));
    expect(refusalsOf(one, two)).toEqual([
      { subject: 'project web2.example.com', reason: 'another project in the export has the same prefix, web' },
    ]);
  });

  it('reports every refusal of an export at once', () => {
    const refusals = refusalsOf(
      hubWith((c) => {
        c.link('web-a1', 'web-a2', 'waits-for');
        c.update('web-a2', { external_ref: 'gh-2' });
      }),
    );
    expect(refusals.map((refusal) => refusal.subject)).toEqual(['web-a1', 'web-a2']);
  });
});
