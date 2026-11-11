import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { fixtureSeed, type FixtureTask } from '@/api/fixture-data';
import { activeNow, activityOf, liveBoard, liveGroups } from '@/lib/live';
import type { BoardTask } from '@/lib/task-model';
import { renderApp } from './render';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-09T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function task(id: string, fields: Partial<BoardTask>): BoardTask {
  return {
    id,
    project: 'web',
    title: id,
    status: 'in_progress',
    priority: 2,
    issueType: 'task',
    assignee: 'agent:claude',
    updatedAt: ago(DAY),
    closedAt: null,
    createdAt: ago(2 * DAY),
    parent: null,
    deferUntil: null,
    description: '',
    acceptance: '',
    labels: [],
    ready: false,
    dependencies: [],
    comments: 0,
    metadata: null,
    startedAt: ago(2 * DAY),
    closeReason: null,
    awaitType: null,
    ...fields,
  } as BoardTask;
}

const ids = (tasks: readonly BoardTask[]) => tasks.map((entry) => entry.id);

describe('how recently a holder worked on a task', () => {
  const after = (lastActivityAt: string | null | undefined, fields: Partial<BoardTask> = {}) =>
    activityOf(task('web-1', { lastActivityAt, ...fields }), NOW);

  it('is active within the hour, quiet until a day and stalled from then on, as the server marks it', () => {
    expect(after(ago(HOUR - 1))).toBe('active');
    expect(after(ago(HOUR))).toBe('quiet');
    expect(after(ago(DAY - 1))).toBe('quiet');
    expect(after(ago(DAY))).toBe('stalled');
  });

  it('follows the server’s stalled when it sends one, whatever the page’s clock says', () => {
    expect(after(ago(5 * 60_000), { stalled: true })).toBe('stalled');
    expect(after(ago(3 * DAY), { stalled: false })).toBe('quiet');
  });

  it('is stalled when nothing is recorded or the time cannot be read, and only while someone holds the task', () => {
    expect(after(null)).toBe('stalled');
    expect(after(undefined)).toBe('stalled');
    expect(after('not a time')).toBe('stalled');
    expect(after(ago(2 * DAY), { assignee: null })).toBe('quiet');
  });

  it('counts as working now only on a task in progress', () => {
    expect(activeNow(task('web-1', { lastActivityAt: ago(60_000) }), NOW)).toBe(true);
    expect(activeNow(task('web-2', { status: 'blocked', lastActivityAt: ago(60_000) }), NOW)).toBe(false);
    expect(activeNow(task('web-3', { lastActivityAt: ago(2 * HOUR) }), NOW)).toBe(false);
  });
});

describe('the Live page’s groups', () => {
  it('hold only tasks in progress, the latest activity first and nothing recorded last', () => {
    const groups = liveGroups(
      [
        task('web-1', { lastActivityAt: ago(40 * 60_000) }),
        task('web-2', { lastActivityAt: ago(5 * 60_000) }),
        task('web-3', { lastActivityAt: ago(3 * HOUR) }),
        task('web-4', { lastActivityAt: null }),
        task('web-5', { lastActivityAt: ago(9 * DAY) }),
        task('web-6', { lastActivityAt: ago(2 * DAY) }),
        task('web-7', { status: 'open', assignee: null, lastActivityAt: null }),
        task('web-8', { status: 'closed', lastActivityAt: ago(60_000) }),
        task('web-9', { status: 'blocked', lastActivityAt: ago(60_000) }),
      ],
      NOW,
    );
    expect(ids(groups.active)).toEqual(['web-2', 'web-1']);
    expect(ids(groups.quiet)).toEqual(['web-3']);
    expect(ids(groups.stalled)).toEqual(['web-6', 'web-5', 'web-4']);
  });
});

describe('the Live board’s columns', () => {
  const closed = (id: string, stage: string, at: number, fields: Partial<BoardTask> = {}) =>
    task(id, {
      status: 'closed',
      closedAt: ago(at),
      delivery: {
        stage,
        commit: null,
        pullRequest: null,
        mergeCommit: null,
        builtAt: ago(at),
        mergedAt: stage === 'built' ? null : ago(at),
        liveAt: stage === 'live' ? ago(at) : null,
      },
      ...fields,
    });

  it('hold work in progress in the list’s order, then closed work by where its change is, the latest first', () => {
    const waitingMerge = closed('web-b1', 'built', 20 * DAY);
    const waitingDeploy = closed('web-m1', 'merged', 3 * HOUR);
    const board = liveBoard(
      [
        task('web-1', { lastActivityAt: ago(3 * HOUR) }),
        task('web-2', { lastActivityAt: null }),
        task('web-3', { lastActivityAt: ago(5 * 60_000) }),
        // The board's own closes, which reach back 7 days; web-m1 is also among them.
        waitingDeploy,
        closed('docs-m2', 'merged', HOUR, { project: 'docs' }),
        closed('web-l1', 'live', 2 * DAY),
        closed('web-l2', 'live', HOUR),
        closed('web-d1', 'live', HOUR, { issueType: 'decision' }),
        closed('web-x1', 'shipped somewhere', HOUR),
        task('web-c1', { status: 'closed', closedAt: ago(HOUR) }),
      ],
      // Waiting for a merge or a deploy, whenever they closed.
      { merge: [waitingMerge], deploy: [waitingDeploy] },
      // The web project goes live by a deploy; the docs project stops at merged.
      (project) => project === 'web',
      NOW,
    );
    expect(ids(board.progress)).toEqual(['web-3', 'web-1', 'web-2']);
    // Built work waits for its merge, and merged work of a project that deploys for its deploy.
    expect(ids(board.shipping)).toEqual(['web-m1', 'web-b1']);
    // Merged is the last stage of a project that does not deploy.
    expect(ids(board.live)).toEqual(['docs-m2', 'web-l2', 'web-l1']);
  });

  it('place a task the board read holds by that read, not by a wait read apart from it', () => {
    const board = liveBoard(
      [closed('web-m1', 'merged', HOUR), task('web-r1', { lastActivityAt: ago(5 * 60_000) })],
      // A delivery read that lags behind: web-m1 merged since, and web-r1 was reopened.
      { merge: [closed('web-m1', 'built', HOUR), closed('web-r1', 'built', DAY)], deploy: [] },
      () => true,
      NOW,
    );
    expect(ids(board.shipping)).toEqual(['web-m1']);
    expect(board.shipping[0]?.delivery?.stage).toBe('merged');
    expect(ids(board.progress)).toEqual(['web-r1']);
  });
});

/** The ids of the cards in a column of the Live board, in order. */
async function boardCards(name: 'In progress' | 'Waiting to ship' | 'Live'): Promise<string[]> {
  const column = await screen.findByRole('region', { name });
  return [...column.querySelectorAll('[data-board-card]')].map((card) => card.getAttribute('data-board-card') ?? '');
}

/** Records each animation the board starts, by the card or mark it moves. */
function recordAnimations() {
  const started: { element: Element; frames: Keyframe[] }[] = [];
  const animate = vi.fn(function (this: Element, frames: Keyframe[]) {
    started.push({ element: this, frames });
    return { onfinish: null, oncancel: null, cancel() {} } as unknown as Animation;
  });
  Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
  return started;
}

/** Answers the reduced-motion query as the system would with that setting on. */
function preferReducedMotion() {
  const matchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    ...matchMedia(query),
    matches: query.includes('prefers-reduced-motion: reduce'),
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = matchMedia;
  };
}

/** Moves web-k3m9.1's change on to Live, as GitHub's report of its merge and deploy would, and reads the boards again. */
async function shipBuiltTask(api: ReturnType<typeof createFixtureTasksApi>, queryClient: QueryClient) {
  const built = api.state.tasks.find((entry) => entry.id === 'web-k3m9.1') as FixtureTask;
  const at = new Date().toISOString();
  built.delivery = { ...built.delivery!, stage: 'live', mergedAt: at, liveAt: at };
  await act(async () => {
    await queryClient.invalidateQueries();
  });
}

describe('the Live board', () => {
  const restore: (() => void)[] = [];
  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
    Reflect.deleteProperty(Element.prototype, 'animate');
  });

  it('opens on the board: work in progress, waiting to ship and live, and List shows the groups', async () => {
    renderApp('/tasks/live');
    expect(await boardCards('In progress')).toEqual(['web-k3m9.2', 'docs-n6j1', 'web-w6n2']);
    expect(await boardCards('Waiting to ship')).toEqual(['web-k3m9.1']);
    // The docs project does not deploy, so its merged work is live.
    expect(await boardCards('Live')).toEqual(['web-j6y4', 'docs-y5u2']);
    const waiting = document.querySelector('[data-board-card="web-k3m9.1"]') as HTMLElement;
    expect(waiting.querySelector('[data-live-context]')?.textContent).toBe('Not merged yet');
    const held = document.querySelector('[data-board-card="web-k3m9.2"]') as HTMLElement;
    expect(within(held).getByRole('link', { name: '#42' }).getAttribute('href')).toBe(
      'https://github.example.com/example/web/pull/42',
    );
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(await liveRows('Active')).toEqual(['web-k3m9.2']);
    expect(document.querySelector('[data-live-board]')).toBeNull();
  });

  it('says which projects’ waiting work could not be read, and reads it again on Retry', async () => {
    const seed = fixtureSeed(Date.now());
    const model = seed.tasks.find((entry) => entry.id === 'web-k3m9.1') as FixtureTask;
    // Closed three weeks ago and still waiting for its merge, so only the read of waiting work holds it.
    const closedAt = new Date(Date.now() - 21 * DAY).toISOString();
    seed.tasks.push({ ...model, id: 'web-old1', title: 'Old built task', closedAt, updatedAt: closedAt });
    const api = createFixtureTasksApi({ seed });
    let failing = true;
    renderApp('/tasks/live', {
      ...api,
      delivery: (project: string, signal?: AbortSignal) =>
        failing ? Promise.reject(new Error('The read timed out.')) : api.delivery(project, signal),
    });
    const banner = await screen.findByRole('alert');
    expect(banner.hasAttribute('data-live-unread')).toBe(true);
    expect(banner.textContent).toContain('Example web app');
    expect(await boardCards('Waiting to ship')).not.toContain('web-old1');
    failing = false;
    fireEvent.click(within(banner).getByRole('button', { name: 'Retry' }));
    await waitFor(async () => expect(await boardCards('Waiting to ship')).toContain('web-old1'));
    expect(document.querySelector('[data-live-unread]')).toBeNull();
  });

  it('names who closed a task only when its close names them', async () => {
    const seed = fixtureSeed(Date.now());
    const live = seed.tasks.find((entry) => entry.id === 'web-j6y4') as FixtureTask;
    Object.assign(live, { metadata: null, closedBy: null, assignee: 'agent:claude' });
    renderApp('/tasks/live', createFixtureTasksApi({ seed }));
    expect(await boardCards('Live')).toContain('web-j6y4');
    const card = document.querySelector('[data-board-card="web-j6y4"]') as HTMLElement;
    expect(within(card).queryByRole('button', { name: 'Claude' })).toBeNull();
  });

  it('shows who holds a task as an icon whose tooltip names them and their model, and says its activity to a screen reader', async () => {
    renderApp('/tasks/live');
    await boardCards('In progress');
    const card = document.querySelector('[data-board-card="web-k3m9.2"]') as HTMLElement;
    expect(within(card).getByText('Active').className).toContain('sr-only');
    expect(within(card).getByText('Example web app').className).toContain('sr-only');
    fireEvent.focus(within(card).getByRole('button', { name: 'Codex' }));
    expect((await screen.findByRole('tooltip')).textContent).toBe('Codex · codex-example');
  });

  it('says a task closed with a commit and no pull request is not pushed yet', async () => {
    const seed = fixtureSeed(Date.now());
    const built = seed.tasks.find((entry) => entry.id === 'web-k3m9.1') as FixtureTask;
    built.delivery = { ...built.delivery!, pullRequest: null };
    renderApp('/tasks/live', createFixtureTasksApi({ seed }));
    expect(await boardCards('Waiting to ship')).toEqual(['web-k3m9.1']);
    const card = document.querySelector('[data-board-card="web-k3m9.1"]') as HTMLElement;
    expect(card.querySelector('[data-live-context]')?.textContent).toBe('Not pushed yet');
  });

  it('shows the latest tasks in a column and counts the rest', async () => {
    const seed = fixtureSeed(Date.now());
    const model = seed.tasks.find((entry) => entry.id === 'web-k3m9.2') as FixtureTask;
    for (let n = 1; n <= 6; n += 1) {
      seed.tasks.push({
        ...model,
        id: `web-a${n}`,
        title: `Held task ${n}`,
        lastActivityAt: new Date(Date.now() - n * 60_000).toISOString(),
      });
    }
    renderApp('/tasks/live', createFixtureTasksApi({ seed }));
    expect(await boardCards('In progress')).toEqual(['web-a1', 'web-a2', 'web-a3', 'web-a4', 'web-a5', 'web-a6']);
    const column = screen.getByRole('region', { name: 'In progress' });
    expect(column.querySelector('[data-live-more]')?.textContent).toBe('3 more');
  });

  it('moves a card to its new column when a read finds its task there, and sends it travelling', async () => {
    const started = recordAnimations();
    const api = createFixtureTasksApi();
    const { queryClient } = renderApp('/tasks/live', api);
    expect(await boardCards('Waiting to ship')).toEqual(['web-k3m9.1']);
    await shipBuiltTask(api, queryClient);
    await waitFor(async () => expect(await boardCards('Live')).toEqual(['web-k3m9.1', 'web-j6y4', 'docs-y5u2']));
    expect(await boardCards('Waiting to ship')).toEqual([]);
    const card = document.querySelector('[data-board-card="web-k3m9.1"]');
    const travel = started.find((entry) => entry.element === card);
    expect(travel?.frames.some((frame) => String(frame.transform).startsWith('translate('))).toBe(true);
  });

  it('names on its card who changed a task and what they did, as the change feed brings it', async () => {
    const api = createFixtureTasksApi();
    const { queryClient } = renderApp('/tasks/live', api);
    expect(await boardCards('In progress')).toContain('web-k3m9.2');
    const card = () => document.querySelector('[data-board-card="web-k3m9.2"]') as HTMLElement;
    expect(card().querySelector('[data-live-label]')).toBeNull();
    await api.comment('web-k3m9.2', 'web', 'The error is announced now');
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['changes'] });
    });
    await waitFor(() => expect(card().querySelector('[data-live-label]')?.textContent).toBe('Example Owner commented'));
  });

  it('with reduced motion, tints a card that changed column and moves nothing', async () => {
    restore.push(preferReducedMotion());
    const started = recordAnimations();
    const api = createFixtureTasksApi();
    const { queryClient } = renderApp('/tasks/live', api);
    expect(await boardCards('Waiting to ship')).toEqual(['web-k3m9.1']);
    await shipBuiltTask(api, queryClient);
    await waitFor(async () => expect(await boardCards('Live')).toContain('web-k3m9.1'));
    const card = document.querySelector('[data-board-card="web-k3m9.1"]') as HTMLElement;
    expect(card.hasAttribute('data-landed')).toBe(true);
    expect(started).toEqual([]);
  });
});

/** The ids of the rows in a group of the Live page, in order. */
async function liveRows(name: 'Active' | 'Quiet' | 'Stalled'): Promise<string[]> {
  const region = await screen.findByRole('region', { name });
  return [...region.querySelectorAll('[data-live-row]')].map((row) => row.getAttribute('data-live-row') ?? '');
}

describe('the Live page', () => {
  it('groups every task in progress by its holder’s last activity, with what they recorded', async () => {
    renderApp('/tasks/live?view=list');
    expect(await liveRows('Active')).toEqual(['web-k3m9.2']);
    expect(await liveRows('Quiet')).toEqual(['docs-n6j1']);
    expect(await liveRows('Stalled')).toEqual(['web-w6n2']);
    const held = document.querySelector('[data-live-row="web-k3m9.2"]') as HTMLElement;
    expect(held.querySelector('[data-live-next]')?.textContent).toContain('Announce the password error');
    expect(within(held).getByRole('link', { name: '#42' }).getAttribute('href')).toBe(
      'https://github.example.com/example/web/pull/42',
    );
    // Without a pull request, the branch stands in.
    const stalled = document.querySelector('[data-live-row="web-w6n2"]') as HTMLElement;
    expect(stalled.querySelector('[data-live-branch]')?.textContent).toContain('claude/sign-in-timing');
    // A row opens its task.
    fireEvent.click(within(held).getByRole('link', { name: 'Check the sign-in form with a screen reader' }));
    expect(await screen.findByRole('heading', { name: 'Check the sign-in form with a screen reader' })).toBeTruthy();
  });

  it('shows a stalled task and changes nothing on it', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/live?view=list', api);
    expect(await liveRows('Stalled')).toEqual(['web-w6n2']);
    expect(api.state.tasks.find((entry) => entry.id === 'web-w6n2')).toMatchObject({ status: 'in_progress' });
  });

  it('shows the most recently stalled first and the rest on request', async () => {
    const seed = fixtureSeed(Date.now());
    const model = seed.tasks.find((entry) => entry.id === 'web-w6n2') as FixtureTask;
    for (let n = 1; n <= 6; n += 1) {
      seed.tasks.push({
        ...model,
        id: `web-s${n}`,
        title: `Stalled task ${n}`,
        lastActivityAt: new Date(Date.now() - (3 + n) * DAY).toISOString(),
      });
    }
    renderApp('/tasks/live?view=list', createFixtureTasksApi({ seed }));
    expect(await liveRows('Stalled')).toEqual(['web-w6n2', 'web-s1', 'web-s2', 'web-s3', 'web-s4']);
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
    expect(await liveRows('Stalled')).toEqual(['web-w6n2', 'web-s1', 'web-s2', 'web-s3', 'web-s4', 'web-s5', 'web-s6']);
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
  });

  it('links a pull request only when it is a web address, and shows the branch instead', async () => {
    const seed = fixtureSeed(Date.now());
    const held = seed.tasks.find((entry) => entry.id === 'web-k3m9.2') as FixtureTask;
    held.work = { ...held.work, pr: 'javascript:alert(1)' };
    renderApp('/tasks/live?view=list', createFixtureTasksApi({ seed }));
    await liveRows('Active');
    const row = document.querySelector('[data-live-row="web-k3m9.2"]') as HTMLElement;
    expect(row.querySelector('[data-live-pr]')).toBeNull();
    expect(row.querySelector('[data-live-branch]')?.textContent).toContain('codex/sign-in-a11y');
  });

  it('puts each task under its epic’s line, with the epic’s progress, and the tasks in no epic last', async () => {
    const seed = fixtureSeed(Date.now());
    const model = seed.tasks.find((entry) => entry.id === 'web-k3m9.2') as FixtureTask;
    const at = (ms: number) => new Date(Date.now() - ms).toISOString();
    seed.tasks.push(
      { ...model, id: 'web-e8', title: 'Speed up the search page', issueType: 'epic', status: 'open', parent: null },
      { ...model, id: 'web-e8.1', title: 'Cache the search results', parent: 'web-e8', lastActivityAt: at(2 * 60_000) },
      { ...model, id: 'web-n1', title: 'Answer the support backlog', parent: null, lastActivityAt: at(5 * 60_000) },
    );
    renderApp('/tasks/live?view=list', createFixtureTasksApi({ seed }));
    const active = await screen.findByRole('region', { name: 'Active' });
    const lines = [...active.querySelectorAll('[data-live-epic], [data-live-row]')].map(
      (line) => line.getAttribute('data-live-epic') ?? line.getAttribute('data-live-row'),
    );
    // The epics in the order of their latest task, then No epic, however recent its tasks.
    expect(lines).toEqual(['web-e8', 'web-e8.1', 'web-k3m9', 'web-k3m9.2', 'none', 'web-n1']);
    const epic = active.querySelector('[data-live-epic="web-k3m9"]') as HTMLElement;
    expect(within(epic).getByLabelText('1 of 4 done')).toBeTruthy();
    expect(within(epic).getByRole('link', { name: 'Ship the new sign-in page' })).toBeTruthy();
    // A group with no task in an epic draws no epic lines.
    const quiet = await screen.findByRole('region', { name: 'Quiet' });
    expect(quiet.querySelector('[data-live-epic]')).toBeNull();
  });

  it('says so when nothing is in progress', async () => {
    const seed = fixtureSeed(Date.now());
    seed.tasks = seed.tasks.filter((entry) => entry.status !== 'in_progress');
    renderApp('/tasks/live?view=list', createFixtureTasksApi({ seed }));
    expect(await screen.findByText('No tasks in progress')).toBeTruthy();
  });

  it('is in the sidebar with the count of active tasks, and L opens it', async () => {
    renderApp('/tasks');
    const link = await screen.findByRole('link', { name: /^Live/ });
    // web-k3m9.2 is the one task in progress written to within the hour.
    expect(await within(link).findByText('1')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'l' });
    expect(await screen.findByRole('heading', { name: 'Live' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Live/ }).getAttribute('aria-current')).toBe('page');
  });
});
