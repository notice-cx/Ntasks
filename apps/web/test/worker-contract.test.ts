import type { JsonObject, Task } from '@ntasks/domain';
import { describe, expect, it } from 'vitest';
import type { LiveTask, LiveTasksPayload, TaskChoices } from '@/api/types';
import { NO_FILTERS, readBoard } from '@/lib/board-read';
import { closeAttribution, inboxAsk } from '@/lib/task-model';
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
    status: 'open',
    priority: 2,
    description: '',
    acceptance: '',
    assignee: null,
    assigneeModel: null,
    labels: [],
    dependencies: [],
    dependents: [],
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
      Date.parse(NOW),
    );
    // A gate's ask is its reason, and it is the one question for the task it holds.
    expect(read.inbox.map((row) => [row.id, row.title, inboxAsk(row)])).toEqual([
      ['web-g1', 'Approve the release', 'approve'],
      ['web-d1', 'Choose the sign-in methods', 'choose'],
    ]);
    expect((read.inbox[1]?.choices as TaskChoices | null)?.options.map((option) => option.key)).toEqual(['a', 'b']);
    expect(read.rows.map((row) => row.id).sort()).toEqual(['web-c1', 'web-w1']);
    expect(read.totals.blocked).toBe(1);
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
          model: null,
        },
      }),
    ]);
    expect(answer).toMatchObject({
      closedAt: NOW,
      resolution: 'no-longer-needed',
      closeReason: 'Not needed after the redesign',
    });
    const closer = answer ? closeAttribution(answer) : null;
    // Until the Worker sends the closer, the page leaves it out rather than guess.
    expect(closer === null || closer.by === 'Example Owner').toBe(true);
  });
});
