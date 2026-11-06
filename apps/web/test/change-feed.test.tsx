import { focusManager } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { CHANGE_POLL_MS } from '@/hooks/useChangeFeed';
import { renderApp } from './render';

/** The fixture API, counting each project's board reads and each feed poll's starting point. */
function counted() {
  const api = createFixtureTasksApi();
  const boardReads = new Map<string, number>();
  const pollsAfter: number[] = [];
  const wrapped = {
    ...api,
    board: (project: string, signal?: AbortSignal) => {
      boardReads.set(project, (boardReads.get(project) ?? 0) + 1);
      return api.board(project, signal);
    },
    changes: (after: number, signal?: AbortSignal) => {
      pollsAfter.push(after);
      return api.changes(after, signal);
    },
  };
  return { api, wrapped, boardReads, pollsAfter };
}

async function waitOnePoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CHANGE_POLL_MS + 10);
  });
}

describe('the change feed', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it("starts from the board's own position, not from the start of the history", async () => {
    const { api, wrapped, pollsAfter } = counted();
    await api.comment('web-b2r6', 'web', 'An earlier change');
    renderApp('/tasks', wrapped);
    await screen.findByRole('heading', { level: 1, name: '4 decisions for you' });
    await waitFor(() => expect(pollsAfter.length).toBeGreaterThan(0));
    expect(pollsAfter[0]).toBe(1);
  });

  it('reads no board when a poll finds nothing', async () => {
    const { wrapped, boardReads, pollsAfter } = counted();
    renderApp('/tasks', wrapped);
    await screen.findByRole('heading', { level: 1, name: '4 decisions for you' });
    await waitFor(() => expect(pollsAfter.length).toBe(1));
    const before = new Map(boardReads);
    await waitOnePoll();
    await waitOnePoll();
    expect(pollsAfter.length).toBe(3);
    expect(boardReads).toEqual(before);
  });

  it("shows an agent's change within one poll, reading only that project's board again", async () => {
    const { api, wrapped, boardReads } = counted();
    renderApp('/tasks', wrapped);
    await screen.findByText('Rename the Settings tab to Account');
    const docsReads = boardReads.get('docs');
    // Another sender changes a task while the board is open.
    await api.updateTask('web-t5w3', 'web', { title: 'Rename the Settings tab to Profile' });
    await waitOnePoll();
    expect(await screen.findByText('Rename the Settings tab to Profile')).toBeTruthy();
    expect(boardReads.get('web')).toBe(2);
    expect(boardReads.get('docs')).toBe(docsReads);
  });

  it('asks nothing while the page is hidden', async () => {
    const { wrapped, pollsAfter } = counted();
    renderApp('/tasks', wrapped);
    await screen.findByRole('heading', { level: 1, name: '4 decisions for you' });
    await waitFor(() => expect(pollsAfter.length).toBe(1));
    focusManager.setFocused(false);
    await waitOnePoll();
    await waitOnePoll();
    expect(pollsAfter.length).toBe(1);
  });

  it('keeps an open task page current too', async () => {
    const { api, wrapped } = counted();
    renderApp('/tasks/web-t5w3', wrapped);
    await screen.findByRole('heading', { level: 1, name: 'Rename the Settings tab to Account' });
    await api.updateTask('web-t5w3', 'web', { title: 'Rename the Settings tab to Profile' });
    await waitOnePoll();
    expect(await screen.findByRole('heading', { level: 1, name: 'Rename the Settings tab to Profile' })).toBeTruthy();
  });
});
