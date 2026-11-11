import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { enabledButton, renderApp } from './render';

/** The row of the credential with this id, once it shows. */
async function serviceRow(id: string): Promise<HTMLElement> {
  let row: HTMLElement | null = null;
  await waitFor(() => {
    row = document.querySelector<HTMLElement>(`[data-service-row="${id}"]`);
    expect(row).not.toBeNull();
  });
  return row as unknown as HTMLElement;
}

async function openForm(): Promise<HTMLElement> {
  fireEvent.click(await enabledButton('New credential'));
  return screen.findByRole('form', { name: 'New credential' });
}

describe('service credentials on the Settings page', () => {
  it('makes a credential with the chosen name, projects and choices, shows its token once, and lists it', async () => {
    const api = createFixtureTasksApi();
    const [first, second] = await api.projects();
    if (!first || !second) throw new Error('the fixture has two projects');
    const create = vi.spyOn(api, 'createServiceCredential');
    renderApp('/tasks/settings/services', api);

    const form = await openForm();
    const submit = within(form).getByRole('button', { name: 'Make credential' });
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'noticeos-laptop' } });
    // A credential reaches a project or backs up or loads the workspace; a name alone makes nothing.
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    const access = (name: string) => within(form).getByRole('combobox', { name: `${name} access` });
    await waitFor(() => access(first.displayName));
    fireEvent.change(access(first.displayName), { target: { value: 'write' } });
    fireEvent.change(access(second.displayName), { target: { value: 'read' } });
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Back up every project' }));
    fireEvent.click(submit);

    const shown = await screen.findByRole('region', { name: 'Token for noticeos-laptop' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toEqual({
      name: 'noticeos-laptop',
      grants: [
        { projectId: first.projectId, access: 'write' },
        { projectId: second.projectId, access: 'read' },
      ],
      backup: true,
      restore: false,
    });
    const token = (await create.mock.results[0]?.value)?.token ?? '';
    expect(token).not.toBe('');
    expect(shown.textContent).toContain(token);
    expect(screen.queryByRole('form', { name: 'New credential' })).toBeNull();

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      fireEvent.click(within(shown).getByRole('button', { name: 'Copy token' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(token));
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }

    fireEvent.click(within(shown).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Token for noticeos-laptop' })).toBeNull());
    const [listed] = await api.serviceCredentials();
    const row = await serviceRow(listed?.id ?? '');
    expect(within(row).getByRole('button', { name: 'Revoke' })).toBeTruthy();
    expect(document.body.textContent).not.toContain(token);
  });

  it('revokes a credential: it leaves the working list, and its name stays taken', async () => {
    const api = createFixtureTasksApi();
    const [project] = await api.projects();
    if (!project) throw new Error('the fixture has a project');
    const made = await api.createServiceCredential({
      name: 'nightly-backup',
      grants: [],
      backup: true,
      restore: false,
    });
    renderApp('/tasks/settings/services', api);

    const working = await screen.findByRole('list', { name: 'Credentials' });
    const row = await serviceRow(made.id);
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    fireEvent.click(row.querySelector('[data-confirm-revoke]') as HTMLElement);
    await waitFor(() => expect(working.isConnected).toBe(false));
    expect((await api.serviceCredentials())[0]?.revokedAt).not.toBeNull();
    const revoked = await screen.findByRole('list', { name: 'Revoked credentials' });
    expect(within(revoked).queryByRole('button', { name: 'Revoke' })).toBeNull();

    // The refusal of a name a revoked credential keeps shows under the name.
    const form = await openForm();
    const name = within(form).getByLabelText(/^Name/);
    fireEvent.change(name, { target: { value: 'nightly-backup' } });
    fireEvent.change(await within(form).findByRole('combobox', { name: `${project.displayName} access` }), {
      target: { value: 'read' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Make credential' }));
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'));
    fireEvent.change(name, { target: { value: 'nightly-backup-2' } });
    expect(name.getAttribute('aria-invalid')).toBeNull();
  });

  it('shows a failed project read with Retry in the form, and lists the projects once a retry reads them', async () => {
    const api = createFixtureTasksApi();
    const projects = api.projects.bind(api);
    let failing = true;
    vi.spyOn(api, 'projects').mockImplementation(async (signal) => {
      if (failing) throw new Error('The project list: the server answered 503.');
      return projects(signal);
    });
    renderApp('/tasks/settings/services', api);
    const form = await openForm();
    const retry = await within(form).findByRole('button', { name: /Retry/u });
    failing = false;
    fireEvent.click(retry);
    const [first] = await projects();
    expect(await within(form).findByRole('combobox', { name: `${first!.displayName} access` })).toBeTruthy();
  });

  it('keeps the form while a credential is being made, whatever Escape asks', async () => {
    const api = createFixtureTasksApi();
    let finish: () => void = () => {};
    const made = api.createServiceCredential.bind(api);
    vi.spyOn(api, 'createServiceCredential').mockImplementation(
      (input, options) =>
        new Promise((resolve, reject) => {
          finish = () => void made(input, options).then(resolve, reject);
        }),
    );
    renderApp('/tasks/settings/services', api);
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'nightly-backup' } });
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Back up every project' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Make credential' }));
    await waitFor(() => expect(api.createServiceCredential).toHaveBeenCalled());
    fireEvent.keyDown(form, { key: 'Escape' });
    expect(form.isConnected).toBe(true);
    finish();
    expect(await screen.findByRole('region', { name: 'Token for nightly-backup' })).toBeTruthy();
  });

  it('lists a credential whose answer was lost, so the owner can revoke it', async () => {
    const api = createFixtureTasksApi();
    const made = api.createServiceCredential.bind(api);
    vi.spyOn(api, 'createServiceCredential').mockImplementation(async (input, options) => {
      await made(input, options);
      throw new TypeError('Failed to fetch');
    });
    renderApp('/tasks/settings/services', api);
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'nightly-backup' } });
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Back up every project' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Make credential' }));
    const [lost] = await waitFor(async () => {
      const listed = await api.serviceCredentials();
      expect(listed).toHaveLength(1);
      return listed;
    });
    const row = await serviceRow(lost!.id);
    expect(within(row).getByRole('button', { name: 'Revoke' })).toBeTruthy();
  });
});
