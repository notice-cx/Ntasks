import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createHttpTasksApi, WORKSPACE_HEADER } from '@/api/client';
import { createFixtureTasksApi } from '@/api/fixture';
import { fixtureWorkspaces } from '@/api/fixture-data';
import type { TaskProject } from '@/api/types';
import { enabledButton, renderApp } from './render';

const ONE = '0d1f3c6a-7b2e-4c59-8a10-3e5f7a9b1c20';
const TWO = '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a';

const PROJECTS: Readonly<Record<string, TaskProject[]>> = {
  [ONE]: [{ projectId: 'p-web', logicalKey: 'web', displayName: 'Example web app', prefix: 'web' }],
  [TWO]: [{ projectId: 'p-lab', logicalKey: 'lab', displayName: 'Example research', prefix: 'lab' }],
};

/** A server with two workspaces, each with one project and no tasks, that records the workspace each request names. */
function twoWorkspaceServer() {
  const sent: { path: string; workspace: string | null }[] = [];
  const api = createHttpTasksApi(async (url, init) => {
    const workspace = new Headers(init?.headers).get(WORKSPACE_HEADER);
    const [path = '', query = ''] = url.split('?');
    sent.push({ path, workspace });
    const projects = PROJECTS[workspace ?? ''] ?? [];
    switch (path) {
      case '/api/workspaces':
        return Response.json({
          workspaces: [
            { workspaceId: ONE, name: 'Example', role: 'owner' },
            { workspaceId: TWO, name: 'Example Labs', role: 'member' },
          ],
        });
      case '/api/tasks/capabilities':
        return Response.json({ live: true, writable: true });
      case '/api/tasks/projects':
        return Response.json({ projects });
      case '/api/tasks': {
        const project = projects.find((row) => row.projectId === new URLSearchParams(query).get('project'));
        if (!project) return Response.json({ error: 'not_found' }, { status: 404 });
        const readAt = new Date().toISOString();
        return Response.json({ project: project.logicalKey, prefix: project.prefix, repo: '', readAt, tasks: [] });
      }
      case '/api/changes':
        return Response.json({ events: [], lastSeq: 0 });
      default:
        return Response.json({ error: 'not_found' }, { status: 404 });
    }
  });
  return { api, sent };
}

/** A link in the sidebar, once it shows. A project's link ends in its count. */
async function sidebarLink(name: string | RegExp) {
  return within(await screen.findByRole('navigation', { name: 'Ntasks' })).findByRole('link', { name });
}

describe('the workspace switcher', () => {
  it('sends the workspace chosen on every request after it, and opens it again on the next load', async () => {
    const { api, sent } = twoWorkspaceServer();
    const first = renderApp('/tasks', api);
    await sidebarLink('Example web app');
    const before = sent.filter((request) => request.path !== '/api/workspaces');
    expect(before.length).toBeGreaterThan(0);
    expect(new Set(before.map((request) => request.workspace))).toEqual(new Set([ONE]));

    sent.length = 0;
    fireEvent.click(await screen.findByRole('button', { name: 'Example' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Example Labs' }));
    await sidebarLink('Example research');
    expect(screen.queryByRole('link', { name: 'Example web app' })).toBeNull();
    const after = sent.filter((request) => request.path !== '/api/workspaces');
    expect(after.map((request) => request.path)).toContain('/api/tasks');
    expect(new Set(after.map((request) => request.workspace))).toEqual(new Set([TWO]));

    first.unmount();
    sent.length = 0;
    renderApp('/tasks', api);
    await sidebarLink('Example research');
    expect(sent.find((request) => request.path === '/api/tasks/projects')?.workspace).toBe(TWO);
  });

  it('shows only while the sign-in reaches two or more workspaces', async () => {
    renderApp('/tasks', createFixtureTasksApi({ workspaces: fixtureWorkspaces(Date.now()).slice(0, 1) }));
    await sidebarLink('Example web app');
    expect(document.querySelector('[data-workspace-switcher]')).toBeNull();
  });
});

describe('an owner', () => {
  it('creates a project, and sees a refused prefix under its field', async () => {
    const api = createFixtureTasksApi();
    renderApp('/projects', api);
    fireEvent.click(await enabledButton('New project'));
    const form = await screen.findByRole('form', { name: 'New project' });
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'Example shop' } });
    const prefix = within(form).getByLabelText(/^Prefix/);
    fireEvent.change(prefix, { target: { value: 'web' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(prefix.getAttribute('aria-invalid')).toBe('true'));
    const said = document.getElementById(prefix.getAttribute('aria-describedby') ?? '');
    expect(said?.textContent).toMatch(/web/);

    fireEvent.change(prefix, { target: { value: 'Shop' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create project' }));
    const list = screen.getByRole('list', { name: 'Projects' });
    const row = await within(list).findByRole('link', { name: 'Example shop' });
    expect(row.getAttribute('href')).toBe('/tasks?project=shop');
    expect(await sidebarLink(/^Example shop/)).toBeTruthy();
    expect((await api.projects()).find((project) => project.prefix === 'shop')).toMatchObject({
      displayName: 'Example shop',
    });
  });

  it('invites a GitHub account with a role, revokes an invitation and removes a member', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks', api);
    fireEvent.click(await sidebarLink('Members'));
    fireEvent.click(await enabledButton('Invite'));
    const form = await screen.findByRole('form', { name: 'Invite' });
    fireEvent.change(within(form).getByLabelText(/^GitHub username/), { target: { value: '@example-new' } });
    fireEvent.change(within(form).getByLabelText('Role'), { target: { value: 'owner' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Invite' }));
    const invitations = await screen.findByRole('region', { name: 'Invitations' });
    await within(invitations).findByText('example-new');
    expect((await api.members()).invitations).toContainEqual(
      expect.objectContaining({ githubLogin: 'example-new', role: 'owner' }),
    );

    const pending = document.querySelector('[data-invitation-row="i-example-invitee"]') as HTMLElement;
    fireEvent.click(within(pending).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(document.querySelector('[data-invitation-row="i-example-invitee"]')).toBeNull());
    expect((await api.members()).invitations.map((row) => row.githubLogin)).toEqual(['example-new']);

    const member = document.querySelector('[data-member-row="u-example-member"]') as HTMLElement;
    fireEvent.click(within(member).getByRole('button', { name: 'Remove' }));
    fireEvent.click(member.querySelector('[data-confirm-remove]') as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-member-row="u-example-member"]')).toBeNull());
    expect((await api.members()).members.map((row) => row.userId)).not.toContain('u-example-member');
  });
});

describe('a member', () => {
  it('sees the projects with no owner controls, and never reads the member list', async () => {
    const [, labs] = fixtureWorkspaces(Date.now());
    const api = createFixtureTasksApi({ workspaces: labs ? [labs] : [] });
    const members = vi.spyOn(api, 'members');
    const { unmount } = renderApp('/projects', api);
    expect(await screen.findByRole('link', { name: 'Example research' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'n' });
    expect(screen.queryByRole('form', { name: 'New project' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull();
    unmount();

    renderApp('/members', api);
    await sidebarLink('Example research');
    fireEvent.keyDown(window, { key: 'i' });
    expect(screen.queryByRole('form', { name: 'Invite' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(members).not.toHaveBeenCalled();
  });
});

describe('a sign-in with no workspace', () => {
  it("creates the first one as a deployment admin, and lands on its Projects page's New project form", async () => {
    const api = createFixtureTasksApi({ workspaces: [], deploymentAdmin: true });
    renderApp('/tasks', api);
    const step = await screen.findByRole('form', { name: 'New workspace' });
    fireEvent.change(within(step).getByLabelText(/^Name/), { target: { value: 'Example Co' } });
    fireEvent.click(within(step).getByRole('button', { name: 'Create workspace' }));
    const form = await screen.findByRole('form', { name: 'New project' });
    expect(within(form).getByLabelText(/^Name/)).toBe(document.activeElement);
    expect(await api.workspaces()).toEqual([expect.objectContaining({ name: 'Example Co', role: 'owner' })]);
    // The new workspace is the one every call is made in.
    expect(await api.projects()).toEqual([]);
  });

  it('offers no step to anyone else', async () => {
    const api = createFixtureTasksApi({ workspaces: [] });
    const create = vi.spyOn(api, 'createWorkspace');
    renderApp('/tasks', api);
    expect(await screen.findByRole('link', { name: 'Source code' })).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'New workspace' })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
