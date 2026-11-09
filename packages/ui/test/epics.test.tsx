import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { fixtureSeed, type FixtureTask } from '@/api/fixture-data';
import { byEpic, readEpics, type EpicSummary } from '@/lib/epics';
import type { BoardTask } from '@/lib/task-model';
import { sinceDay } from '@/routes/tasks/epics-view';
import { renderApp } from './render';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-09T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function task(id: string, fields: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    project: 'web',
    title: id,
    status: 'open',
    priority: 2,
    issueType: 'task',
    assignee: null,
    updatedAt: ago(3 * DAY),
    closedAt: null,
    createdAt: ago(9 * DAY),
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
    ...fields,
  } as BoardTask;
}

const epic = (id: string, fields: Partial<BoardTask> = {}) => task(id, { issueType: 'epic', ...fields });
const closed = (id: string, fields: Partial<BoardTask> = {}) =>
  task(id, { status: 'closed', closedAt: ago(DAY), updatedAt: ago(DAY), resolution: 'done', ...fields });

/**
 * Three epics deep, an empty epic, an epic with every task done, one that
 * has not moved, an epic closed this week and tasks in no epic. The server's
 * counts are each epic's direct children, closed and in all, including the
 * closes older than the board's week that `tasks` does not hold.
 */
function project() {
  const tasks = [
    epic('web-e1', { priority: 1, updatedAt: ago(5 * DAY) }),
    closed('web-e1.a', { parent: 'web-e1' }),
    task('web-e1.b', { parent: 'web-e1' }),
    epic('web-e1.1', { parent: 'web-e1' }),
    task('web-e1.1.a', { parent: 'web-e1.1', labels: ['human'] }),
    task('web-e1.1.b', { parent: 'web-e1.1', status: 'blocked', ready: false }),
    epic('web-e1.1.1', { parent: 'web-e1.1' }),
    task('web-e1.1.1.a', { parent: 'web-e1.1.1', status: 'in_progress', updatedAt: ago(HOUR) }),
    epic('web-e2'),
    epic('web-e3'),
    epic('web-e4', { priority: 3 }),
    task('web-e4.a', { parent: 'web-e4' }),
    closed('web-e5', { issueType: 'epic', closedAt: ago(2 * DAY) }),
    task('web-x1'),
    closed('web-x2'),
    task('web-x3', { parent: 'web-x1' }),
  ];
  return {
    tasks,
    closedSince: ago(7 * DAY),
    epicProgress: new Map([
      ['web-e1', { closed: 2, total: 4 }],
      ['web-e1.1', { closed: 0, total: 3 }],
      ['web-e1.1.1', { closed: 1, total: 2 }],
      ['web-e2', { closed: 0, total: 0 }],
      ['web-e3', { closed: 2, total: 2 }],
      ['web-e4', { closed: 0, total: 1 }],
    ]),
  };
}

const read = () => {
  const source = project();
  return readEpics(source, new Map(source.tasks.map((entry) => [entry.id, entry.status])), new Set());
};

describe("a project's epics", () => {
  it('count the tasks of their sub-epics, all the way down, in place of the sub-epics themselves', () => {
    const { byId } = read();
    const deepest = byId.get('web-e1.1.1') as EpicSummary;
    expect(deepest.progress).toEqual({ done: 1, total: 2 });
    expect(deepest.open).toMatchObject({ inProgress: 1, waiting: 0 });

    const middle = byId.get('web-e1.1') as EpicSummary;
    // Its own two tasks, and web-e1.1.1's two in place of web-e1.1.1 itself.
    expect(middle.progress).toEqual({ done: 1, total: 4 });
    expect(middle.open).toEqual({ waiting: 1, inProgress: 1, open: 0, blocked: 1, parked: 0 });

    const top = byId.get('web-e1') as EpicSummary;
    // web-e1.a, an older close, web-e1.b, and web-e1.1's four.
    expect(top.progress).toEqual({ done: 3, total: 7 });
    expect(top.open).toEqual({ waiting: 1, inProgress: 1, open: 1, blocked: 1, parked: 0 });
    expect(top.doneThisWeek).toBe(1);
    expect(top.subEpics.map((sub) => sub.id)).toEqual(['web-e1.1']);
    expect(top.lastChangedAt).toBe(ago(HOUR));
  });

  it('fall in one group each: waiting for you, moving, not moving, every task done, no tasks', () => {
    const { byId, epics } = read();
    const state = (id: string) => byId.get(id)?.state;
    expect(state('web-e1')).toBe('waiting');
    expect(state('web-e1.1')).toBe('waiting');
    expect(state('web-e1.1.1')).toBe('moving');
    expect(state('web-e2')).toBe('empty');
    expect(state('web-e3')).toBe('finished');
    expect(state('web-e4')).toBe('still');
    // Sub-epics sit under their parents, not at the top.
    expect(epics.map((summary) => summary.id)).toEqual(['web-e1', 'web-e2', 'web-e3', 'web-e4']);
  });

  it('keep the epics closed this week and the tasks in no open epic apart', () => {
    const result = read();
    expect(result.closed.map((entry) => entry.id)).toEqual(['web-e5']);
    expect(result.byId.has('web-e5')).toBe(false);
    // web-x3's parent is a task, not an epic.
    expect(result.loose.open).toMatchObject({ open: 2 });
    expect(result.loose.doneThisWeek).toBe(1);
    expect(result.since).toBe(ago(7 * DAY));
  });

  it('have no progress when the server sent no counts, and still fall in a group', () => {
    const source = { ...project(), epicProgress: new Map() };
    const result = readEpics(source, new Map(), new Set());
    expect(result.byId.get('web-e4')?.progress).toBeNull();
    expect(result.byId.get('web-e4')?.state).toBe('still');
    expect(result.byId.get('web-e2')?.state).toBe('empty');
  });

  it('survive a parent chain that loops', () => {
    const tasks = [
      epic('web-a', { parent: 'web-b' }),
      epic('web-b', { parent: 'web-a' }),
      task('web-a.1', { parent: 'web-a' }),
    ];
    const result = readEpics({ tasks, closedSince: null, epicProgress: new Map() }, new Map(), new Set());
    expect([...result.byId.keys()].sort()).toEqual(['web-a', 'web-b']);
    expect(result.epics.length).toBeGreaterThan(0);
  });
});

describe('tasks under their epics', () => {
  it('keep the order of their first tasks, with the tasks in no epic last', () => {
    const { byId } = read();
    const e1 = byId.get('web-e1') as EpicSummary;
    const e4 = byId.get('web-e4') as EpicSummary;
    const parentOf: Record<string, EpicSummary | null> = { t1: e4, t2: null, t3: e1, t4: e4 };
    const sections = byEpic(['t1', 't2', 't3', 't4'], (id) => parentOf[id] ?? null);
    expect(sections.map((section) => [section.epic?.id ?? null, section.tasks])).toEqual([
      ['web-e4', ['t1', 't4']],
      ['web-e1', ['t3']],
      [null, ['t2']],
    ]);
  });
});

/** The fixture with epics of every group in the web project. */
function epicSeed() {
  const seed = fixtureSeed(Date.now());
  const model = seed.tasks.find((entry) => entry.id === 'web-t5w3') as FixtureTask;
  const at = (ms: number) => new Date(Date.now() - ms).toISOString();
  const add = (id: string, title: string, fields: Partial<FixtureTask> = {}) =>
    seed.tasks.push({ ...model, id, title, labels: [], priority: 2, ...fields });
  add('web-e5', 'Rebuild the account settings', { issueType: 'epic' });
  add('web-e5.1', 'Move billing into settings', { issueType: 'epic', parent: 'web-e5' });
  add('web-e5.1.1', 'Choose where the invoices live', { parent: 'web-e5.1', labels: ['human'] });
  add('web-e5.2', 'Draw the settings page', {
    parent: 'web-e5',
    status: 'closed',
    resolution: 'done',
    closedAt: at(20 * DAY),
    updatedAt: at(20 * DAY),
  });
  add('web-e6', 'Plan the spring launch', { issueType: 'epic' });
  add('web-e7', 'Clean up the old icons', { issueType: 'epic' });
  add('web-e7.1', 'Remove the unused icons', {
    parent: 'web-e7',
    status: 'closed',
    resolution: 'done',
    closedAt: at(20 * DAY),
    updatedAt: at(20 * DAY),
  });
  return seed;
}

/** The ids of the epic lines in a group of the Epics view, in order. */
async function epicRows(name: string): Promise<string[]> {
  const region = await screen.findByRole('region', { name });
  return [...region.querySelectorAll('[data-epic-row]')].map((row) => row.getAttribute('data-epic-row') ?? '');
}

describe('the Epics tab', () => {
  it('is offered only while one project is in view', async () => {
    renderApp('/tasks', createFixtureTasksApi({ seed: epicSeed() }));
    const views = await screen.findByRole('group', { name: 'View' });
    expect(within(views).queryByRole('button', { name: 'Epics' })).toBeNull();
  });

  it("opens from the project's task page and lists its epics by group", async () => {
    renderApp('/tasks?project=web', createFixtureTasksApi({ seed: epicSeed() }));
    const views = await screen.findByRole('group', { name: 'View' });
    fireEvent.click(await within(views).findByRole('button', { name: 'Epics' }));
    expect(within(views).getByRole('button', { name: 'Epics' }).getAttribute('aria-pressed')).toBe('true');
    expect(await epicRows('Waiting for you')).toEqual(['web-e5']);
    expect(await epicRows('Moving')).toEqual(['web-k3m9']);
    expect(await epicRows('Every task done')).toEqual(['web-e7']);
    expect(await epicRows('No tasks')).toEqual(['web-e6']);
    // The Filter menu's filters narrow tasks, so the view leaves it out.
    expect(screen.queryByRole('button', { name: /^Filter/ })).toBeNull();
  });

  it('shows each epic’s counts, and its sub-epics on request', async () => {
    renderApp('/tasks?project=web&view=epics', createFixtureTasksApi({ seed: epicSeed() }));
    await epicRows('Moving');
    const moving = document.querySelector('[data-epic-row="web-k3m9"]') as HTMLElement;
    // web-k3m9.1 is done of four; web-k3m9.3 and .4 wait on other tasks.
    expect(within(moving).getByLabelText('1 of 4 done')).toBeTruthy();
    expect(within(moving).getByLabelText('2 blocked')).toBeTruthy();
    expect(moving.querySelector('[data-epic-week]')?.textContent).toBe('+1 this week');

    const waiting = document.querySelector('[data-epic-row="web-e5"]') as HTMLElement;
    // web-e5.2, closed before this week, counts as done; web-e5.1.1 waits for you through the sub-epic.
    expect(within(waiting).getByLabelText('1 of 2 done')).toBeTruthy();
    expect(within(waiting).getByLabelText('1 waiting for you')).toBeTruthy();
    expect(document.querySelector('[data-epic-row="web-e5.1"]')).toBeNull();
    fireEvent.click(within(waiting).getByRole('button', { name: 'Show the sub-epics of web-e5' }));
    expect(await epicRows('Waiting for you')).toEqual(['web-e5', 'web-e5.1']);

    const loose = (await screen.findByRole('region', { name: 'No epic' })).querySelector('[data-epic-row="none"]');
    expect(loose?.textContent).toMatch(/open tasks in no epic/);

    fireEvent.click(within(waiting).getByRole('link', { name: 'Rebuild the account settings' }));
    expect(await screen.findByRole('heading', { name: 'Rebuild the account settings' })).toBeTruthy();
  });

  it('narrows to the epics whose id or title holds the search, sub-epics included', async () => {
    renderApp('/tasks?project=web&view=epics&q=billing', createFixtureTasksApi({ seed: epicSeed() }));
    expect(await epicRows('Waiting for you')).toEqual(['web-e5.1']);
    expect(screen.queryByRole('region', { name: 'Moving' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'No epic' })).toBeNull();
  });

  it('says so when no epic matches the search', async () => {
    renderApp('/tasks?project=web&view=epics&q=nothing-like-this', createFixtureTasksApi({ seed: epicSeed() }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear search' }));
    expect(await epicRows('Moving')).toEqual(['web-k3m9']);
  });

  it('counts the whole project when the address holds a filter by custom field', async () => {
    renderApp('/tasks?project=web&view=epics&field.area=Email', createFixtureTasksApi({ seed: epicSeed() }));
    expect(await epicRows('Moving')).toEqual(['web-k3m9']);
    const moving = document.querySelector('[data-epic-row="web-k3m9"]') as HTMLElement;
    expect(within(moving).getByLabelText('1 of 4 done')).toBeTruthy();
    expect(within(moving).getByLabelText('2 blocked')).toBeTruthy();
  });

  it('names the first day of the week as the server names it, whatever the time zone', () => {
    // A day alone, as the server sends it, is that calendar day, not the UTC midnight before it.
    expect(sinceDay('2026-11-02', NOW)).toBe('Nov 2');
    expect(sinceDay(null, NOW)).toBeNull();
    expect(sinceDay('not a day', NOW)).toBeNull();
  });

  it('falls back to the task list when the project leaves the address', async () => {
    renderApp('/tasks?view=epics', createFixtureTasksApi({ seed: epicSeed() }));
    expect(await screen.findByRole('region', { name: 'In progress' })).toBeTruthy();
    expect(document.querySelector('[data-epics-view]')).toBeNull();
  });
});
