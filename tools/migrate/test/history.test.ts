import { describe, expect, it } from 'vitest';
import { planImport } from '../src/plan.ts';
import { scenario, t } from './scenario.ts';

function eventsOf(taskId: string) {
  const { plan } = planImport(scenario());
  return plan!.task_events
    .filter((event) => event.task_id === taskId)
    .map((event) => ({ ...event, changes: JSON.parse(event.changes) }));
}

describe('history', () => {
  it('records the full task in the created event, as the engine does', () => {
    const [created] = eventsOf('acme-t1');
    expect(created).toMatchObject({ version: 1, kind: 'created', actor: 'agent-a', model: 'model-one', at: t(10) });
    expect(Object.keys(created!.changes)).toEqual([
      'id',
      'projectId',
      'parentId',
      'type',
      'awaitType',
      'status',
      'priority',
      'title',
      'description',
      'acceptance',
      'notes',
      'design',
      'estimateMinutes',
      'assignee',
      'assigneeModel',
      'startedAt',
      'deferUntil',
      'dueAt',
      'choices',
      'choice',
      'metadata',
      'labels',
      'dependencies',
      'externalLinks',
      'fields',
      'close',
      'filedBy',
      'filedModel',
    ]);
    expect(created!.changes).toMatchObject({ status: 'open', labels: ['feed'], close: null, filedBy: 'agent-a' });
  });

  it("records only the changed fields after, with the actor from Beads' audit log", () => {
    const events = eventsOf('acme-t1');
    expect(
      events.map(({ version, kind, actor, model, at, changes }) => ({ version, kind, actor, model, at, changes })),
    ).toEqual([
      expect.objectContaining({ version: 1, kind: 'created' }),
      {
        version: 2,
        kind: 'updated',
        actor: 'agent-b',
        model: 'model-two',
        at: t(20),
        changes: { status: 'in_progress', assignee: 'agent-b', assigneeModel: 'model-two', startedAt: t(20) },
      },
      {
        version: 2,
        kind: 'commented',
        actor: 'agent-b',
        model: null,
        at: t(25),
        changes: { commentId: 'k-0001', text: 'Started on the feed.' },
      },
      { version: 3, kind: 'updated', actor: 'noticeos', model: null, at: t(30), changes: { labels: ['backend'] } },
      {
        version: 4,
        kind: 'closed',
        actor: 'agent-b',
        model: null,
        at: t(40),
        changes: {
          status: 'closed',
          close: {
            at: t(40),
            reason: 'Shipped in abc1234.',
            resolution: 'done',
            duplicateOf: null,
            by: null,
            model: null,
          },
        },
      },
      {
        version: 5,
        kind: 'updated',
        actor: 'noticeos',
        model: null,
        at: t(40, 1),
        changes: {
          metadata: expect.objectContaining({ noticeos_card_shipped: expect.objectContaining({ commit: 'abc1234' }) }),
          close: {
            at: t(40),
            reason: 'Shipped in abc1234.',
            resolution: 'done',
            duplicateOf: null,
            by: 'agent-b',
            model: 'model-two',
          },
        },
      },
      // A comment in the same second as a change follows it.
      {
        version: 5,
        kind: 'commented',
        actor: 'owner',
        model: null,
        at: t(40, 1),
        changes: { commentId: 'k-0002', text: 'Thanks!' },
      },
    ]);
  });

  it('marks a reopen, and keeps the earlier close in history', () => {
    const events = eventsOf('acme-t4');
    expect(events.map((event) => event.kind)).toEqual(['created', 'closed', 'reopened', 'updated']);
    expect(events[1]!.changes.close).toMatchObject({ resolution: 'done', by: 'agent-a' });
    expect(events[2]!.changes).toEqual({ status: 'open', close: null });
    expect(events[3]!.changes).toEqual({ dependencies: [{ taskId: 'beta-x1', type: 'related' }] });
  });

  it('records an approval and the task it holds back', () => {
    expect(eventsOf('acme-g1').map((event) => [event.kind, event.changes.status])).toEqual([
      ['created', 'open'],
      ['closed', 'closed'],
    ]);
    expect(eventsOf('acme-t2').map((event) => event.changes.dependencies)).toEqual([
      [],
      [{ taskId: 'acme-g1', type: 'blocks' }],
    ]);
  });

  it("records a decision's choice with its comment", () => {
    const events = eventsOf('acme-d1');
    expect(events.map((event) => event.kind)).toEqual(['created', 'updated', 'commented', 'closed']);
    expect(events[1]!.changes).toEqual({
      choice: { option: 'a', label: 'Carrier one', by: 'owner', at: t(80) },
      labels: [],
    });
    expect(events[3]!.changes.close).toMatchObject({
      resolution: 'done',
      by: 'owner',
      reason: 'Chose (a) Carrier one',
    });
  });

  it("dates a change not yet committed by the task's own update time, and names no committer", () => {
    const events = eventsOf('beta-x2');
    expect(events.at(-1)).toMatchObject({ kind: 'updated', actor: 'unknown', at: t(120), changes: { priority: 1 } });
  });
});
