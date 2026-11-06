import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { FIXTURE_ACTOR } from '@/api/fixture-data';
import { enabledButton, renderApp } from './render';

function task(api: ReturnType<typeof createFixtureTasksApi>, id: string) {
  return api.state.tasks.find((entry) => entry.id === id);
}

describe('a task page', () => {
  it('shows the task whole: its header, description, Done when and facts', async () => {
    renderApp('/tasks/web-b2r6');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Fix the broken reset link in the welcome email' }),
    ).toBeTruthy();
    expect(screen.getByText('Bug')).toBeTruthy();
    expect(screen.getByText('top priority')).toBeTruthy();
    expect(screen.getByText('0 of 2')).toBeTruthy();
    const facts = screen.getByRole('complementary', { name: 'Facts' });
    expect(within(facts).getByText('Example web app')).toBeTruthy();
    expect(within(facts).getByText('Nobody')).toBeTruthy();
    // The breadcrumb leads back to the board and the project's tasks.
    const where = screen.getByRole('navigation', { name: 'Where this task sits' });
    expect(within(where).getByRole('link', { name: 'Tasks' }).getAttribute('href')).toBe('/tasks');
    expect(within(where).getByRole('link', { name: 'Example web app' }).getAttribute('href')).toBe(
      '/tasks?project=web',
    );
  });

  it('claims, comments, ticks Done when and closes with its evidence', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-b2r6', api);
    fireEvent.click(await enabledButton('Claim'));
    await waitFor(() => expect(task(api, 'web-b2r6')?.assignee).toBe(FIXTURE_ACTOR));
    expect(await screen.findByText('· claimed 0s ago')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Add a comment' }), {
      target: { value: 'Found it: the link uses the **old** host.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByText('Comment added')).toBeTruthy();
    expect(api.state.comments.get('web-b2r6')?.[0]?.text).toBe('Found it: the link uses the **old** host.');

    fireEvent.click(screen.getByRole('checkbox', { name: 'A new reset link opens the reset form' }));
    await waitFor(() =>
      expect(task(api, 'web-b2r6')?.acceptance).toContain('- [x] A new reset link opens the reset form'),
    );
    expect(await screen.findByText('1 of 2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const close = screen.getByRole('button', { name: 'Close task' });
    expect((close as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/What shipped, and the commit/), {
      target: { value: 'Landed in 4d5e6f7: the link uses the new host.' },
    });
    fireEvent.click(close);
    await waitFor(() => expect(task(api, 'web-b2r6')?.status).toBe('closed'));
    expect(task(api, 'web-b2r6')?.closeReason).toBe('Landed in 4d5e6f7: the link uses the new host.');
    expect(await screen.findByRole('region', { name: 'Close reason' })).toBeTruthy();
  });

  it('edits a fact in place, with Undo', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-t5w3', api);
    fireEvent.click(await screen.findByRole('button', { name: 'Change Priority: low' }));
    fireEvent.click(await screen.findByRole('option', { name: 'high' }));
    await waitFor(() => expect(task(api, 'web-t5w3')?.priority).toBe(1));
    const saved = (await screen.findByText('Saved the priority')).closest('li') as HTMLElement;
    fireEvent.click(within(saved).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(task(api, 'web-t5w3')?.priority).toBe(3));
  });

  it('shows what a task waits on and what it holds back', async () => {
    renderApp('/tasks/web-k3m9.3');
    const links = await screen.findByText('Waits on');
    const section = links.closest('section') as HTMLElement;
    expect(within(section).getByRole('link', { name: /web-g7p2/ })).toBeTruthy();
    expect(within(section).getByRole('link', { name: /web-k3m9\.2/ })).toBeTruthy();
    expect(within(section).getByRole('link', { name: /web-k3m9\.4/ })).toBeTruthy();
  });

  it('shows a closed task as closed, with how it ended', async () => {
    renderApp('/tasks/web-h1z8');
    expect(await screen.findByRole('region', { name: 'Closed as No longer needed' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('says when no task has the id', async () => {
    renderApp('/tasks/zzz-a1b2');
    expect(await screen.findByText('No task with this id')).toBeTruthy();
  });
});
