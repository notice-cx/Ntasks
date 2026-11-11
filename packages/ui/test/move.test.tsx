import { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { ApiError } from '@/api/client';
import { createFixtureTasksApi } from '@/api/fixture';
import type { TaskMove } from '@/api/types';
import { appPaths } from '@/lib/paths';
import { enabledButton } from './render';

type FixtureApi = ReturnType<typeof createFixtureTasksApi>;

/** The address the router holds, and a way back through its history. */
function Where() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-where="">{location.pathname}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        Back
      </button>
    </>
  );
}

/** The app under `/tasks` with `entries` as its history, the last one open. */
function renderAt(entries: string[], api: FixtureApi) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Where />
      <Routes>
        <Route
          path="/tasks/*"
          element={
            <div data-ntasks="">
              <App api={api} paths={appPaths('/tasks')} queryClient={queryClient} />
            </div>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const where = () => document.querySelector('[data-where]')?.textContent;

/** The fixture API, recording every move the page asks for. */
function recording() {
  const api = createFixtureTasksApi();
  const sent: TaskMove[] = [];
  const move = api.moveTasks;
  api.moveTasks = (input, options) => {
    sent.push(input);
    return move(input, options);
  };
  return { api, sent };
}

/** An open epic added to the fixture's tasks. */
function addEpic(api: FixtureApi, project: string, id: string, title: string, parent: string | null = null) {
  const like = api.state.tasks.find((row) => row.project === project && row.status === 'open')!;
  api.state.tasks.push({ ...structuredClone(like), id, title, issueType: 'epic', parent, dependencies: [] });
}

function fact(name: string): HTMLElement {
  return screen.getByRole('complementary', { name: 'Facts' }).querySelector(`[data-fact="${name}"]`) as HTMLElement;
}

async function openMove() {
  fireEvent.click(await enabledButton('More'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
  const form = document.querySelector('[data-task-form="move"]') as HTMLElement;
  return {
    form,
    project: within(form).getByRole('combobox', { name: 'Project' }) as HTMLSelectElement,
    epic: within(form).getByRole('combobox', { name: 'Epic' }) as HTMLSelectElement,
    move: within(form).getByRole('button', { name: 'Move' }) as HTMLButtonElement,
  };
}

const epicValues = (epic: HTMLSelectElement) => [...epic.options].map((option) => option.value);

describe('Move to…', () => {
  it("moves a task to another project's epic and opens its page under the new id, in place of the old one", async () => {
    const { api, sent } = recording();
    addEpic(api, 'docs', 'docs-e1', 'Example guides');
    renderAt(['/tasks', '/tasks/web-t5w3'], api);
    await screen.findByRole('heading', { level: 1, name: 'Rename the Settings tab to Account' });
    const { project, epic, move } = await openMove();

    fireEvent.change(project, { target: { value: 'docs' } });
    await waitFor(() => expect(epicValues(epic)).toContain('docs-e1'));
    fireEvent.change(epic, { target: { value: 'docs-e1' } });
    fireEvent.click(move);

    await waitFor(() => expect(where()).toBe('/tasks/docs-e1.1'));
    expect(sent).toEqual([{ ids: ['web-t5w3'], project: 'docs', parent: 'docs-e1', withChildren: true }]);
    expect(await screen.findByRole('heading', { level: 1, name: 'Rename the Settings tab to Account' })).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Path' })).getByText('docs-e1.1')).toBeTruthy();
    expect(within(fact('Project')).getByText('Example docs')).toBeTruthy();
    expect(within(fact('Epic')).getByText('Example guides')).toBeTruthy();
    // The new page took the old one's place in the history.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(where()).toBe('/tasks'));
  });

  it('moves a task to an epic of its own project and stays on its id, showing the new epic', async () => {
    const { api, sent } = recording();
    renderAt(['/tasks/web-t5w3'], api);
    await screen.findByRole('heading', { level: 1, name: 'Rename the Settings tab to Account' });
    const { epic, move } = await openMove();

    await waitFor(() => expect(epicValues(epic)).toContain('web-k3m9'));
    fireEvent.change(epic, { target: { value: 'web-k3m9' } });
    fireEvent.click(move);

    expect(await within(fact('Epic')).findByText('Ship the new sign-in page')).toBeTruthy();
    expect(sent).toEqual([{ ids: ['web-t5w3'], project: 'web', parent: 'web-k3m9', withChildren: true }]);
    expect(where()).toBe('/tasks/web-t5w3');
    expect(api.state.tasks.find((row) => row.id === 'web-t5w3')?.parent).toBe('web-k3m9');
    expect(document.querySelector('[data-task-form="move"]')).toBeNull();
  });

  it('takes the task out of its epic when No epic is picked', async () => {
    const { api, sent } = recording();
    renderAt(['/tasks/web-k3m9.4'], api);
    await screen.findByRole('heading', { level: 1, name: 'Remove the old sign-in page' });
    const { epic, move } = await openMove();
    fireEvent.change(epic, { target: { value: '' } });
    fireEvent.click(move);
    expect(await within(fact('Epic')).findByText('None')).toBeTruthy();
    expect(sent).toEqual([{ ids: ['web-k3m9.4'], project: 'web', parent: null, withChildren: true }]);
  });

  it('keeps Move off while the project and epic are where the task already is', async () => {
    const { api } = recording();
    renderAt(['/tasks/web-k3m9.2'], api);
    await screen.findByRole('heading', { level: 1, name: 'Check the sign-in form with a screen reader' });
    const { project, epic, move } = await openMove();
    expect([project.value, epic.value, move.disabled]).toEqual(['web', 'web-k3m9', true]);

    fireEvent.change(epic, { target: { value: '' } });
    expect(move.disabled).toBe(false);
    fireEvent.change(epic, { target: { value: 'web-k3m9' } });
    expect(move.disabled).toBe(true);
    fireEvent.change(project, { target: { value: 'docs' } });
    expect([epic.value, move.disabled]).toEqual(['', false]);
    // Back in its own project, the form starts again from the epic the task is in.
    fireEvent.change(project, { target: { value: 'web' } });
    expect([epic.value, move.disabled]).toEqual(['web-k3m9', true]);
  });

  it('offers the open epics of the project picked, never the task itself or an epic under it', async () => {
    const { api } = recording();
    addEpic(api, 'web', 'web-k3m9.5', 'Sign-in page follow-ups', 'web-k3m9');
    addEpic(api, 'web', 'web-e2', 'Example pricing page');
    addEpic(api, 'docs', 'docs-e1', 'Example guides');
    renderAt(['/tasks/web-k3m9'], api);
    await screen.findByRole('heading', { level: 1, name: 'Ship the new sign-in page' });
    const { project, epic } = await openMove();

    await waitFor(() => expect(epicValues(epic)).toEqual(['', 'web-e2']));
    fireEvent.change(project, { target: { value: 'docs' } });
    await waitFor(() => expect(epicValues(epic)).toEqual(['', 'docs-e1']));
  });

  it("shows a refusal in the server's words and stays on the task", async () => {
    const api = createFixtureTasksApi();
    const detail = 'Example docs takes no new tasks while it is disabled.';
    api.moveTasks = () => Promise.reject(new ApiError(detail, 409, 'task_refused'));
    renderAt(['/tasks/web-t5w3'], api);
    await screen.findByRole('heading', { level: 1, name: 'Rename the Settings tab to Account' });
    const { project, move } = await openMove();
    fireEvent.change(project, { target: { value: 'docs' } });
    fireEvent.click(move);

    expect(await screen.findByText(detail)).toBeTruthy();
    expect(where()).toBe('/tasks/web-t5w3');
    expect(document.querySelector('[data-task-form="move"]')).not.toBeNull();
    expect(api.state.tasks.find((row) => row.id === 'web-t5w3')?.project).toBe('web');
  });

  it('is not offered on a closed task', async () => {
    renderAt(['/tasks/web-h1z8'], createFixtureTasksApi());
    await screen.findByRole('region', { name: 'Closed as No longer needed' });
    fireEvent.click(await enabledButton('More'));
    await screen.findByRole('menuitem', { name: 'Copy id' });
    expect(screen.queryByRole('menuitem', { name: 'Move to…' })).toBeNull();
  });

  it.each([
    ['lists writes without moving', ['create', 'update', 'comment', 'close']],
    ['lists no writes', undefined],
  ])('is not offered by an Ntasks that %s', async (_case, operations) => {
    const api = createFixtureTasksApi();
    api.capabilities = async () => ({
      live: true,
      writable: true,
      ...(operations === undefined ? {} : { operations }),
      reason: null,
    });
    renderAt(['/tasks/web-t5w3'], api);
    fireEvent.click(await enabledButton('More'));
    await screen.findByRole('menuitem', { name: 'Copy id' });
    expect(screen.queryByRole('menuitem', { name: 'Move to…' })).toBeNull();
  });
});

describe("a moved task's old id", () => {
  it('opens the task under its new id, with the tasks under it and their links following it', async () => {
    const api = createFixtureTasksApi();
    const { moved } = await api.moveTasks({ ids: ['web-k3m9'], project: 'docs', withChildren: true });
    const epic = moved['web-k3m9'];
    const child = moved['web-k3m9.2'];
    expect(epic?.startsWith('docs-')).toBe(true);
    expect(child?.startsWith(`${epic}.`)).toBe(true);

    renderAt(['/tasks', '/tasks/web-k3m9.2'], api);
    await waitFor(() => expect(where()).toBe(`/tasks/${child}`));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Check the sign-in form with a screen reader' }),
    ).toBeTruthy();
    expect(within(fact('Project')).getByText('Example docs')).toBeTruthy();
    // The task that waited on it waits on its new id.
    const holds = (await screen.findByText('Holds back')).closest('section') as HTMLElement;
    expect(holds.querySelector(`[data-linked-task="${moved['web-k3m9.3']}"]`)).not.toBeNull();
    // The old address was replaced, so Back does not open it again.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(where()).toBe('/tasks'));
  });

  it('takes a write to the moved task, in its old project, as the Worker does', async () => {
    const api = createFixtureTasksApi();
    const { moved } = await api.moveTasks({ ids: ['web-t5w3'], project: 'docs', withChildren: true });

    await api.comment('web-t5w3', 'web', 'Still on it.');
    expect(api.state.comments.get(moved['web-t5w3']!)?.map((comment) => comment.text)).toContain('Still on it.');

    const again = await api.moveTasks({ ids: ['web-t5w3'], project: 'web', withChildren: true });
    expect(Object.keys(again.moved)).toEqual([moved['web-t5w3']]);
  });
});
