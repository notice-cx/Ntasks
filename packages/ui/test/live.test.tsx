import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { fixtureSeed, type FixtureTask } from '@/api/fixture-data';
import { activeNow, activityOf, liveGroups } from '@/lib/live';
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
  it('is active within the hour, quiet until the threshold and stalled from it on', () => {
    expect(activityOf(ago(HOUR - 1), NOW, DAY)).toBe('active');
    expect(activityOf(ago(HOUR), NOW, DAY)).toBe('quiet');
    expect(activityOf(ago(DAY - 1), NOW, DAY)).toBe('quiet');
    expect(activityOf(ago(DAY), NOW, DAY)).toBe('stalled');
    // A shorter threshold stalls work sooner.
    expect(activityOf(ago(5 * HOUR), NOW, 4 * HOUR)).toBe('stalled');
  });

  it('is stalled when nothing is recorded or the time cannot be read', () => {
    expect(activityOf(null, NOW, DAY)).toBe('stalled');
    expect(activityOf(undefined, NOW, DAY)).toBe('stalled');
    expect(activityOf('not a time', NOW, DAY)).toBe('stalled');
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
      DAY,
    );
    expect(ids(groups.active)).toEqual(['web-2', 'web-1']);
    expect(ids(groups.quiet)).toEqual(['web-3']);
    expect(ids(groups.stalled)).toEqual(['web-6', 'web-5', 'web-4']);
  });
});

/** The ids of the rows in a group of the Live page, in order. */
async function liveRows(name: 'Active' | 'Quiet' | 'Stalled'): Promise<string[]> {
  const region = await screen.findByRole('region', { name });
  return [...region.querySelectorAll('[data-live-row]')].map((row) => row.getAttribute('data-live-row') ?? '');
}

describe('the Live page', () => {
  it('groups every task in progress by its holder’s last activity, with what they recorded', async () => {
    renderApp('/tasks/live');
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

  it('moves work between Quiet and Stalled with the threshold chosen, and keeps the choice', async () => {
    const api = createFixtureTasksApi();
    const view = renderApp('/tasks/live', api);
    expect(await liveRows('Stalled')).toEqual(['web-w6n2']);
    fireEvent.click(screen.getByRole('button', { name: /Stalled after 1 day/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: '1 week' }));
    expect(await liveRows('Quiet')).toEqual(['docs-n6j1', 'web-w6n2']);
    expect(screen.queryByRole('region', { name: 'Stalled' })).toBeNull();
    // Showing Stalled changes nothing on the task.
    expect(api.state.tasks.find((entry) => entry.id === 'web-w6n2')?.status).toBe('in_progress');

    view.unmount();
    renderApp('/tasks/live', api);
    expect(await screen.findByRole('button', { name: /Stalled after 1 week/ })).toBeTruthy();
    expect(await liveRows('Quiet')).toEqual(['docs-n6j1', 'web-w6n2']);
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
    renderApp('/tasks/live', createFixtureTasksApi({ seed }));
    expect(await liveRows('Stalled')).toEqual(['web-w6n2', 'web-s1', 'web-s2', 'web-s3', 'web-s4']);
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
    expect(await liveRows('Stalled')).toEqual(['web-w6n2', 'web-s1', 'web-s2', 'web-s3', 'web-s4', 'web-s5', 'web-s6']);
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
  });

  it('links a pull request only when it is a web address, and shows the branch instead', async () => {
    const seed = fixtureSeed(Date.now());
    const held = seed.tasks.find((entry) => entry.id === 'web-k3m9.2') as FixtureTask;
    held.work = { ...held.work, pr: 'javascript:alert(1)' };
    renderApp('/tasks/live', createFixtureTasksApi({ seed }));
    await liveRows('Active');
    const row = document.querySelector('[data-live-row="web-k3m9.2"]') as HTMLElement;
    expect(row.querySelector('[data-live-pr]')).toBeNull();
    expect(row.querySelector('[data-live-branch]')?.textContent).toContain('codex/sign-in-a11y');
  });

  it('says so when nothing is in progress', async () => {
    const seed = fixtureSeed(Date.now());
    seed.tasks = seed.tasks.filter((entry) => entry.status !== 'in_progress');
    renderApp('/tasks/live', createFixtureTasksApi({ seed }));
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
