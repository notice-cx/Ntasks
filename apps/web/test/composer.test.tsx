import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { acceptanceLines, acceptanceText } from '@/components/TaskComposer';
import { enabledButton, renderApp } from './render';

describe('the composer', () => {
  it('opens from New task and files a task from its title, project and Enter', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks', api);
    fireEvent.click(await enabledButton('New task'));
    const dialog = await screen.findByRole('dialog', { name: 'File a task' });
    const title = within(dialog).getByLabelText(/Title/);
    expect(title.getAttribute('aria-required')).toBe('true');
    fireEvent.change(title, { target: { value: 'Add a dark logo for the docs' } });
    fireEvent.change(within(dialog).getByLabelText(/Project/), { target: { value: 'docs' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(await screen.findByText(/^Filed docs-/)).toBeTruthy();
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    const filed = api.state.tasks.find((entry) => entry.title === 'Add a dark logo for the docs');
    expect(filed).toMatchObject({ project: 'docs', priority: 2, issueType: 'task', status: 'open' });
  });

  it('says on each field what is missing, and files nothing', async () => {
    const api = createFixtureTasksApi();
    const before = api.state.tasks.length;
    renderApp('/tasks?new=1', api);
    fireEvent.click(await enabledButton('File task'));
    expect(await screen.findByText('Write a title someone can read without context.')).toBeTruthy();
    expect(screen.getByText('Choose the project this task belongs to.')).toBeTruthy();
    expect(api.state.tasks.length).toBe(before);
  });

  it('files the fields under More: type, parent, labels, description and Done when', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks?new=1&project=web', api);
    fireEvent.change(await screen.findByLabelText(/Title/), { target: { value: 'Show the sign-in errors in red' } });
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'bug' } });
    fireEvent.change(screen.getByLabelText('Parent epic'), { target: { value: 'docs-m2v7' } });
    fireEvent.click(await enabledButton('File task'));
    // A parent from another project cannot hold the task.
    expect(await screen.findByText('A parent in Example web app starts with web-.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Parent epic'), { target: { value: 'web-k3m9' } });
    fireEvent.change(screen.getByLabelText('Labels'), { target: { value: 'copy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Errors are grey today.' } });
    const first = screen.getByPlaceholderText('The proof that it is done');
    fireEvent.change(first, { target: { value: 'Every error is red' } });
    fireEvent.keyDown(first, { key: 'Enter' });
    fireEvent.change(screen.getByLabelText('Done when, line 2'), { target: { value: 'A test covers it' } });
    fireEvent.click(screen.getByRole('button', { name: 'File task' }));
    await waitFor(() => expect(api.state.tasks.find((entry) => entry.title === 'Show the sign-in errors in red')).toMatchObject({
      id: 'web-k3m9.5',
      issueType: 'bug',
      parent: 'web-k3m9',
      labels: ['copy'],
      description: 'Errors are grey today.',
      acceptance: '- [ ] Every error is red\n- [ ] A test covers it',
    }));
  });

  it('reads and writes Done when as a checklist', () => {
    expect(acceptanceLines('- [ ] One\n- [x] Two\n\nThree')).toEqual(['One', 'Two', 'Three']);
    expect(acceptanceText(['One', ' ', 'Two '])).toBe('- [ ] One\n- [ ] Two');
  });
});
