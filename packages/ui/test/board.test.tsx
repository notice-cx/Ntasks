import { focusManager } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { createFixtureTasksApi } from '@/api/fixture';
import { FIXTURE_ACTOR } from '@/api/fixture-data';
import { newQueryClient } from '@/App';
import { SOURCE_URL } from '@/lib/page-state';
import { NO_FILTERS, readBoard } from '@/lib/board-read';
import { UNDO_WINDOW_MS } from '@/lib/answer-queue';
import { enabledButton, renderApp } from './render';

/** The ids of the rows in a group, in order. */
function rowIds(group: HTMLElement): string[] {
  return [...group.querySelectorAll('[data-task-row]')].map((row) => row.getAttribute('data-task-row') ?? '');
}

const group = (name: string) => screen.findByRole('region', { name });

describe('the board', () => {
  it('opens on what waits for you, most urgent first, then each status in its own group', async () => {
    renderApp('/tasks');
    const waiting = await group('Waiting for you');
    // Approvals first among equal urgency, then the oldest question.
    expect(rowIds(waiting)).toEqual(['web-g7p2', 'web-d4x1', 'docs-r4s9', 'web-q8n5']);
    expect(within(waiting).getByText('4')).toBeTruthy();
    const order = [...document.querySelectorAll('[data-group]')].map((section) => section.getAttribute('data-group'));
    expect(order).toEqual(['waiting', 'in-progress', 'open', 'blocked', 'parked', 'done']);
  });

  it('lists every other task once, in the group its status mark names', async () => {
    renderApp('/tasks');
    const open = await group('Open');
    // Live work by priority: the top-priority bug leads. An epic is a row too, with its progress.
    expect(rowIds(open)[0]).toBe('web-b2r6');
    expect(rowIds(open)).toContain('web-k3m9');
    expect(within(open).getByRole('img', { name: '1 of 4 done' })).toBeTruthy();
    expect(rowIds(await group('In progress')).sort()).toEqual(['docs-n6j1', 'web-k3m9.2', 'web-w6n2']);
    // Blocked by status, and open but waiting on a task that is not closed.
    expect(rowIds(await group('Blocked')).sort()).toEqual(['docs-k8f2', 'docs-w8e3', 'web-k3m9.3', 'web-k3m9.4']);
    const all = [...document.querySelectorAll('[data-group]:not([data-group="waiting"]) [data-task-row]')].map((row) =>
      row.getAttribute('data-task-row'),
    );
    expect(all).not.toContain('web-d4x1');
    expect(all).not.toContain('web-g7p2');
    expect(new Set(all).size).toBe(all.length);
  });

  it('shows on a held task’s row the helper its holder works through and when the holder last wrote to it', async () => {
    renderApp('/tasks');
    const held = (await group('In progress')).querySelector('[data-task-row="web-k3m9.2"]') as HTMLElement;
    expect(held.querySelector('[data-row-helper]')?.textContent).toContain('a11y-check-1');
    expect(held.querySelector('[data-row-activity]')?.textContent).toContain('12m');
    const unheld = (await group('Open')).querySelector('[data-task-row="web-b2r6"]') as HTMLElement;
    expect(unheld.querySelector('[data-row-helper], [data-row-activity]')).toBeNull();
  });

  it('shows on a ready task’s row its estimate, or that it has none', async () => {
    renderApp('/tasks');
    const open = await group('Open');
    const estimate = (section: HTMLElement, id: string) =>
      section.querySelector(`[data-task-row="${id}"] [data-row-estimate]`)?.textContent ?? null;
    expect(estimate(open, 'web-b2r6')).toContain('45m');
    expect(estimate(open, 'web-t5w3')).toBe('No estimate');
    // A task someone holds is past choosing, whatever its estimate.
    expect(estimate(await group('In progress'), 'web-k3m9.2')).toBeNull();
  });

  it('folds Done, and opens it on a press', async () => {
    renderApp('/tasks');
    const done = await group('Done');
    expect(rowIds(done)).toEqual([]);
    fireEvent.click(within(done).getByRole('button', { name: /Done/ }));
    expect(rowIds(done)).toContain('web-h1z8');
  });

  it('shows the view the tabs pick, which is part of the address', async () => {
    renderApp('/tasks');
    await group('Waiting for you');
    const views = screen.getByRole('group', { name: 'View' });
    fireEvent.click(within(views).getByRole('button', { name: 'Active' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Parked' })).toBeNull());
    expect(screen.queryByRole('region', { name: 'Done' })).toBeNull();
    fireEvent.click(within(views).getByRole('button', { name: 'Done' }));
    const done = await group('Done');
    expect(screen.queryByRole('region', { name: 'Waiting for you' })).toBeNull();
    // In the Done view the group is open.
    expect(rowIds(done)).toContain('web-h1z8');
  });

  it('narrows the groups by the filters, which are the address, and shows each one set', async () => {
    renderApp('/tasks?status=blocked');
    const blocked = await group('Blocked');
    await waitFor(() => expect(rowIds(blocked).sort()).toEqual(['docs-k8f2', 'docs-w8e3', 'web-k3m9.3', 'web-k3m9.4']));
    expect(screen.queryByRole('region', { name: 'Open' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear Status: Blocked' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await group('Open')).toBeTruthy();
  });

  it('sets a filter from the Filter menu', async () => {
    renderApp('/tasks');
    await group('Open');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Priority' }), { target: { value: 'top' } });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'In progress' })).toBeNull());
    expect(rowIds(await group('Open'))).toEqual(['web-b2r6']);
    expect(screen.getByRole('button', { name: 'Filter, 1 set' })).toBeTruthy();
  });

  it("filters one project's board by a custom field from the Filter menu, through the server's filter", async () => {
    const api = createFixtureTasksApi();
    const board = vi.spyOn(api, 'board');
    renderApp('/tasks?project=web', api);
    await group('Open');
    fireEvent.click(screen.getByRole('button', { name: 'Filter, 1 set' }));
    const area = await screen.findByRole('combobox', { name: 'Product area' });
    // Each option with how many of the project's tasks hold it.
    expect([...area.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Any',
      'Accessibility · 1',
      'Email · 1',
      'Sign-in · 0',
      'Performance · 0',
    ]);
    expect(screen.queryByRole('combobox', { name: 'Sprint' })).toBeNull();
    fireEvent.change(area, { target: { value: 'Accessibility' } });
    await waitFor(() => expect(rowIds(document.body)).toEqual(['web-k3m9.2']));
    expect(board).toHaveBeenCalledWith('web', expect.anything(), { area: 'Accessibility' });
    expect(screen.queryByRole('region', { name: 'Open' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Filter, 2 set' })).toBeTruthy();
    // The menu's counts stay the whole project's, as for every other filter.
    const project = screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
    expect(project.selectedOptions[0]?.textContent).toBe('Example web app · 12');

    fireEvent.click(screen.getByRole('button', { name: 'Clear Product area: Accessibility' }));
    expect(rowIds(await group('Open'))).toContain('web-b2r6');
  });

  it('reads a filter by a custom field from the address, and drops it when another project is picked', async () => {
    renderApp('/tasks?project=web&field.customer_facing=true');
    await waitFor(() => expect(rowIds(document.body).sort()).toEqual(['web-b2r6', 'web-k3m9.2']));
    expect(screen.getByRole('button', { name: 'Clear Customer facing: Yes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Filter, 2 set' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Project' }), { target: { value: 'docs' } });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Clear Customer facing: Yes' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Clear Project: Example docs' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Customer facing' })).toBeNull();
  });

  it('offers no custom field to filter by while several projects are in view', async () => {
    renderApp('/tasks?field.area=Email');
    await group('Open');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await screen.findByRole('combobox', { name: 'Priority' });
    expect(screen.queryByRole('combobox', { name: 'Product area' })).toBeNull();
    // A filter by one project's field does not narrow a board of several projects.
    expect(screen.queryByRole('button', { name: /Clear Product area/ })).toBeNull();
    expect(rowIds(await group('Open'))).toContain('docs-m2v7');
  });

  it('searches by title or id', async () => {
    renderApp('/tasks');
    await group('Open');
    fireEvent.change(screen.getAllByRole('searchbox', { name: 'Search tasks' })[0] as HTMLElement, {
      target: { value: 'reset link' },
    });
    await waitFor(() => expect(rowIds(document.body)).toEqual(['web-b2r6']));
  });

  it('claims a task from its row', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks', api);
    await group('Open');
    const row = document.querySelector('[data-task-row="web-t5w3"]') as HTMLElement;
    fireEvent.click(await enabledButton('Claim', row));
    expect(await screen.findByText('Claimed web-t5w3')).toBeTruthy();
    const task = api.state.tasks.find((entry) => entry.id === 'web-t5w3');
    expect(task?.assignee).toBe(FIXTURE_ACTOR);
    expect(task?.status).toBe('in_progress');
  });

  describe('the action keys on the row that holds focus', () => {
    /** Puts focus on a row's title, as Tab does, and presses `key` there. */
    async function press(key: string, id = 'web-t5w3'): Promise<HTMLElement> {
      await group('Open');
      const row = document.querySelector(`[data-task-row="${id}"]`) as HTMLElement;
      // The keys wait for the sign-in's permissions, as the row's buttons do.
      await enabledButton('Claim', row);
      const title = within(row).getByRole('link');
      title.focus();
      fireEvent.keyDown(title, { key });
      return row;
    }
    const task = (api: ReturnType<typeof createFixtureTasksApi>, id = 'web-t5w3') =>
      api.state.tasks.find((entry) => entry.id === id);

    it('M claims the task', async () => {
      const api = createFixtureTasksApi();
      renderApp('/tasks', api);
      await press('m');
      await waitFor(() => expect(task(api)?.assignee).toBe(FIXTURE_ACTOR));
    });

    it('A gives the task to someone picked from the people on the board', async () => {
      const api = createFixtureTasksApi();
      renderApp('/tasks', api);
      await press('a');
      const menu = await screen.findByRole('menu', { name: 'Assign web-t5w3 to' });
      fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Codex' }));
      await waitFor(() => expect(task(api)?.assignee).toBe('agent:codex'));
    });

    it('A offers the people holding work the filters hide', async () => {
      renderApp('/tasks?status=open');
      // Codex holds web-k3m9.2, which is in progress.
      await press('a', 'web-b2r6');
      const menu = await screen.findByRole('menu', { name: 'Assign web-b2r6 to' });
      expect(within(menu).getByRole('menuitemradio', { name: 'Codex' })).toBeTruthy();
    });

    it('P sets its priority', async () => {
      const api = createFixtureTasksApi();
      renderApp('/tasks', api);
      await press('p');
      const menu = await screen.findByRole('menu', { name: 'Priority of web-t5w3' });
      fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Top' }));
      await waitFor(() => expect(task(api)?.priority).toBe(0));
    });

    it('Z opens the form that parks it', async () => {
      const api = createFixtureTasksApi();
      renderApp('/tasks', api);
      await press('z');
      fireEvent.change(await screen.findByLabelText(/Park until/), { target: { value: '2030-01-15' } });
      fireEvent.click(screen.getByRole('button', { name: 'Park' }));
      await waitFor(() => expect(task(api)?.deferUntil).toContain('2030-01-15'));
    });

    it('leaves a key typed into the row menu to the menu', async () => {
      const api = createFixtureTasksApi();
      renderApp('/tasks', api);
      await press('p');
      // The menu renders outside the row, but React passes its keys up to the row.
      const menu = await screen.findByRole('menu', { name: 'Priority of web-t5w3' });
      fireEvent.keyDown(within(menu).getByRole('menuitem', { name: 'Back' }), { key: 'm' });
      expect(task(api)?.assignee).toBeNull();
    });

    it('puts focus on the row’s menu button when the menu a key opened closes', async () => {
      renderApp('/tasks');
      const row = await press('a');
      await screen.findByRole('menu', { name: 'Assign web-t5w3 to' });
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await waitFor(() =>
        expect(document.activeElement).toBe(within(row).getByRole('button', { name: 'Actions for web-t5w3' })),
      );
    });

    it('undoes a priority picked from the row’s menu, and says so, after the menu has closed', async () => {
      const api = createFixtureTasksApi();
      renderApp('/tasks', api);
      await press('p');
      fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Top' }));
      await waitFor(() => expect(task(api)?.priority).toBe(0));
      expect(screen.queryByRole('menu')).toBeNull();
      const saved = (await screen.findByText('Saved the priority')).closest('li') as HTMLElement;
      fireEvent.click(within(saved).getByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(task(api)?.priority).toBe(3));
      expect(await screen.findByText('Reverted the priority')).toBeTruthy();
    });
  });

  it('parks a task from its menu, until the date given', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks', api);
    await group('Open');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for web-t5w3' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Park/ }));
    fireEvent.change(await screen.findByLabelText(/Park until/), { target: { value: '2030-01-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Park' }));
    expect(await screen.findByText('Parked web-t5w3 until 2030-01-15')).toBeTruthy();
    expect(api.state.tasks.find((entry) => entry.id === 'web-t5w3')?.deferUntil).toContain('2030-01-15');
  });

  it('closes a task as done from its menu, with its evidence', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks', api);
    await group('Open');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for web-t5w3' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Close as/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Done' }));
    fireEvent.change(await screen.findByLabelText(/Evidence/), { target: { value: 'Renamed in 4d5e6f7.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close task' }));
    expect(await screen.findByText('Closed web-t5w3')).toBeTruthy();
    expect(api.state.tasks.find((entry) => entry.id === 'web-t5w3')?.status).toBe('closed');
  });

  it("copies a task's id from its menu, and says when it could not", async () => {
    renderApp('/tasks');
    await group('Open');
    const copy = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Actions for web-t5w3' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: /Copy id/ }));
    };
    // jsdom has no clipboard, as a page served without HTTPS has none.
    await copy();
    expect(await screen.findByText('Could not copy web-t5w3')).toBeTruthy();
    const writeText = vi.fn().mockRejectedValueOnce(new Error('Denied')).mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      await copy();
      await waitFor(() => expect(screen.getAllByText('Could not copy web-t5w3')).toHaveLength(2));
      await copy();
      expect(await screen.findByText('Copied web-t5w3')).toBeTruthy();
      expect(writeText).toHaveBeenLastCalledWith('web-t5w3');
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('says which project could not be read, and counts only what it could', async () => {
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
    expect(rowIds(await group('Waiting for you'))).toEqual(['web-g7p2', 'web-d4x1', 'web-q8n5']);
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
    await group('Waiting for you');
    const first = reads;
    // The sidebar and the board share one read of each project.
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
    // A write reads the boards again.
    const row = document.querySelector('[data-task-row="web-t5w3"]') as HTMLElement;
    fireEvent.click(await enabledButton('Claim', row));
    await waitFor(() => expect(reads).toBeGreaterThan(first));
  });

  it('counts a project whose latest read failed as not read, even with an earlier read in hand', async () => {
    const api = createFixtureTasksApi();
    const projects = await api.projects();
    const reads = new Map([
      ['web', { data: await api.board('web'), error: null }],
      ['docs', { data: await api.board('docs'), error: new Error('The task list: the server answered 503.') }],
    ]);
    const read = readBoard(projects, reads, NO_FILTERS);
    expect(read.complete).toBe(false);
    expect(read.broken.map((project) => project.key)).toEqual(['docs']);
    expect(read.allTasks.some((task) => task.project === 'docs')).toBe(false);
  });

  it('offers the sign-in page when nobody is signed in', async () => {
    const api = createFixtureTasksApi();
    const signedOut = {
      ...api,
      capabilities: () => Promise.reject(new ApiError('Sign in to see your tasks.', 401, 'sign_in_required')),
      projects: () => Promise.reject(new ApiError('Sign in to see your tasks.', 401, 'sign_in_required')),
    };
    for (const path of ['/tasks', '/tasks/web-b2r6', '/tasks/focus']) {
      const { unmount } = renderApp(path, signedOut);
      expect(await screen.findByText('Sign in to see your tasks')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/sign-in');
      unmount();
    }
  });

  it('offers the sign-in page when the project list reads but a board read is refused', async () => {
    const api = createFixtureTasksApi();
    const expired = {
      ...api,
      board: async (project: string) => {
        if (project === 'docs') throw new ApiError('Sign in to see your tasks.', 401, 'sign_in_required');
        return api.board(project);
      },
    };
    for (const path of ['/tasks', '/tasks/focus']) {
      const { unmount } = renderApp(path, expired);
      expect(await screen.findByText('Sign in to see your tasks')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/sign-in');
      expect(screen.queryByText(/could not be read/)).toBeNull();
      unmount();
    }
  });

  it('links to its source code on every page', async () => {
    for (const path of ['/tasks', '/tasks/web-b2r6', '/tasks/focus', '/tasks/nowhere/else']) {
      const { unmount } = renderApp(path);
      expect((await screen.findByRole('link', { name: 'Source code' })).getAttribute('href')).toBe(SOURCE_URL);
      unmount();
    }
  });
});

describe("the board's search", () => {
  const search = (text: string) =>
    fireEvent.change(screen.getAllByRole('searchbox', { name: 'Search tasks' })[0] as HTMLElement, {
      target: { value: text },
    });

  /** The fixture API with the docs project's board never answering, as a large board still on its way. */
  function docsUnread(api = createFixtureTasksApi()) {
    return {
      ...api,
      board: (project: string, signal?: AbortSignal) =>
        project === 'docs' ? new Promise<never>(() => {}) : api.board(project, signal),
    };
  }

  it('finds and opens a task by its id in a project whose board has not been read', async () => {
    renderApp('/tasks', docsUnread());
    await group('Open');
    expect(document.querySelector('[data-task-row="docs-m2v7"]')).toBeNull();
    search('docs-m2v7');
    const row = await waitFor(() => {
      const found = document.querySelector('[data-task-row="docs-m2v7"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    fireEvent.click(within(row).getByRole('link', { name: /Write the guide to claiming a task/ }));
    expect(await screen.findByRole('heading', { name: 'Write the guide to claiming a task' })).toBeTruthy();
  });

  it('finds words in the description of a task in a project whose board has not been read', async () => {
    renderApp('/tasks', docsUnread());
    await group('Open');
    search('hand back');
    await waitFor(() => expect(rowIds(document.body)).toEqual(['docs-m2v7']));
  });

  it('finds by its id a task closed before the board’s week, and opens Done to show it', async () => {
    const api = createFixtureTasksApi();
    const closed = api.state.tasks.find((task) => task.id === 'web-h1z8')!;
    const longAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();
    api.state.tasks.push({ ...closed, id: 'web-a0b1', title: 'Retire the old pricing page', closedAt: longAgo });
    renderApp('/tasks', api);
    await group('Open');
    search('web-a0b1');
    await waitFor(async () => expect(rowIds(await group('Done'))).toEqual(['web-a0b1']));
  });

  it('says it is searching until the server answers, and when it could not search', async () => {
    const api = createFixtureTasksApi();
    const pending: (() => void)[] = [];
    let failing = false;
    renderApp('/tasks', {
      ...api,
      search: (text: string, signal?: AbortSignal) =>
        failing
          ? Promise.reject(new Error('The search: the server answered 503.'))
          : new Promise((resolve) => pending.push(() => resolve(api.search(text, signal)))),
    });
    await group('Open');
    search('nothing like this');
    expect(await screen.findByText('Searching…')).toBeTruthy();
    expect(screen.queryByText('No tasks match these filters')).toBeNull();
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0]!());
    expect(await screen.findByText('No tasks match these filters')).toBeTruthy();

    failing = true;
    search('nothing like that');
    const failed = (await screen.findByText("Couldn't search every project")).closest('[role="alert"]') as HTMLElement;
    failing = false;
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => pending[1]!());
    await waitFor(() => expect(screen.queryByText("Couldn't search every project")).toBeNull());
  });
});

describe('the sidebar', () => {
  it('counts what waits for you and each project, and names who holds open work', async () => {
    renderApp('/tasks');
    await group('Waiting for you');
    const sidebar = screen.getByRole('navigation', { name: 'Ntasks' });
    const waiting = within(sidebar).getByRole('link', { name: /Waiting for you/ });
    expect(waiting.getAttribute('href')).toBe('/tasks?view=waiting');
    expect(within(waiting).getByText('4')).toBeTruthy();
    expect(
      within(sidebar)
        .getByRole('link', { name: /Example web app/ })
        .getAttribute('href'),
    ).toBe('/tasks?project=web');
    // The agents by the names the read gives them, and the person by theirs.
    expect(within(sidebar).getByRole('link', { name: 'Codex' }).getAttribute('href')).toBe(
      '/tasks?assignee=agent%3ACodex',
    );
    expect(within(sidebar).getByRole('link', { name: FIXTURE_ACTOR })).toBeTruthy();
    expect(sidebar.querySelector('[data-brand-mark="codex"]')).not.toBeNull();
  });

  it("marks an agent's row while the board is filtered to it, under any of its names", async () => {
    renderApp('/tasks?assignee=codex');
    await screen.findByRole('link', { name: 'Codex' });
    const sidebar = screen.getByRole('navigation', { name: 'Ntasks' });
    expect(within(sidebar).getByRole('link', { name: 'Codex' }).getAttribute('aria-current')).toBe('page');
  });

  it('opens the waiting view, which shows only what waits for you', async () => {
    renderApp('/tasks');
    await group('Waiting for you');
    const sidebar = screen.getByRole('navigation', { name: 'Ntasks' });
    fireEvent.click(within(sidebar).getByRole('link', { name: /Waiting for you/ }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Open' })).toBeNull());
    expect(rowIds(await group('Waiting for you'))).toHaveLength(4);
    expect(
      within(sidebar)
        .getByRole('link', { name: /Waiting for you/ })
        .getAttribute('aria-current'),
    ).toBe('page');
  });
});

describe('the keys', () => {
  function press(key: string) {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key }));
    });
  }

  it('opens the composer on C', async () => {
    renderApp('/tasks');
    await group('Waiting for you');
    press('c');
    expect(await screen.findByRole('dialog', { name: 'File a task' })).toBeTruthy();
  });

  it('puts the cursor in the search field on /, from any page', async () => {
    renderApp('/tasks/web-b2r6');
    await screen.findByRole('heading', { level: 1, name: 'Fix the broken reset link in the welcome email' });
    press('/');
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Search tasks'));
  });

  it('opens the search field on a phone and puts the cursor in it', async () => {
    const media = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...media(query),
      matches: query === '(width < 40rem)',
    })) as typeof media;
    try {
      renderApp('/tasks');
      await group('Waiting for you');
      press('/');
      await waitFor(() => expect(document.activeElement?.closest('[data-phone-search]')).not.toBeNull());
      fireEvent.click(screen.getByRole('button', { name: 'Search', expanded: true }));
      fireEvent.click(screen.getByRole('button', { name: 'Search', expanded: false }));
      await waitFor(() => expect(document.activeElement?.closest('[data-phone-search]')).not.toBeNull());
    } finally {
      window.matchMedia = media;
    }
  });

  it('opens Focus on F', async () => {
    renderApp('/tasks');
    await group('Waiting for you');
    press('f');
    expect(await screen.findByText('1 of 4')).toBeTruthy();
  });

  it('leaves F alone on Focus, which keeps its own address', async () => {
    renderApp('/tasks/focus?project=docs');
    expect(await screen.findByText('1 of 1')).toBeTruthy();
    press('f');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText('1 of 1')).toBeTruthy();
  });
});

describe('a row waiting for you that this sign-in cannot answer', () => {
  it('says why on each control it disables', async () => {
    const api = createFixtureTasksApi();
    const limited = {
      ...api,
      capabilities: async () => ({ live: true, writable: true, operations: ['close', 'update'], reason: null }),
    };
    renderApp('/tasks', limited);
    const waiting = await group('Waiting for you');
    const reasonOf = (control: HTMLElement) =>
      (control.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
    const row = (id: string) => waiting.querySelector(`[data-task-row="${id}"]`) as HTMLElement;
    await waitFor(() =>
      expect((within(row('web-g7p2')).getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    const controls = [
      within(row('web-g7p2')).getByRole('button', { name: 'Approve' }),
      within(row('web-g7p2')).getByRole('button', { name: 'Did it myself' }),
      ...within(row('web-d4x1')).getAllByRole('button', { name: /^\([abc]\)/ }),
      within(row('web-q8n5')).getByRole('button', { name: 'Answer' }),
    ];
    for (const control of controls) {
      expect((control as HTMLButtonElement).disabled).toBe(true);
      expect(reasonOf(control)).toBe('This sign-in cannot answer it.');
    }
  });
});

describe('a row waiting for you', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends each row's answer through a person's decision route, with the proposal version the row showed", async () => {
    const api = createFixtureTasksApi();
    const calls: unknown[][] = [];
    const spied = {
      ...api,
      board: async (...args: Parameters<typeof api.board>) => {
        const board = await api.board(...args);
        return { ...board, tasks: board.tasks.map((task) => ({ ...task, proposalVersion: `${task.id}-shown` })) };
      },
      resolveGate: (...args: Parameters<typeof api.resolveGate>) => {
        calls.push(['resolveGate', args[0], args[1], args[2], args[3]?.proposalVersion]);
        return api.resolveGate(...args);
      },
      choose: (...args: Parameters<typeof api.choose>) => {
        calls.push(['choose', args[0], args[1], args[2], args[3], args[4]?.proposalVersion]);
        return api.choose(...args);
      },
      respond: (...args: Parameters<typeof api.respond>) => {
        calls.push(['respond', args[0], args[1], args[2], args[3]?.proposalVersion]);
        return api.respond(...args);
      },
      dismiss: (...args: Parameters<typeof api.dismiss>) => {
        calls.push(['dismiss', args[0], args[1], args[2], args[3]?.resolution, args[3]?.proposalVersion]);
        return api.dismiss(...args);
      },
    };
    renderApp('/tasks', spied);
    const waiting = await group('Waiting for you');
    const row = (id: string) => waiting.querySelector(`[data-task-row="${id}"]`) as HTMLElement;
    fireEvent.click(await enabledButton('Approve', row('web-g7p2')));
    fireEvent.click(await enabledButton('(b) Email link and password', row('web-d4x1')));
    fireEvent.click(await enabledButton('Answer', row('web-q8n5')));
    const box = screen.getByRole('textbox', { name: 'Your answer to web-q8n5' });
    fireEvent.change(box, { target: { value: 'support@example.com' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for docs-r4s9' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Close as/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: "Won't do" }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Note' }), { target: { value: 'The docs stay put.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close task' }));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS + 10);
    });
    await waitFor(() => expect(calls).toHaveLength(4));
    expect(calls).toEqual(
      expect.arrayContaining([
        ['resolveGate', 'web-g7p2', 'web', undefined, 'web-g7p2-shown'],
        ['choose', 'web-d4x1', 'web', 'b', undefined, 'web-d4x1-shown'],
        ['respond', 'web-q8n5', 'web', 'support@example.com', 'web-q8n5-shown'],
        ['dismiss', 'docs-r4s9', 'docs', 'The docs stay put.', 'wont-do', 'docs-r4s9-shown'],
      ]),
    );
  });

  it("shows a refusal of a sign-in that is not a person in the server's words", async () => {
    const api = createFixtureTasksApi();
    const agent = {
      ...api,
      resolveGate: () =>
        Promise.reject(
          new ApiError('Only a person signed in to the web app can approve web-g7p2.', 403, 'insufficient_scope'),
        ),
    };
    renderApp('/tasks', agent);
    const waiting = await group('Waiting for you');
    fireEvent.click(await enabledButton('Approve', waiting.querySelector('[data-task-row="web-g7p2"]') as HTMLElement));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS + 10);
    });
    expect(await screen.findByText('Only a person signed in to the web app can approve web-g7p2.')).toBeTruthy();
  });

  it('closes an approval whose action the person did themselves, with their note, after the Undo window', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks', api);
    const row = (await group('Waiting for you')).querySelector('[data-task-row="web-g7p2"]') as HTMLElement;
    fireEvent.click(await enabledButton('Did it myself', row));
    const form = (await screen.findByRole('form', { name: 'Did it myself: web-g7p2' })) as HTMLElement;
    fireEvent.change(within(form).getByRole('textbox', { name: 'Note' }), {
      target: { value: 'Turned it on from the console.' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Send' }));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS + 10);
    });
    await waitFor(() =>
      expect(api.state.tasks.find((entry) => entry.id === 'web-g7p2')).toMatchObject({
        status: 'closed',
        resolution: 'done',
        closeReason: 'Did it myself: Turned it on from the console.',
        answer: { option: 'done', quote: 'Turned it on from the console.', relayed: false },
      }),
    );
  });

  it('answers a decision with one press of an option, sent after the Undo window', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks', api);
    const row = (await group('Waiting for you')).querySelector('[data-task-row="docs-r4s9"]') as HTMLElement;
    fireEvent.click(await enabledButton("(a) In the repository's docs folder, recommended", row));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS + 10);
    });
    await waitFor(() =>
      expect(api.state.tasks.find((entry) => entry.id === 'docs-r4s9')?.choice).toMatchObject({ option: 'a' }),
    );
  });
});
