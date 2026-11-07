import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { fixtureSeed } from '@/api/fixture-data';
import { acceptanceLines, acceptanceText } from '@/components/TaskComposer';
import { enabledButton, renderApp } from './render';

describe('the composer', () => {
  it('opens from New task and files a task from its title, project and Enter', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks', api);
    fireEvent.click(await enabledButton('New task', screen.getByRole('main')));
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

  it('previews the description as Markdown', async () => {
    renderApp('/tasks?new=1&project=web');
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Errors are **grey** today.\n\n<script>window.injected = true</script>' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const bold = await screen.findByText('grey');
    expect(bold.tagName).toBe('STRONG');
    expect(document.querySelector('[data-markdown] script')).toBeNull();
    expect(document.querySelector('[data-markdown]')?.textContent).not.toContain('injected');
  });

  it("links the preview's task ids to their pages", async () => {
    renderApp('/tasks?new=1&project=web');
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Blocked by web-b2r6.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const dialog = screen.getByRole('dialog', { name: 'File a task' });
    const link = await within(dialog).findByRole('link', { name: 'web-b2r6' });
    expect(link.getAttribute('href')).toBe('/tasks/web-b2r6');
    expect(link.closest('[data-markdown]')).not.toBeNull();
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
    await waitFor(() =>
      expect(api.state.tasks.find((entry) => entry.title === 'Show the sign-in errors in red')).toMatchObject({
        id: 'web-k3m9.5',
        issueType: 'bug',
        parent: 'web-k3m9',
        labels: ['copy'],
        description: 'Errors are grey today.',
        acceptance: '- [ ] Every error is red\n- [ ] A test covers it',
      }),
    );
  });

  it('files one task when Cmd or Ctrl and Enter are pressed in the title', async () => {
    const api = createFixtureTasksApi();
    let calls = 0;
    const counted = {
      ...api,
      createTask: (...args: Parameters<typeof api.createTask>) => {
        calls += 1;
        return api.createTask(...args);
      },
    };
    renderApp('/tasks?new=1&project=docs', counted);
    await enabledButton('File task');
    const title = screen.getByLabelText(/Title/);
    fireEvent.change(title, { target: { value: 'Only once' } });
    fireEvent.keyDown(title, { key: 'Enter', metaKey: true });
    expect(await screen.findByText(/^Filed docs-/)).toBeTruthy();
    expect(calls).toBe(1);
    expect(api.state.tasks.filter((entry) => entry.title === 'Only once')).toHaveLength(1);
  });

  it('sends a failed submission again with the same retry key, and a changed one with a new key', async () => {
    const api = createFixtureTasksApi();
    const keys: (string | undefined)[] = [];
    const flaky = {
      ...api,
      createTask: async (...args: Parameters<typeof api.createTask>) => {
        keys.push(args[1]?.idempotencyKey);
        if (keys.length === 1) throw new Error('The connection dropped.');
        return api.createTask(...args);
      },
    };
    renderApp('/tasks?new=1&project=docs', flaky);
    const file = await enabledButton('File task');
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Retry me' } });
    fireEvent.click(file);
    expect(await screen.findByText('The connection dropped.')).toBeTruthy();
    fireEvent.click(await enabledButton('File task'));
    expect(await screen.findByText(/^Filed docs-/)).toBeTruthy();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);

    fireEvent.click(await enabledButton('New task', screen.getByRole('main')));
    fireEvent.change(await screen.findByLabelText(/Title/), { target: { value: 'Another' } });
    fireEvent.change(screen.getByLabelText(/^Project/, { selector: 'select[data-composer-project]' }), {
      target: { value: 'docs' },
    });
    fireEvent.click(await enabledButton('File task'));
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('picks the only project once the list arrives', async () => {
    const seed = fixtureSeed(Date.now());
    seed.projects = seed.projects.filter((project) => project.logicalKey === 'docs');
    seed.tasks = seed.tasks.filter((task) => task.project === 'docs');
    renderApp('/tasks?new=1', createFixtureTasksApi({ seed }));
    const select = screen.getByLabelText(/^Project/, {
      selector: 'select[data-composer-project]',
    }) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('docs'));
  });

  it('keeps a prefilled project when the project list is already in hand', async () => {
    const seed = fixtureSeed(Date.now());
    const web = seed.projects.find((project) => project.logicalKey === 'web');
    seed.projects = seed.projects.filter((project) => project.logicalKey === 'docs');
    seed.tasks = seed.tasks.filter((task) => task.project === 'docs');
    // The board is narrowed to a project the list does not hold yet, and the composer opens after the list arrived.
    const { queryClient } = renderApp('/tasks?project=web', createFixtureTasksApi({ seed }));
    await screen.findByText('No tasks match these filters');
    fireEvent.click(await enabledButton('New task', screen.getByRole('main')));
    const select = (await screen.findByLabelText(/^Project/, {
      selector: 'select[data-composer-project]',
    })) as HTMLSelectElement;
    // The prefilled project appears in the list later; the composer still holds it and selects it.
    if (web) seed.projects.push(web);
    await queryClient.invalidateQueries({ queryKey: ['task-projects'] });
    await waitFor(() => expect(select.value).toBe('web'));
  });

  it('reads and writes Done when as a checklist', () => {
    expect(acceptanceLines('- [ ] One\n- [x] Two\n\nThree')).toEqual(['One', 'Two', 'Three']);
    expect(acceptanceText(['One', ' ', 'Two '])).toBe('- [ ] One\n- [ ] Two');
  });
});
