// The Sort menu of the task pages: the board's groups, Waiting for you and
// the Epics tab read in the order chosen, which the address keeps, and a new
// order reads nothing again from the server.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TasksApi } from '@/api/client';
import { createFixtureTasksApi } from '@/api/fixture';
import { fixtureSeed, type FixtureTask } from '@/api/fixture-data';
import { renderApp } from './render';

/** The ids of a group's rows, in order, once it shows `count` of them. */
async function rowsOf(group: string, count: number, marker = 'data-task-row'): Promise<string[]> {
  return waitFor(() => {
    const region = screen.getByRole('region', { name: group });
    const ids = [...region.querySelectorAll(`[${marker}]`)].map((row) => row.getAttribute(marker) ?? '');
    expect(ids).toHaveLength(count);
    return ids;
  });
}

/** The fixture API, counting the board reads it answers. */
function counting(): { api: TasksApi; reads: () => number } {
  const fixture = createFixtureTasksApi();
  let reads = 0;
  return {
    api: {
      ...fixture,
      board: (...args: Parameters<TasksApi['board']>) => {
        reads += 1;
        return fixture.board(...args);
      },
    },
    reads: () => reads,
  };
}

describe('the Sort menu', () => {
  // The web project's open group: web-b2r6 (Top, "Fix…"), web-k3m9 (High, "Ship…"), web-t5w3 (Low, "Rename…").
  it('keeps each group in its own order until a sort is chosen in the address', async () => {
    renderApp('/tasks?project=web');
    expect(await rowsOf('Open', 3)).toEqual(['web-b2r6', 'web-k3m9', 'web-t5w3']);
  });

  it('reads a group by title either way, as the address names it', async () => {
    const view = renderApp('/tasks?project=web&sort=title');
    expect(await rowsOf('Open', 3)).toEqual(['web-b2r6', 'web-t5w3', 'web-k3m9']);
    view.unmount();
    renderApp('/tasks?project=web&sort=title&dir=desc');
    expect(await rowsOf('Open', 3)).toEqual(['web-k3m9', 'web-t5w3', 'web-b2r6']);
  });

  it('sorts from its menu, in words for each direction, and goes back to the default order', async () => {
    const { api, reads } = counting();
    renderApp('/tasks?project=web', api);
    await rowsOf('Open', 3);
    const before = reads();
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Title' }));
    expect(await rowsOf('Open', 3)).toEqual(['web-b2r6', 'web-t5w3', 'web-k3m9']);
    fireEvent.click(screen.getByRole('button', { name: 'Sort: Title, A to Z' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Z to A' }));
    expect(await rowsOf('Open', 3)).toEqual(['web-k3m9', 'web-t5w3', 'web-b2r6']);
    fireEvent.click(screen.getByRole('button', { name: 'Sort: Title, Z to A' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Default order' }));
    expect(await rowsOf('Open', 3)).toEqual(['web-b2r6', 'web-k3m9', 'web-t5w3']);
    // The board holds every task it shows: a new order reads nothing again.
    expect(reads()).toBe(before);
  });

  it('reads Waiting for you by when each was created, newest first, and oldest first on request', async () => {
    const api = createFixtureTasksApi();
    const view = renderApp('/tasks?view=waiting&sort=created', api);
    const waiting = await waitFor(() => {
      const region = screen.getByRole('region', { name: 'Waiting for you' });
      const ids = [...region.querySelectorAll('[data-inbox-row]')].map((row) => row.getAttribute('data-inbox-row')!);
      expect(ids.length).toBeGreaterThan(2);
      return ids;
    });
    const created = (id: string) => api.state.tasks.find((entry) => entry.id === id)!.createdAt ?? '';
    expect(waiting).toEqual([...waiting].sort((a, b) => created(b).localeCompare(created(a))));
    view.unmount();
    renderApp('/tasks?view=waiting&sort=created&dir=asc', api);
    expect(await rowsOf('Waiting for you', waiting.length, 'data-inbox-row')).toEqual([...waiting].reverse());
  });

  it('reads the Epics tab’s groups in the order chosen, with ties in its own order', async () => {
    const seed = fixtureSeed(Date.now());
    const model = seed.tasks.find((entry) => entry.id === 'web-t5w3') as FixtureTask;
    for (const [id, title] of [
      ['web-e6', 'Plan the spring launch'],
      ['web-e9', 'Archive the old sign-in assets'],
    ] as const)
      seed.tasks.push({ ...model, id, title, issueType: 'epic', labels: [], priority: 2 });
    const view = renderApp('/tasks?project=web&view=epics', createFixtureTasksApi({ seed }));
    // Same priority and the same last change: by id.
    expect(await rowsOf('No tasks', 2, 'data-epic-row')).toEqual(['web-e6', 'web-e9']);
    view.unmount();
    renderApp('/tasks?project=web&view=epics&sort=title', createFixtureTasksApi({ seed }));
    expect(await rowsOf('No tasks', 2, 'data-epic-row')).toEqual(['web-e9', 'web-e6']);
  });
});
