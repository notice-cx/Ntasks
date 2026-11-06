import { focusManager } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { FIXTURE_ACTOR } from '@/api/fixture-data';
import { newQueryClient, SOURCE_URL } from '@/App';
import { NO_FILTERS, readBoard } from '@/lib/board-read';
import { enabledButton, renderApp } from './render';

describe('the board', () => {
  it('opens on the decisions waiting on you, with the counts beside them', async () => {
    renderApp('/tasks');
    expect(await screen.findByRole('heading', { level: 1, name: '4 decisions for you' })).toBeTruthy();
    expect(screen.getByText('1 needs your approval · 11 open tasks')).toBeTruthy();
    const answer = document.querySelector('[data-page-answer]') as HTMLElement;
    expect(within(answer).getByText('Urgent').nextElementSibling?.textContent).toBe('4');
    expect(within(answer).getByText('Blocked').nextElementSibling?.textContent).toBe('3');
    const queue = screen.getByRole('region', { name: 'Your decisions' });
    const rows = within(queue)
      .getAllByRole('listitem')
      .filter((row) => row.hasAttribute('data-inbox-row'));
    // Approvals first among equal urgency, then the oldest question.
    expect(rows.map((row) => row.getAttribute('data-inbox-row'))).toEqual([
      'web-g7p2',
      'web-d4x1',
      'docs-r4s9',
      'web-q8n5',
    ]);
    expect(screen.getByText("That's every decision for you.")).toBeTruthy();
  });

  it('lists every other task once, and a decision only in the decisions list', async () => {
    renderApp('/tasks');
    const table = await screen.findByRole('region', { name: 'All tasks' });
    const ids = within(table)
      .getAllByRole('row')
      .flatMap((row) => row.getAttribute('data-task-row') ?? []);
    expect(ids).toContain('web-b2r6');
    expect(ids).not.toContain('web-d4x1');
    expect(ids).not.toContain('web-g7p2');
    // Live work first, by priority: the top-priority bug leads.
    expect(ids[0]).toBe('web-b2r6');
    // An epic is grouping, not a row.
    expect(ids).not.toContain('web-k3m9');
  });

  it('narrows the table by the filters, which are the address', async () => {
    renderApp('/tasks?status=blocked');
    const table = await screen.findByRole('region', { name: 'All tasks' });
    await waitFor(() => {
      const ids = within(table)
        .getAllByRole('row')
        .flatMap((row) => row.getAttribute('data-task-row') ?? []);
      // Blocked by status, and open but waiting on an unfinished task.
      expect(ids.sort()).toEqual(['docs-w8e3', 'web-k3m9.3', 'web-k3m9.4']);
    });
    expect(screen.getByRole('link', { name: 'Clear filters' })).toBeTruthy();
  });

  it('claims a task from its row', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks', api);
    const row = await screen.findByText('Rename the Settings tab to Account');
    fireEvent.click(row);
    fireEvent.click(await enabledButton('Claim'));
    expect(await screen.findByText('Claimed web-t5w3')).toBeTruthy();
    const task = api.state.tasks.find((entry) => entry.id === 'web-t5w3');
    expect(task?.assignee).toBe(FIXTURE_ACTOR);
    expect(task?.status).toBe('in_progress');
  });

  it('says which project could not be read, and keeps the counts as lower bounds', async () => {
    const api = createFixtureTasksApi();
    const failing = {
      ...api,
      board: async (project: string, signal?: AbortSignal) => {
        if (project === 'docs') throw new Error('The task list: the server answered 503.');
        return api.board(project, signal);
      },
    };
    renderApp('/tasks', failing);
    expect(await screen.findByText(/1 project could not be read/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'at least 3 decisions for you' })).toBeTruthy();
  });

  it('reads the board again after a write, not when the window regains focus', async () => {
    const api = createFixtureTasksApi();
    let reads = 0;
    const counted = {
      ...api,
      board: (project: string, signal?: AbortSignal) => {
        reads += 1;
        return api.board(project, signal);
      },
    };
    // The app's own defaults, under which a read refetches when the window regains focus.
    const queryClient = newQueryClient();
    queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
    renderApp('/tasks', counted, queryClient);
    await screen.findByRole('heading', { level: 1, name: '4 decisions for you' });
    const first = reads;
    expect(first).toBe(2);
    // Older than the board's stale time, then the window loses and regains focus.
    queryClient
      .getQueryCache()
      .findAll({ queryKey: ['tasks'] })
      .forEach((query) => query.setState({ dataUpdatedAt: 0 }));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads).toBe(first);
    focusManager.setFocused(undefined);
  });

  it('counts a project whose latest read failed as not read, even with an earlier read in hand', async () => {
    const api = createFixtureTasksApi();
    const projects = await api.projects();
    const reads = new Map([
      ['web', { data: await api.board('web'), error: null }],
      ['docs', { data: await api.board('docs'), error: new Error('The task list: the server answered 503.') }],
    ]);
    const read = readBoard(projects, reads, NO_FILTERS, Date.now());
    expect(read.complete).toBe(false);
    expect(read.broken.map((project) => project.key)).toEqual(['docs']);
    expect(read.allTasks.some((task) => task.project === 'docs')).toBe(false);
  });

  it('links to its source code on every page', async () => {
    for (const path of ['/tasks', '/tasks/web-b2r6', '/tasks/focus', '/nowhere']) {
      const { unmount } = renderApp(path);
      expect(screen.getByRole('link', { name: 'Source code' }).getAttribute('href')).toBe(SOURCE_URL);
      unmount();
    }
  });
});
