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
  it('shows merge proof once and keeps notes that add context', async () => {
    const api = createFixtureTasksApi();
    const task = api.state.tasks.find((row) => row.id === 'web-j6y4')!;
    const delivery = task.delivery!;
    const reason =
      `Closed by the merge of ${delivery.pullRequest} as ${delivery.mergeCommit!.slice(0, 7)}, which GitHub reported; ` +
      "the task's work named that pull request.";
    task.closeReason = reason;
    const { unmount } = renderApp(`/tasks/${task.id}`, api);
    const closed = await screen.findByRole('region', { name: 'Closed as Done' });
    expect(within(closed).getByRole('link', { name: 'example/web#39' })).toBeTruthy();
    expect(within(closed).queryByText(/which GitHub reported/)).toBeNull();
    unmount();

    task.closeReason = 'Checked the password rules with a screen reader.';
    renderApp(`/tasks/${task.id}`, api);
    expect(await screen.findByText(task.closeReason)).toBeTruthy();
  });

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

describe('marking a closed task live by hand', () => {
  const stageOn = (region: HTMLElement) =>
    region.querySelector('[data-task-delivery]')?.getAttribute('data-task-delivery');

  it('moves a built task to Live, and is not offered once it is Live or where Merged is the last stage', async () => {
    const api = createFixtureTasksApi();
    const { unmount } = renderApp(`/tasks/${BUILT}`, api);
    const closed = await screen.findByRole('region', { name: 'Closed as Done' });
    fireEvent.click(within(closed).getByRole('button', { name: 'Mark as live' }));
    await waitFor(() => expect(stageOn(screen.getByRole('region', { name: 'Closed as Done' }))).toBe('live'));
    const live = screen.getByRole('region', { name: 'Closed as Done' });
    expect(within(live).queryByRole('button', { name: 'Mark as live' })).toBeNull();
    unmount();

    // docs does not deploy, so its merged task has no stage left.
    const { unmount: leave } = renderApp(`/tasks/${MERGED}`, api);
    const merged = await screen.findByRole('region', { name: /^Closed as/u });
    expect(stageOn(merged)).toBe('merged');
    expect(within(merged).queryByRole('button', { name: 'Mark as live' })).toBeNull();
    leave();

    await api.updateProject('docs', { deploys: true });
    renderApp(`/tasks/${MERGED}`, api);
    const waiting = await screen.findByRole('region', { name: /^Closed as/u });
    fireEvent.click(within(waiting).getByRole('button', { name: 'Mark as live' }));
    await waitFor(() => expect(stageOn(screen.getByRole('region', { name: /^Closed as/u }))).toBe('live'));
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
    await api.updateProject('docs', { deploys: true });
    renderApp('/tasks?view=waiting', api);
    const deploy = await screen.findByRole('region', { name: 'Waiting for deploy' });
    expect(deploy.querySelector(`[data-task-row="${MERGED}"]`)).not.toBeNull();
  });
});

describe('a project’s deploy setting', () => {
  it('is set by an owner in Settings, and shown to a member as it stands', async () => {
    const api = createFixtureTasksApi();
    const { unmount } = renderApp('/tasks/settings/projects', api);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Example docs' }));
    const editor = await screen.findByRole('form', { name: 'Edit Example docs' });
    const box = within(editor).getByRole('checkbox', { name: 'Changes go live by a deploy' }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(async () =>
      expect((await api.projects()).find((project) => project.logicalKey === 'docs')?.deploys).toBe(true),
    );
    unmount();

    const [, labs] = fixtureWorkspaces(Date.now());
    const member = createFixtureTasksApi({ workspaces: labs ? [labs] : [] });
    member.state.projects[0]!.deploys = true;
    renderApp('/tasks/settings/projects', member);
    const row = await waitFor(() => {
      const found = document.querySelector('[data-project-row="lab"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(row).getByText('Deploys')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit Example research' })).toBeNull();
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

  it('shows no tip when a waiting task has no creation time', async () => {
    const api = createFixtureTasksApi();
    api.state.tasks.find((entry) => entry.id === 'web-q8n5')!.createdAt = null;
    renderApp('/tasks?view=waiting', api);
    const ask = await ageOf('web-q8n5');
    expect(ask.textContent).toBe('unknown');
    expect(ask.getAttribute('title')).toBeNull();
  });

  it('counts from the last change in Waiting for deploy', async () => {
    const api = createFixtureTasksApi();
    await api.updateProject('docs', { deploys: true });
    // docs-y5u2 was filed 6 days ago and merged 3 days ago.
    renderApp('/tasks?view=waiting', api);
    const age = await ageOf(MERGED);
    expect(age.textContent).toBe('3d');
    expect(age.getAttribute('title')).toBeNull();
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
