import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { FIXTURE_ACTOR } from '@/api/fixture-data';
import type { LiveTask } from '@/api/types';
import { linkGroups } from '@/routes/TaskRoute';
import { enabledButton, renderApp } from './render';

function task(api: ReturnType<typeof createFixtureTasksApi>, id: string) {
  return api.state.tasks.find((entry) => entry.id === id);
}

/** A fact's line in the side panel, by its name. */
function fact(name: string): HTMLElement {
  const facts = screen.getByRole('complementary', { name: 'Facts' });
  return facts.querySelector(`[data-fact="${name}"]`) as HTMLElement;
}

describe('a task page', () => {
  it('shows the task whole: its path, title, description, Done when and facts', async () => {
    renderApp('/tasks/web-b2r6');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Fix the broken reset link in the welcome email' }),
    ).toBeTruthy();
    expect(within(fact('Status')).getByText('Open')).toBeTruthy();
    expect(within(fact('Priority')).getByText('Top')).toBeTruthy();
    expect(within(fact('Type')).getByText('Bug')).toBeTruthy();
    expect(within(fact('Assignee')).getByText('Nobody')).toBeTruthy();
    expect(within(fact('Project')).getByRole('link', { name: 'Example web app' }).getAttribute('href')).toBe(
      '/tasks?project=web',
    );
    const doneWhen = document.querySelector('[data-task-field="Done when"]') as HTMLElement;
    expect(within(doneWhen).getByText('0/2')).toBeTruthy();
    // A Markdown heading is drawn at a heading's size, not under the body's.
    expect(screen.getByRole('heading', { level: 4, name: 'Steps to Reproduce' }).className).toContain('text-[16px]');
    // The top bar's path leads back to the project's tasks, and keeps the project's name when a phone hides its words.
    const path = screen.getByRole('navigation', { name: 'Path' });
    const projectLink = within(path).getByRole('link', { name: 'Example web app' });
    expect(projectLink.getAttribute('href')).toBe('/tasks?project=web');
    expect(within(path).getByText('web-b2r6')).toBeTruthy();
  });

  it('shows a fact it may not change as words, not as a control', async () => {
    renderApp('/tasks/web-b2r6');
    await screen.findByRole('heading', { level: 1, name: 'Fix the broken reset link in the welcome email' });
    await screen.findByRole('button', { name: 'Priority: Top' });
    expect(within(fact('Type')).queryByRole('button')).toBeNull();
    expect(within(fact('Project')).queryByRole('button')).toBeNull();
  });

  it('claims, comments, ticks Done when and closes with its evidence', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-b2r6', api);
    fireEvent.click(await enabledButton('Claim'));
    await waitFor(() => expect(task(api, 'web-b2r6')?.assignee).toBe(FIXTURE_ACTOR));
    expect(await within(fact('Assignee')).findByText(FIXTURE_ACTOR)).toBeTruthy();
    expect(await screen.findByText('claimed this', { exact: false })).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), {
      target: { value: 'Found it: the link uses the **old** host.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByText('Comment added')).toBeTruthy();
    expect(api.state.comments.get('web-b2r6')?.[0]?.text).toBe('Found it: the link uses the **old** host.');

    fireEvent.click(screen.getByRole('checkbox', { name: 'A new reset link opens the reset form' }));
    await waitFor(() =>
      expect(task(api, 'web-b2r6')?.acceptance).toContain('- [x] A new reset link opens the reset form'),
    );
    expect(await screen.findByText('1/2')).toBeTruthy();

    fireEvent.click(await enabledButton('Close'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Done' }));
    const close = screen.getByRole('button', { name: 'Close task' });
    expect((close as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Evidence/), {
      target: { value: 'Landed in 4d5e6f7: the link uses the new host.' },
    });
    fireEvent.click(close);
    await waitFor(() => expect(task(api, 'web-b2r6')?.status).toBe('closed'));
    expect(task(api, 'web-b2r6')?.closeReason).toBe('Landed in 4d5e6f7: the link uses the new host.');
    expect(await screen.findByRole('region', { name: 'Closed as Done' })).toBeTruthy();
  });

  it('sends a comment with Command or Control and Enter', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-b2r6', api);
    const box = await screen.findByRole('textbox', { name: 'Comment' });
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(box, { target: { value: 'Seen on the staging host too.' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(api.state.comments.get('web-b2r6')).toBeUndefined();
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.state.comments.get('web-b2r6')?.[0]?.text).toBe('Seen on the staging host too.'));
  });

  it('edits a fact in place, with Undo', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-t5w3', api);
    fireEvent.click(await enabledButton('Priority: Low'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'High' }));
    await waitFor(() => expect(task(api, 'web-t5w3')?.priority).toBe(1));
    const saved = (await screen.findByText('Saved the priority')).closest('li') as HTMLElement;
    fireEvent.click(within(saved).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(task(api, 'web-t5w3')?.priority).toBe(3));
  });

  it('edits the description from the top bar menu', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-b2r6', api);
    fireEvent.click(await enabledButton('More'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit description' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'The reset link points at the old host.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(task(api, 'web-b2r6')?.description).toBe('The reset link points at the old host.'));
  });

  it('shows what a task waits on and what it holds back', async () => {
    renderApp('/tasks/web-k3m9.3');
    const links = (await screen.findByText('Waits on')).closest('section') as HTMLElement;
    expect(within(links).getByText('Holds back')).toBeTruthy();
    expect(within(links).getByRole('link', { name: /web-g7p2/ })).toBeTruthy();
    expect(within(links).getByRole('link', { name: /web-k3m9\.2/ })).toBeTruthy();
    expect(within(links).getByRole('link', { name: /web-k3m9\.4/ })).toBeTruthy();
  });

  it('shows the notes, the estimate, the due date, the pages it links to and its custom fields', async () => {
    renderApp('/tasks/web-k3m9.2');
    await screen.findByRole('heading', { level: 1, name: 'Check the sign-in form with a screen reader' });
    const notes = document.querySelector('[data-task-field="Notes"]') as HTMLElement;
    expect(within(notes).getByText(/The error under the password field/)).toBeTruthy();
    expect(within(fact('Estimate')).getByText('1h 30m')).toBeTruthy();
    expect(fact('Due')).not.toBeNull();
    expect(within(fact('Area')).getByText('Accessibility')).toBeTruthy();
    expect(within(fact('Story points')).getByText('3')).toBeTruthy();
    const pull = screen.getByRole('link', { name: /Fix the tab order on the sign-in form/ });
    expect(pull.getAttribute('href')).toBe('https://github.example.com/example/web/pull/42');
    expect(pull.getAttribute('target')).toBe('_blank');
    expect(pull.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(pull.closest('section') as HTMLElement).getByText('Pull request')).toBeTruthy();
  });

  it("starts the next task's page clean when a link moves to it", async () => {
    // Both tasks are read first, so the move between them draws no loading
    // state that would reset the page whatever its key.
    renderApp('/tasks/web-k3m9.2');
    await screen.findByRole('heading', { level: 1, name: 'Check the sign-in form with a screen reader' });
    const holds = (await screen.findByText('Holds back')).closest('section') as HTMLElement;
    fireEvent.click(within(holds).getByRole('link', { name: /web-k3m9\.3/ }));
    await screen.findByRole('heading', { level: 1, name: 'Send the new sign-in page to every visitor' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), {
      target: { value: 'A draft for this task' },
    });
    const waits = (await screen.findByText('Waits on')).closest('section') as HTMLElement;
    fireEvent.click(within(waits).getByRole('link', { name: /web-k3m9\.2/ }));
    // The cached task is drawn at once, in the same page component.
    expect(screen.getByRole('heading', { level: 1, name: 'Check the sign-in form with a screen reader' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Comment' }) as HTMLTextAreaElement).value).toBe('');
  });

  it('shows a closed task as closed, with how it ended', async () => {
    renderApp('/tasks/web-h1z8');
    expect(await screen.findByRole('region', { name: 'Closed as No longer needed' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    // Nothing shipped, so its status is the grey tick and the way it ended, never Done.
    const status = fact('Status');
    expect(within(status).getByText('No longer needed')).toBeTruthy();
    expect(within(status).queryByText('Done')).toBeNull();
    expect(status.querySelector('[data-status-mark="done"] circle')?.getAttribute('class')).toContain('fill-ink-3');
    expect(within(status).queryByRole('button')).toBeNull();
  });

  it('says when no task has the id', async () => {
    renderApp('/tasks/zzz-a1b2');
    expect(await screen.findByText('No task with this id')).toBeTruthy();
  });
});

describe("a task's links", () => {
  const other = (id: string, dependencies: LiveTask['dependencies'] = []) => ({
    id,
    title: `Task ${id}`,
    status: 'open',
    dependencies,
  });

  it('names each kind once, what it waits on and holds back first, and leaves out its epic', () => {
    const groups = linkGroups(
      {
        id: 'web-a1',
        dependencies: [
          { id: 'web-a0', type: 'parent-child', title: 'The epic', status: 'open' },
          { id: 'web-r1', type: 'related', title: 'Related one', status: 'open' },
          { id: 'web-b1', type: 'blocks', title: 'Blocker', status: 'in_progress' },
          { id: 'web-s1', type: 'supersedes', title: 'Old one', status: 'closed' },
          { id: 'web-x1', type: 'tracks-with', title: 'Unknown', status: null },
        ],
        externalLinks: [{ url: 'https://example.com/doc', title: 'The spec', kind: 'document' }],
      },
      [other('web-h1', [{ id: 'web-a1', type: 'blocks', title: null, status: null }]), other('web-n1')],
    );
    expect(groups.map((group) => group.label)).toEqual([
      'Waits on',
      'Holds back',
      'Related',
      'Replaces',
      'Tracks with',
      'Document',
    ]);
    expect(groups[1]?.rows).toEqual([{ kind: 'task', id: 'web-h1', title: 'Task web-h1', status: 'open' }]);
  });
});
