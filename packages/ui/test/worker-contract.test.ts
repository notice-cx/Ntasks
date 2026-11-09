import type { JsonObject, Task } from '@ntasks/domain';
import { describe, expect, it } from 'vitest';
import type { LiveTask, LiveTasksPayload, TaskChoices } from '@/api/types';
import { NO_FILTERS, readBoard } from '@/lib/board-read';
import { claimedModel, closeAttribution, deliveryWait, inboxAsk } from '@/lib/task-model';
// The Worker's own code for a task as the web app reads it, so this test
// fails when the two drift apart.
import { webTask } from '../../../workers/api/src/views.ts';

const NOW = '2026-11-06T12:00:00.000Z';

/** What reaches the browser: the Worker's answer, sent as JSON and parsed back. */
function overTheWire(tasks: readonly Task[]): LiveTask[] {
  return JSON.parse(JSON.stringify(tasks.map(webTask))) as LiveTask[];
}

function task(fields: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    projectId: 'p-web',
    parentId: null,
    type: 'task',
    awaitType: null,
    steps: null,
    status: 'open',
    priority: 2,
    description: '',
    acceptance: '',
    notes: '',
    design: '',
    estimateMinutes: null,
    assignee: null,
    assigneeModel: null,
    assigneeFor: null,
    work: {},
    lastActivityAt: null,
    labels: [],
    dependencies: [],
    dependents: [],
    externalLinks: [],
    fields: {},
    ready: true,
    deferUntil: null,
    dueAt: null,
    choices: null,
    choice: null,
    metadata: {},
    commentCount: 0,
    filedBy: 'agent-one',
    filedModel: null,
    close: null,
    delivery: null,
    version: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    startedAt: null,
    ...fields,
  };
}

const CHOICES: JsonObject = {
  question: 'Which sign-in methods should the page offer?',
  options: [
    { key: 'a', label: 'Email link only', recommended: true },
    { key: 'b', label: 'Password only' },
  ],
};

describe("the Worker's task answers", () => {
  it('draw the board: decisions, rows and blocked work', () => {
    const tasks = [
      task({
        id: 'web-g1',
        title: 'Gate: human',
        type: 'gate',
        awaitType: 'human',
        description: 'Reason: Approve the release',
      }),
      task({
        id: 'web-d1',
        title: 'Choose the sign-in methods',
        type: 'decision',
        labels: ['human'],
        choices: CHOICES,
      }),
      task({
        id: 'web-w1',
        title: 'Send the page live',
        ready: false,
        dependencies: [{ taskId: 'web-g1', type: 'blocks', title: 'Gate: human', status: 'open' }],
      }),
      task({
        id: 'web-c1',
        title: 'Fix the link',
        status: 'in_progress',
        assignee: 'agent-two',
        assigneeModel: 'example-model',
      }),
    ];
    const payload: LiveTasksPayload = {
      project: 'web',
      prefix: 'web',
      repo: '',
      readAt: NOW,
      closedSince: '2026-10-30T12:00:00.000Z',
      tasks: overTheWire(tasks),
      epics: [],
      actors: [],
    };
    const read = readBoard(
      [{ projectId: 'p-web', logicalKey: 'web', displayName: 'Example web app', prefix: 'web' }],
      new Map([['web', { data: payload, error: null, fetchedAt: Date.parse(NOW) }]]),
      NO_FILTERS,
    );
    // A gate's ask is its reason, and it is the one question for the task it holds.
    expect(read.inbox.map((row) => [row.id, row.title, inboxAsk(row)])).toEqual([
      ['web-g1', 'Approve the release', 'approve'],
      ['web-d1', 'Choose the sign-in methods', 'choose'],
    ]);
    expect((read.inbox[1]?.choices as TaskChoices | null)?.options.map((option) => option.key)).toEqual(['a', 'b']);
    expect(read.rows.map((row) => row.id).sort()).toEqual(['web-c1', 'web-w1']);
    expect(read.totals.blocked).toBe(1);
    expect(claimedModel(read.rows.find((row) => row.id === 'web-c1')!)).toBe('example-model');
  });

  it('say who closed a task when the Worker sends it, and what the close was', () => {
    const [answer] = overTheWire([
      task({
        id: 'web-x1',
        title: 'Remove the old page',
        status: 'closed',
        close: {
          at: NOW,
          reason: 'Not needed after the redesign',
          resolution: 'no-longer-needed',
          duplicateOf: null,
          by: 'Example Owner',
          model: 'example-model',
          link: null,
          acceptance: null,
        },
      }),
    ]);
    expect(answer).toMatchObject({
      closedAt: NOW,
      resolution: 'no-longer-needed',
      closeReason: 'Not needed after the redesign',
    });
    expect(answer ? closeAttribution(answer) : null).toEqual({ by: 'Example Owner', model: 'example-model' });
  });

  it("say where a closed task's change is, and so what it waits for", () => {
    const close = {
      at: NOW,
      reason: 'Shipped.',
      resolution: 'done',
      duplicateOf: null,
      by: 'agent-one',
      model: null,
      link: null,
      acceptance: null,
    } as const;
    const delivery = {
      stage: 'merged',
      commit: 'abc1234',
      pullRequest: 'https://github.com/example/web/pull/7',
      mergeCommit: 'def5678',
      builtAt: NOW,
      mergedAt: NOW,
      liveAt: null,
    } as const;
    const [answer] = overTheWire([task({ id: 'web-x2', title: 'Ship the form', status: 'closed', close, delivery })]);
    expect(answer?.delivery).toEqual(delivery);
    expect(answer ? [deliveryWait(answer, true), deliveryWait(answer, false)] : null).toEqual(['deploy', null]);
  });

  it('say which work closed as done shows no proof, and the link that proves the rest', () => {
    const close = {
      at: NOW,
      reason: 'Done.',
      resolution: 'done',
      duplicateOf: null,
      by: 'agent-one',
      model: null,
      acceptance: null,
    } as const;
    const link = 'https://docs.example.com/runbook';
    const [unproven, linked, decided] = overTheWire([
      task({ id: 'web-x3', title: 'Write the runbook', status: 'closed', close: { ...close, link: null } }),
      task({ id: 'web-x4', title: 'Write the guide', status: 'closed', close: { ...close, link } }),
      task({ id: 'web-x5', title: 'Pick a font', type: 'decision', status: 'closed', close: { ...close, link: null } }),
    ]);
    expect([unproven?.proof, linked?.proof, decided?.proof]).toEqual(['none', null, null]);
    expect(linked?.closeLink).toBe(link);
  });
});
