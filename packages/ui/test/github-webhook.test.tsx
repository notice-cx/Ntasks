import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { fixtureWorkspaces } from '@/api/fixture-data';
import { enabledButton, renderApp } from './render';

async function webhookForm(): Promise<HTMLElement> {
  return screen.findByRole('form', { name: 'GitHub webhook' });
}

describe('the GitHub webhook on the Settings page', () => {
  it('lets an owner make a secret, save it with deploy checks, change the checks alone and remove the webhook', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/settings', api);
    let form = await webhookForm();
    expect(within(form).getByText(/\/api\/github\/0f6c2a52-6d1e-4c39-9a57-2f1b8e4d7a10$/u)).toBeTruthy();
    expect(within(form).getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
    expect(within(form).queryByRole('button', { name: 'Remove' })).toBeNull();

    fireEvent.click(within(form).getByRole('button', { name: 'Make a secret' }));
    const secret = within(form).getByLabelText<HTMLInputElement>(/^Secret/);
    expect(secret.required).toBe(true);
    expect(secret.value).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    fireEvent.change(within(form).getByLabelText(/^Deploy checks/), {
      target: { value: 'Workers Builds: app\n\n production \n' },
    });
    fireEvent.click(await enabledButton('Save', form));
    await waitFor(async () =>
      expect(await api.githubWebhook()).toMatchObject({
        secretSaved: true,
        deployChecks: ['Workers Builds: app', 'production'],
      }),
    );

    // The form starts again from what was saved, and never shows the secret again.
    form = await webhookForm();
    await waitFor(() => expect(within(form).getByLabelText<HTMLInputElement>(/^Secret/).value).toBe(''));
    expect(within(form).getByLabelText<HTMLInputElement>(/^Secret/).required).toBe(false);
    fireEvent.change(within(form).getByLabelText(/^Deploy checks/), { target: { value: 'production' } });
    fireEvent.click(await enabledButton('Save', form));
    await waitFor(async () => expect((await api.githubWebhook()).deployChecks).toEqual(['production']));

    form = await webhookForm();
    fireEvent.click(await enabledButton('Remove', form));
    fireEvent.click(form.querySelector('[data-confirm-remove]') as HTMLElement);
    await waitFor(async () => expect((await api.githubWebhook()).secretSaved).toBe(false));
  });

  it('shows a refused secret under its field', async () => {
    renderApp('/tasks/settings', createFixtureTasksApi());
    const form = await webhookForm();
    const secret = within(form).getByLabelText<HTMLInputElement>(/^Secret/);
    fireEvent.change(secret, { target: { value: 'too short' } });
    fireEvent.click(await enabledButton('Save', form));
    await waitFor(() => expect(secret.getAttribute('aria-invalid')).toBe('true'));
    fireEvent.change(secret, { target: { value: 'still too short' } });
    expect(secret.getAttribute('aria-invalid')).toBeNull();
  });

  it('is not shown to a member', async () => {
    const [, labs] = fixtureWorkspaces(Date.now());
    renderApp('/tasks/settings', createFixtureTasksApi({ workspaces: labs ? [labs] : [] }));
    await screen.findByRole('region', { name: 'Connected apps' });
    expect(screen.queryByRole('region', { name: 'GitHub' })).toBeNull();
  });
});
