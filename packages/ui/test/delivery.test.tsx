// Where a closed task's change is: its stage on its page and its row, the work
// waiting for a merge or a deploy in the Waiting for you view, and the
// project setting that says whether its changes go live by a deploy.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { fixtureWorkspaces } from '@/api/fixture-data';
import { renderApp } from './render';

/** web-k3m9.1 is built; docs-y5u2 is merged, in docs, which does not deploy (fixture-data.ts). */
const BUILT = 'web-k3m9.1';
const MERGED = 'docs-y5u2';

describe('a closed task with a delivery', () => {
  it('shows its stage and pull request on its page, and its stage on its row', async () => {
    const { unmount } = renderApp(`/tasks/${BUILT}`);
    const closed = await screen.findByRole('region', { name: 'Closed as Done' });
    const delivery = closed.querySelector('[data-task-delivery]') as HTMLElement;
    expect(delivery.getAttribute('data-task-delivery')).toBe('built');
    expect(within(delivery).getByRole('link').getAttribute('href')).toBe('https://github.com/example/web/pull/42');
    unmount();

    renderApp('/tasks?view=done');
    const row = await waitFor(() => {
      const found = document.querySelector(`[data-task-row="${MERGED}"]`);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(row.querySelector('[data-delivery-stage]')?.getAttribute('data-delivery-stage')).toBe('merged');
  });
});

describe('the Waiting for you view', () => {
  it('lists built work waiting for its merge, and merged work only where the project deploys', async () => {
    const { unmount } = renderApp('/tasks?view=waiting');
    const merge = await screen.findByRole('region', { name: 'Waiting for merge' });
    expect(merge.querySelector(`[data-task-row="${BUILT}"]`)).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Waiting for deploy' })).toBeNull();
    unmount();

    const api = createFixtureTasksApi();
    await api.setDeploys('docs', true);
    renderApp('/tasks?view=waiting', api);
    const deploy = await screen.findByRole('region', { name: 'Waiting for deploy' });
    expect(deploy.querySelector(`[data-task-row="${MERGED}"]`)).not.toBeNull();
  });
});

describe('a project’s deploy setting', () => {
  it('is ticked by an owner, and shown to a member as it stands', async () => {
    const api = createFixtureTasksApi();
    const { unmount } = renderApp('/tasks/projects', api);
    const box = await screen.findByRole('checkbox', { name: 'Example docs: changes go live by a deploy' });
    await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(false));
    expect((box as HTMLInputElement).checked).toBe(false);
    fireEvent.click(box);
    await waitFor(async () =>
      expect((await api.projects()).find((project) => project.logicalKey === 'docs')?.deploys).toBe(true),
    );
    unmount();

    const [, labs] = fixtureWorkspaces(Date.now());
    renderApp('/tasks/projects', createFixtureTasksApi({ workspaces: labs ? [labs] : [] }));
    const shown = (await screen.findByRole('checkbox', {
      name: 'Example research: changes go live by a deploy',
    })) as HTMLInputElement;
    expect(shown.disabled).toBe(true);
  });
});

describe('how long work has waited', () => {
  /** The age at the end of a task's row, once its row is drawn. */
  async function ageOf(id: string): Promise<HTMLElement> {
    const row = await waitFor(() => {
      const found = document.querySelector(`[data-task-row="${id}"]`);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    return row.querySelector('[data-row-age]') as HTMLElement;
  }

  it('counts from when each task was created in Waiting for you and Waiting for merge, so an edit does not reset it', async () => {
    const api = createFixtureTasksApi();
    // Agents edit the text of work that waits; web-q8n5 was filed 5 days ago and web-k3m9.1 6 days ago.
    await api.updateTask('web-q8n5', 'web', { title: 'Confirm the support address on the 404 page' });
    await api.updateTask(BUILT, 'web', { title: 'Draw the new sign-in form' });
    renderApp('/tasks?view=waiting', api);
    const ask = await ageOf('web-q8n5');
    expect(ask.textContent).toBe('5d');
    expect(ask.getAttribute('title')).toBe('Created 5d ago');
    expect((await ageOf(BUILT)).textContent).toBe('6d');
  });

  it('counts from the last change in the other groups', async () => {
    const api = createFixtureTasksApi();
    await api.updateTask('web-t5w3', 'web', { title: 'Rename the Settings tab to Profile' });
    renderApp('/tasks', api);
    const age = await ageOf('web-t5w3');
    expect(age.textContent).toMatch(/^\d+s$/);
    expect(age.getAttribute('title')).toBeNull();
  });
});
