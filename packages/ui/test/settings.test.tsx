// Settings in tabs, and an owner's settings of a project in its Projects tab:
// its name, its website and the icon read from it, and whether it takes new
// tasks. Every website here is invented: the fixture reads an icon for any
// address under example.com.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { fixtureWorkspaces } from '@/api/fixture-data';
import { enabledButton, renderApp } from './render';

const sidebar = () => screen.findByRole('navigation', { name: 'Ntasks' });
const settingsTabs = () => screen.findByRole('navigation', { name: 'Settings' });
const tabNames = async () =>
  within(await settingsTabs())
    .getAllByRole('link')
    .map((link) => link.textContent);

/** The image a project's link in the sidebar draws, or null while it draws the letter. */
async function sidebarIcon(name: RegExp): Promise<string | null> {
  const link = await within(await sidebar()).findByRole('link', { name });
  return link.querySelector('img[data-project-icon]')?.getAttribute('src') ?? null;
}

/** The Settings tab on screen, once one is. */
async function shownTab(): Promise<string | null> {
  return waitFor(() => {
    const tab = document.querySelector('[data-settings-tab]');
    expect(tab).not.toBeNull();
    return tab!.getAttribute('data-settings-tab');
  });
}

async function editProject(name: string): Promise<HTMLElement> {
  fireEvent.click(await enabledButton(`Edit ${name}`));
  return screen.findByRole('form', { name: `Edit ${name}` });
}

describe('Settings', () => {
  it('shows one tab at a time, each at its own address, opening on Workspace', async () => {
    renderApp('/tasks/settings');
    expect(await tabNames()).toEqual(['Workspace', 'Projects', 'Members', 'GitHub', 'Apps', 'Services', 'You']);
    const tabs = await settingsTabs();
    expect(within(tabs).getByRole('link', { name: 'Workspace' }).getAttribute('aria-current')).toBe('page');
    expect(await shownTab()).toBe('workspace');

    const projects = within(tabs).getByRole('link', { name: 'Projects' });
    expect(projects.getAttribute('href')).toBe('/tasks/settings/projects');
    fireEvent.click(projects);
    await waitFor(() => expect(projects.getAttribute('aria-current')).toBe('page'));
    expect(await shownTab()).toBe('projects');
    expect(document.querySelectorAll('[data-settings-section]')).toHaveLength(1);
  });

  it('opens the old Projects and Members addresses as their tabs, and the sidebar ends with Settings', async () => {
    const { unmount } = renderApp('/tasks/members');
    expect(await shownTab()).toBe('members');
    const nav = await sidebar();
    expect(within(nav).getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).queryByRole('link', { name: 'Members' })).toBeNull();
    unmount();
    renderApp('/tasks/projects');
    expect(await shownTab()).toBe('projects');
  });

  it('ties a refused workspace name to its field, so the refusal is read with it', async () => {
    renderApp('/tasks/settings/workspace');
    const form = await screen.findByRole('form', { name: 'Rename' });
    const name = within(form).getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'x'.repeat(129) } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'));
    const said = document.getElementById(name.getAttribute('aria-describedby') ?? '');
    expect(said?.textContent).toMatch(/128/);
  });

  it('offers a member neither Members, GitHub nor Services', async () => {
    const [, labs] = fixtureWorkspaces(Date.now());
    renderApp('/tasks/settings', createFixtureTasksApi({ workspaces: labs ? [labs] : [] }));
    expect(await tabNames()).toEqual(['Workspace', 'Projects', 'Apps', 'You']);
  });
});

describe('a project in Settings', () => {
  it('is renamed by an owner, keeping its prefix, and the sidebar shows the new name', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/settings/projects', api);
    const editor = await editProject('Example docs');
    const name = within(editor).getByLabelText(/^Name/);
    const save = within(editor).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    fireEvent.change(name, { target: { value: '  ' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'Handbook' } });
    fireEvent.click(save);
    expect(await within(await sidebar()).findByRole('link', { name: /^Handbook/ })).toBeTruthy();
    expect((await api.projects()).find((project) => project.logicalKey === 'docs')).toMatchObject({
      displayName: 'Handbook',
      prefix: 'docs',
    });
  });

  it('shows the icon read from its website in the sidebar and on its task pages, and its letter when it has none', async () => {
    const api = createFixtureTasksApi();
    const { unmount } = renderApp('/tasks/settings/projects', api);
    await waitFor(async () => expect(await sidebarIcon(/^Example web app/)).toMatch(/^data:image\/png;base64,/));
    expect(await sidebarIcon(/^Example docs/)).toBeNull();

    const editor = await editProject('Example docs');
    fireEvent.change(within(editor).getByLabelText('Website'), { target: { value: 'docs.example.com' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect(await sidebarIcon(/^Example docs/)).toMatch(/^data:image\/png;base64,/));
    expect((await api.projects()).find((project) => project.logicalKey === 'docs')?.websiteUrl).toBe(
      'https://docs.example.com/',
    );
    unmount();

    renderApp('/tasks/docs-y5u2', api);
    const path = await screen.findByRole('navigation', { name: 'Path' });
    await waitFor(() =>
      expect(
        within(path).getByRole('link', { name: 'Example docs' }).querySelector('img[data-project-icon]'),
      ).not.toBeNull(),
    );
  });

  it('keeps its letter when its website has no icon, and refuses an address that is not a web page under its field', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/settings/projects', api);
    const editor = await editProject('Example docs');
    const website = within(editor).getByLabelText('Website');
    fireEvent.change(website, { target: { value: 'ftp://docs.example.com' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(website.getAttribute('aria-invalid')).toBe('true'));
    fireEvent.change(website, { target: { value: 'https://docs.test' } });
    expect(website.getAttribute('aria-invalid')).toBeNull();
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit Example docs' })).toBeNull());
    expect((await api.projects()).find((project) => project.logicalKey === 'docs')).toMatchObject({
      websiteUrl: 'https://docs.test/',
      icon: null,
    });
    expect(await sidebarIcon(/^Example docs/)).toBeNull();
  });

  it('when disabled leaves the sidebar and the board, refuses new tasks, and keeps its task pages', async () => {
    const api = createFixtureTasksApi();
    const { unmount } = renderApp('/tasks/settings/projects', api);
    const editor = await editProject('Example docs');
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'Enabled' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    const nav = await sidebar();
    await waitFor(() => expect(within(nav).queryByRole('link', { name: /^Example docs/ })).toBeNull());
    const row = document.querySelector('[data-project-row="docs"]') as HTMLElement;
    expect(within(row).getByText('Disabled')).toBeTruthy();
    await expect(api.createTask({ project: 'docs', title: 'Filed after' })).rejects.toThrow(/disabled/);
    unmount();

    const board = renderApp('/tasks', api);
    await within(await sidebar()).findByRole('link', { name: /^Example web app/ });
    expect(document.querySelector('[data-task-row="docs-y5u2"]')).toBeNull();
    board.unmount();

    renderApp('/tasks/docs-y5u2', api);
    expect(await screen.findByRole('navigation', { name: 'Path' })).toBeTruthy();

    // Enabled again, it comes back.
    await api.updateProject('docs', { disabled: false });
    await api.createTask({ project: 'docs', title: 'Filed again' });
  });
});
