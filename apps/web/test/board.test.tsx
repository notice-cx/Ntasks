import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { FIXTURE_ACTOR } from '@/api/fixture-data';
import { SOURCE_URL } from '@/App';
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
    const rows = within(queue).getAllByRole('listitem').filter((row) => row.hasAttribute('data-inbox-row'));
    // Approvals first among equal urgency, then the oldest question.
    expect(rows.map((row) => row.getAttribute('data-inbox-row'))).toEqual(['web-g7p2', 'web-d4x1', 'docs-r4s9', 'web-q8n5']);
    expect(screen.getByText("That's every decision for you.")).toBeTruthy();
  });

  it('lists every other task once, and a decision only in the decisions list', async () => {
    renderApp('/tasks');
    const table = await screen.findByRole('region', { name: 'All tasks' });
    const ids = within(table).getAllByRole('row').flatMap((row) => row.getAttribute('data-task-row') ?? []);
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
      const ids = within(table).getAllByRole('row').flatMap((row) => row.getAttribute('data-task-row') ?? []);
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
    const failing = { ...api, board: async (project: string, signal?: AbortSignal) => {
      if (project === 'docs') throw new Error('The task list: the server answered 503.');
      return api.board(project, signal);
    } };
    renderApp('/tasks', failing);
    expect(await screen.findByText(/1 project could not be read/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'at least 3 decisions for you' })).toBeTruthy();
  });

  it('links to its source code on every page', async () => {
    for (const path of ['/tasks', '/tasks/web-b2r6', '/tasks/focus', '/nowhere']) {
      const { unmount } = renderApp(path);
      expect(screen.getByRole('link', { name: 'Source code' }).getAttribute('href')).toBe(SOURCE_URL);
      unmount();
    }
  });
});
