import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { fixtureWorkspaces } from '@/api/fixture-data';
import { enabledButton, renderApp } from './render';

/** The row of the app with this client id, once it shows. */
async function appRow(clientId: string): Promise<HTMLElement> {
  let row: HTMLElement | null = null;
  await waitFor(() => {
    row = document.querySelector<HTMLElement>(`[data-app-row="${clientId}"]`);
    expect(row).not.toBeNull();
  });
  return row as unknown as HTMLElement;
}

describe('connected apps on the Settings page', () => {
  it('lets an owner register an app, copy its client ID and remove it for everyone', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/settings/apps', api);
    fireEvent.click(await enabledButton('Register app'));
    const form = await screen.findByRole('form', { name: 'Register app' });
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'Example Portal' } });
    const address = within(form).getByLabelText(/^Redirect address/);
    fireEvent.change(address, { target: { value: 'http://portal.example.com/signed-in' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(address.getAttribute('aria-invalid')).toBe('true'));
    fireEvent.change(address, { target: { value: 'https://portal.example.com/signed-in' } });
    expect(address.getAttribute('aria-invalid')).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Register app' })).toBeNull());

    const registered = (await api.apps()).find((app) => app.name === 'Example Portal');
    expect(registered).toMatchObject({ redirectUris: ['https://portal.example.com/signed-in'], connectedAt: null });
    const row = await appRow(registered?.clientId ?? '');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      fireEvent.click(within(row).getByRole('button', { name: 'Copy client ID' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(registered?.clientId));
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }

    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    fireEvent.click(row.querySelector('[data-confirm-remove]') as HTMLElement);
    await waitFor(() => expect(document.querySelector(`[data-app-row="${registered?.clientId}"]`)).toBeNull());
    expect((await api.apps()).map((app) => app.clientId)).not.toContain(registered?.clientId);
  });

  it('lets a member revoke their own sign-in to an app, without the owner’s controls', async () => {
    const [, labs] = fixtureWorkspaces(Date.now());
    const at = new Date().toISOString();
    const api = createFixtureTasksApi({
      workspaces: labs
        ? [
            {
              ...labs,
              apps: [
                {
                  clientId: 'c-example-portal',
                  name: 'Example Portal',
                  redirectUris: ['https://portal.example.com/signed-in'],
                  createdAt: at,
                  connectedAt: at,
                },
              ],
            },
          ]
        : [],
    });
    renderApp('/tasks/settings/apps', api);
    const row = await appRow('c-example-portal');
    expect(screen.queryByRole('button', { name: 'Register app' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Remove' })).toBeNull();

    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(within(row).queryByRole('button', { name: 'Revoke' })).toBeNull());
    expect((await api.apps())[0]?.connectedAt).toBeNull();
  });
});
