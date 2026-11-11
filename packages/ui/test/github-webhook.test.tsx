import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createHttpTasksApi } from '@/api/client';
import { createFixtureTasksApi } from '@/api/fixture';
import { fixtureWorkspaces } from '@/api/fixture-data';
import { enabledButton, renderApp } from './render';

/** The webhook's form on the Settings page, under Set up by hand, once it shows. */
async function webhookForm(): Promise<HTMLElement> {
  const byHand = (await screen.findByText('Set up by hand')).closest('details');
  if (byHand && !byHand.open) fireEvent.click(within(byHand).getByText('Set up by hand'));
  return screen.findByRole('form', { name: 'GitHub webhook' });
}

/** The fixture's first workspace, owned by the person, with a GitHub App made, installed on one organization, and one deploy seen. */
function connectedApi(byHand = false) {
  const [example, ...rest] = fixtureWorkspaces(Date.now());
  const at = new Date().toISOString();
  return createFixtureTasksApi({
    workspaces: example
      ? [
          {
            ...example,
            ...(byHand ? { github: { secret: 'a'.repeat(40), deployChecks: ['deploy'], updatedAt: at } } : {}),
            githubApp: {
              slug: 'ntasks-example',
              createdAt: at,
              installations: [
                { installationId: 7, account: 'example-org', accountType: 'Organization', createdAt: at },
              ],
              detected: [{ name: 'Workers Builds: site', on: true, seenAt: at }],
            },
          },
          ...rest,
        ]
      : rest,
  });
}

describe('Connect GitHub on the Settings page', () => {
  it('posts the manifest to GitHub from one button', async () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    try {
      renderApp('/tasks/settings/github', createFixtureTasksApi());
      fireEvent.click(await enabledButton('Connect GitHub'));
      await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
      const form = submit.mock.contexts[0] as HTMLFormElement;
      expect(form.method).toBe('post');
      expect(form.action).toBe('https://github.com/settings/apps/new?state=fixture');
      expect((form.elements.namedItem('manifest') as HTMLInputElement).value).toContain('Ntasks fixture');
    } finally {
      submit.mockRestore();
    }
  });

  it('says to press Connect GitHub again when GitHub did not finish', async () => {
    renderApp('/tasks/settings?github=retry', createFixtureTasksApi());
    expect(await screen.findByText("GitHub didn't finish connecting. Press Connect GitHub again.")).toBeTruthy();
  });

  it('keeps a webhook saved by hand reachable once the app is connected', async () => {
    renderApp('/tasks/settings/github', connectedApi(true));
    const section = await screen.findByRole('region', { name: 'GitHub' });
    expect(await within(section).findByText('example-org')).toBeTruthy();
    expect(within(section).getByText('Set up by hand')).toBeTruthy();
    expect(await webhookForm()).toBeTruthy();
  });

  it('shows where the app is installed, links to install it, switches a deploy off and disconnects', async () => {
    const api = connectedApi();
    renderApp('/tasks/settings/github', api);
    const section = await screen.findByRole('region', { name: 'GitHub' });
    expect(await within(section).findByText('example-org')).toBeTruthy();
    expect(within(section).getByRole('link', { name: 'ntasks-example' }).getAttribute('href')).toBe(
      'https://github.com/apps/ntasks-example',
    );
    expect(within(section).getByRole('link', { name: 'Install on your account' }).getAttribute('href')).toBe(
      'https://github.com/apps/ntasks-example/installations/new/permissions?target_id=1',
    );
    expect(within(section).getByRole('link', { name: 'Install on an organization' }).getAttribute('href')).toBe(
      'https://github.com/apps/ntasks-example/installations/new',
    );
    // Set up by hand stays there, closed, for a webhook beside the app.
    expect(within(section).getByText('Set up by hand').closest('details')?.open).toBe(false);

    fireEvent.click(within(section).getByRole('checkbox', { name: 'Workers Builds: site counts as a deploy' }));
    await waitFor(async () => expect((await api.githubWebhook()).detected[0]?.on).toBe(false));

    fireEvent.click(within(section).getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(section.querySelector('[data-confirm-disconnect]') as HTMLElement);
    await waitFor(async () => expect((await api.githubWebhook()).app).toBeNull());
    expect(await within(section).findByRole('button', { name: 'Connect GitHub' })).toBeTruthy();
  });
});

describe('Merges go live on the Settings page', () => {
  it('lists each repository a merge moved a task in, and ticking one moves its merged tasks to Live', async () => {
    const api = connectedApi();
    renderApp('/tasks/settings/github', api);
    const group = await screen.findByRole('group', { name: 'Merges go live' });
    const docs = (await within(group).findByRole('checkbox', {
      name: 'Merges in example/docs go live',
    })) as HTMLInputElement;
    expect(
      within(group)
        .getAllByRole('checkbox')
        .map((box) => box.getAttribute('aria-label')),
    ).toEqual(['Merges in example/docs go live', 'Merges in example/web go live']);
    expect(docs.checked).toBe(false);

    fireEvent.click(docs);
    await waitFor(() => expect(api.state.tasks.find((task) => task.id === 'docs-y5u2')?.delivery?.stage).toBe('live'));
    await waitFor(() => expect(docs.checked).toBe(true));
    expect(await api.repositories()).toEqual([
      { repository: 'example/docs', mergesLive: true },
      { repository: 'example/web', mergesLive: false },
    ]);
  });
});

describe('the GitHub webhook on the Settings page', () => {
  it('lets an owner make a secret, save it with deploy checks, change the checks alone and remove the webhook', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/settings/github', api);
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
    renderApp('/tasks/settings/github', createFixtureTasksApi());
    const form = await webhookForm();
    const secret = within(form).getByLabelText<HTMLInputElement>(/^Secret/);
    fireEvent.change(secret, { target: { value: 'too short' } });
    fireEvent.click(await enabledButton('Save', form));
    await waitFor(() => expect(secret.getAttribute('aria-invalid')).toBe('true'));
    fireEvent.change(secret, { target: { value: 'still too short' } });
    expect(secret.getAttribute('aria-invalid')).toBeNull();
  });

  it("shows the server's reason when GitHub cannot be read", async () => {
    const detail = "This Ntasks's database lacks migration 0003_github_apps.sql, which its code needs.";
    const behind = createHttpTasksApi(async () =>
      Response.json({ error: 'database_behind', missing: ['0003_github_apps.sql'], detail }, { status: 503 }),
    );
    renderApp('/tasks/settings/github', { ...createFixtureTasksApi(), githubWebhook: behind.githubWebhook });
    const section = await screen.findByRole('region', { name: 'GitHub' });
    expect(await within(section).findByText(detail)).toBeTruthy();
  });

  it('is not shown to a member', async () => {
    const [, labs] = fixtureWorkspaces(Date.now());
    renderApp('/tasks/settings/github', createFixtureTasksApi({ workspaces: labs ? [labs] : [] }));
    // The tab is not offered, and its address opens the first tab instead.
    await screen.findByRole('region', { name: 'Workspace' });
    expect(screen.queryByRole('link', { name: 'GitHub' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'GitHub' })).toBeNull();
  });
});
