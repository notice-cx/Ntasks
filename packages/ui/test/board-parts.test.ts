import { describe, expect, it } from 'vitest';
import type { LiveTask } from '@/api/types';
import { peopleOf } from '@/components/AppSidebar';
import { groupRows, NO_FILTERS, readBoard } from '@/lib/board-read';
import { isShortcut, statusMarkFor, statusMarkOfStored } from '@/lib/symbols';
import { actorLabel, checklistCount, waitingOn, type BoardTask } from '@/lib/task-model';

function task(fields: Partial<BoardTask>): BoardTask {
  const base: LiveTask = {
    id: 'web-a1',
    title: 'A task',
    status: 'open',
    priority: 2,
    issueType: 'task',
    assignee: null,
    updatedAt: '2026-11-01T00:00:00Z',
    closedAt: null,
    createdAt: '2026-11-01T00:00:00Z',
    parent: null,
    deferUntil: null,
    description: '',
    acceptance: '',
    labels: [],
    ready: true,
    dependencies: [],
    comments: 0,
    metadata: null,
    startedAt: null,
    closeReason: null,
    awaitType: null,
  };
  return { ...base, project: 'web', ...fields };
}

const blocks = (id: string, status: string | null) => ({ id, type: 'blocks', title: null, status });

describe("an actor's name", () => {
  it('is the name the read gives it, else its display name', () => {
    expect(actorLabel('agent:build-bot', [{ principalId: 'agent:build-bot', displayName: 'Build Bot' }])).toBe(
      'Build Bot',
    );
    expect(actorLabel('agent:build-bot')).toBe('build-bot');
    expect(actorLabel('agent:Claude Code (ntasks)')).toBe('Claude Code');
    expect(actorLabel('service:noticeos/outcome-filer')).toBe('outcome-filer');
    expect(actorLabel('person:agent:x')).toBe('agent:x');
    expect(actorLabel('Example Owner')).toBe('Example Owner');
    expect(actorLabel('service:noticeos')).toBe('noticeos');
  });
});

describe('the facts on a row', () => {
  it('counts a Done when checklist, and nothing for text without boxes', () => {
    expect(checklistCount('- [x] One\n- [ ] Two\n* [X] Three')).toEqual({ done: 2, total: 3 });
    expect(checklistCount('Just words')).toBeNull();
  });

  it('names the tasks a task still waits on, by their latest status', () => {
    const waiting = task({
      dependencies: [
        blocks('web-b1', 'open'),
        blocks('web-b2', 'closed'),
        { ...blocks('web-b3', 'open'), type: 'related' },
      ],
    });
    expect(waitingOn(waiting, new Map())).toEqual(['web-b1']);
    expect(waitingOn(waiting, new Map([['web-b1', 'closed']]))).toEqual([]);
  });

  it('marks a linked task by its stored status alone', () => {
    expect(['open', 'in_progress', 'blocked', 'deferred', 'closed', 'review'].map(statusMarkOfStored)).toEqual([
      'open',
      'in-progress',
      'blocked',
      'parked',
      'done',
      'open',
    ]);
  });
});

describe('the board groups', () => {
  it('put a task a pending approval holds in Blocked, and count only the approval as waiting', () => {
    const approval = task({ id: 'web-g1', issueType: 'gate', awaitType: 'human', ready: false });
    const held = task({ id: 'web-h1', labels: ['human'], dependencies: [blocks('web-g1', 'open')] });
    const project = { projectId: 'p-web', logicalKey: 'web', displayName: 'Example web app', prefix: 'web' };
    const payload = {
      project: 'web',
      prefix: 'web',
      repo: '',
      readAt: '2026-11-06T00:00:00Z',
      tasks: [approval, held],
      epics: [],
    };
    const read = readBoard([project], new Map([['web', { data: payload, error: null }]]), NO_FILTERS);
    expect(read.inbox.map((row) => row.id)).toEqual(['web-g1']);
    expect(read.totals.waiting).toBe(1);
    const groups = groupRows(read.rows, read.statuses, read.held);
    expect(groups.waiting).toEqual([]);
    expect(groups.blocked.map((row) => row.id)).toEqual(['web-h1']);
    expect(statusMarkFor(held, read.statuses, read.held)).toBe('blocked');
  });

  it('put each row in the group its status mark names, keeping their order', () => {
    const rows = [
      task({ id: 'web-1', status: 'in_progress' }),
      task({ id: 'web-2' }),
      task({ id: 'web-3', ready: false, dependencies: [blocks('web-2', null)] }),
      task({ id: 'web-4', status: 'deferred' }),
      task({ id: 'web-5', status: 'closed' }),
      task({ id: 'web-6' }),
    ];
    const groups = groupRows(rows, new Map(rows.map((row) => [row.id, row.status])));
    expect(Object.fromEntries(Object.entries(groups).map(([mark, list]) => [mark, list.map((row) => row.id)]))).toEqual(
      {
        waiting: [],
        'in-progress': ['web-1'],
        open: ['web-2', 'web-6'],
        blocked: ['web-3'],
        parked: ['web-4'],
        done: ['web-5'],
      },
    );
  });
});

describe('the people in the sidebar', () => {
  it('are whoever holds open work, those who worked on a task in progress within the hour first, each once', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    const people = peopleOf(
      [
        task({ id: 'web-1', assignee: 'Example Owner' }),
        task({
          id: 'web-2',
          assignee: 'agent:codex',
          status: 'in_progress',
          assigneeModel: 'codex-example',
          lastActivityAt: '2026-11-09T11:50:00Z',
        }),
        task({ id: 'web-3', assignee: 'agent:codex' }),
        task({ id: 'web-4', assignee: 'agent:claude', status: 'closed' }),
        // In progress, but its holder last wrote to it two days ago.
        task({ id: 'web-5', assignee: 'agent:gemini', status: 'in_progress', lastActivityAt: '2026-11-07T12:00:00Z' }),
      ],
      now,
    );
    expect(people.map((person) => [person.name, person.live, person.model])).toEqual([
      ['Codex', true, 'codex-example'],
      ['Example Owner', false, null],
      ['gemini', false, null],
    ]);
  });
});

describe('a page key', () => {
  const event = { key: 'c', altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false };

  it('is left to a dialog, a menu or a list of options that has focus', () => {
    const root = document.createElement('div');
    root.setAttribute('data-ntasks', '');
    document.body.append(root);
    for (const role of ['dialog', 'menu', 'listbox']) {
      const holder = document.createElement('div');
      holder.setAttribute('role', role);
      const button = document.createElement('button');
      holder.append(button);
      root.append(holder);
      expect(isShortcut({ ...event, target: button }, 'c'), role).toBe(false);
      holder.remove();
    }
    expect(isShortcut({ ...event, target: document.body }, 'c')).toBe(true);
    root.remove();
  });

  it("is the host page's own while one of its controls, outside the app's root, has focus", () => {
    const root = document.createElement('div');
    root.setAttribute('data-ntasks', '');
    const inside = document.createElement('button');
    root.append(inside);
    const host = document.createElement('button');
    document.body.append(root, host);
    expect(isShortcut({ ...event, target: inside }, 'c')).toBe(true);
    expect(isShortcut({ ...event, target: host }, 'c')).toBe(false);
    root.remove();
    host.remove();
  });
});

describe('one agent recorded under several names', () => {
  const spellings = ['claude', 'claude/fable-lead', 'agent:Claude Code (ntasks)', 'service:demo/claude'];
  const held = spellings.map((assignee, index) =>
    task({ id: `web-${index + 1}`, assignee, assigneeModel: index === 2 ? 'claude-opus-5.5' : null }),
  );
  const project = { projectId: 'p-web', logicalKey: 'web', displayName: 'Example web app', prefix: 'web' };
  const reads = new Map([
    [
      'web',
      {
        data: { project: 'web', prefix: 'web', repo: '', readAt: '2026-11-10T00:00:00Z', tasks: held, epics: [] },
        error: null,
      },
    ],
  ]);

  it('is listed once in the sidebar, by its product, with its model by name', () => {
    const people = peopleOf(
      [...held, task({ id: 'web-9', assignee: 'Example Owner' })],
      Date.parse('2026-11-10T12:00:00Z'),
    );
    expect(people.map((person) => [person.name, person.model])).toEqual([
      ['Claude Code', 'Claude Opus 5.5'],
      ['Example Owner', null],
    ]);
  });

  it('is counted once in the assignee filter, and a filter by any of its names keeps all its tasks', () => {
    expect([...readBoard([project], reads, NO_FILTERS).assigneeCounts]).toEqual([['agent:Claude Code', 4]]);
    for (const assignee of ['agent:Claude Code', 'service:demo/claude']) {
      const read = readBoard([project], reads, { ...NO_FILTERS, assignee });
      expect(read.rows.map((row) => row.id).sort()).toEqual(['web-1', 'web-2', 'web-3', 'web-4']);
    }
  });
});
