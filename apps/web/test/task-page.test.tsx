import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
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

/** The field a fact's menu offers for a value typed out; the menu of its presets shares its name. */
function typedField(name: string): HTMLInputElement {
  const input = screen.getAllByLabelText(name).find((element) => element instanceof HTMLInputElement);
  if (!input) throw new Error(`No field named ${name}`);
  return input as HTMLInputElement;
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

  it('shows the helper a held task’s holder works through, its work details and its last activity', async () => {
    renderApp('/tasks/web-k3m9.2');
    await screen.findByRole('heading', { level: 1, name: 'Check the sign-in form with a screen reader' });
    expect(fact('Assignee').textContent).toContain('a11y-check-1');
    expect(fact('Last activity').textContent).toContain('12m');
    expect(fact('Next step').textContent).toContain('Announce the password error to screen readers');
    expect(fact('Branch').textContent).toContain('codex/sign-in-a11y');
    expect(within(fact('Pull request')).getByRole('link').getAttribute('href')).toBe(
      'https://github.example.com/example/web/pull/42',
    );
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

  it('shows the notes, the estimate, the due date, the pages it links to and its custom fields by their names', async () => {
    renderApp('/tasks/web-k3m9.2');
    await screen.findByRole('heading', { level: 1, name: 'Check the sign-in form with a screen reader' });
    const notes = document.querySelector('[data-task-field="Notes"]') as HTMLElement;
    expect(within(notes).getByText(/The error under the password field/)).toBeTruthy();
    expect(within(fact('Estimate')).getByText('1h 30m')).toBeTruthy();
    expect(fact('Due')).not.toBeNull();
    // The names the project gave its fields, once read, not the ones made from their keys.
    expect(await screen.findByRole('button', { name: 'Product area: Accessibility' })).toBeTruthy();
    expect(fact('Area')).toBeNull();
    expect(within(fact('Points')).getByText('3')).toBeTruthy();
    expect(within(fact('Platforms')).getByText('Web, iOS')).toBeTruthy();
    expect(within(fact('Customer facing')).getByText('Yes')).toBeTruthy();
    const pull = screen.getByRole('link', { name: /Fix the tab order on the sign-in form/ });
    expect(pull.getAttribute('href')).toBe('https://github.example.com/example/web/pull/42');
    expect(pull.getAttribute('target')).toBe('_blank');
    expect(pull.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(pull.closest('section') as HTMLElement).getByText('Pull request')).toBeTruthy();
  });

  it('edits the notes and the design like the description', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-k3m9.2', api);
    fireEvent.click(await enabledButton('More'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add design' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Design' }), {
      target: { value: 'Announce each error with `aria-live`.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(task(api, 'web-k3m9.2')?.design).toBe('Announce each error with `aria-live`.'));
    expect(await screen.findByText('aria-live')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Every error is announced.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(task(api, 'web-k3m9.2')?.notes).toBe('Every error is announced.'));
  });

  it('edits the estimate as hours and minutes, and takes it off', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-t5w3', api);
    fireEvent.click(await enabledButton('Estimate: None'));
    const menu = await screen.findByRole('menu', { name: 'Estimate' });
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual(['30m', '1h', '2h', '4h', '8h']);
    const typed = screen.getByRole('textbox', { name: 'Estimate' });
    fireEvent.change(typed, { target: { value: 'soon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save estimate' }));
    expect(screen.getByText('Not a duration')).toBeTruthy();
    expect(typed.getAttribute('aria-invalid')).toBe('true');
    expect(task(api, 'web-t5w3')?.estimateMinutes).toBeUndefined();
    fireEvent.change(typed, { target: { value: '1h 15m' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save estimate' }));
    await waitFor(() => expect(task(api, 'web-t5w3')?.estimateMinutes).toBe(75));
    expect(await within(fact('Estimate')).findByText('1h 15m')).toBeTruthy();

    fireEvent.click(await enabledButton('Estimate: 1h 15m'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'None' }));
    await waitFor(() => expect(task(api, 'web-t5w3')?.estimateMinutes).toBeNull());
  });

  it('sets the due date and takes it off', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-t5w3', api);
    fireEvent.click(await enabledButton('Due: None'));
    fireEvent.change(await screen.findByLabelText('Due date'), { target: { value: '2030-01-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save due date' }));
    await waitFor(() => expect(task(api, 'web-t5w3')?.dueAt).toBe('2030-01-15T00:00:00.000Z'));
    expect(await within(fact('Due')).findByText('Jan 15, 2030')).toBeTruthy();

    fireEvent.click(await enabledButton('Due: Jan 15, 2030'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'None' }));
    await waitFor(() => expect(task(api, 'web-t5w3')?.dueAt).toBeNull());
  });

  it('adds a page the task links to, with its title and kind, and removes it with Undo', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-t5w3', api);
    fireEvent.click(await enabledButton('More'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add link' }));
    const form = document.querySelector('[data-task-form="link"]') as HTMLElement;
    const url = within(form).getByRole('textbox', { name: 'URL' });
    const title = within(form).getByRole('textbox', { name: 'Title' });
    // The required fields end their labels in an asterisk; Kind carries no mark.
    expect(url.getAttribute('aria-required')).toBe('true');
    expect(title.getAttribute('aria-required')).toBe('true');
    expect(within(form).getByText('URL').textContent).toBe('URL*');
    expect(within(form).getByText('Kind').textContent).toBe('Kind');

    fireEvent.change(url, { target: { value: 'example.com/spec' } });
    fireEvent.blur(url);
    expect(within(form).getByText('Not an http or https address')).toBeTruthy();
    expect(url.getAttribute('aria-invalid')).toBe('true');
    const add = within(form).getByRole('button', { name: 'Add link' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);

    fireEvent.change(url, { target: { value: 'https://example.com/spec' } });
    fireEvent.change(title, { target: { value: 'The sign-in spec' } });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Kind' }), { target: { value: 'document' } });
    fireEvent.click(add);
    await waitFor(() =>
      expect(task(api, 'web-t5w3')?.externalLinks).toEqual([
        { url: 'https://example.com/spec', title: 'The sign-in spec', kind: 'document' },
      ]),
    );
    const links = (await screen.findByText('Document')).closest('section') as HTMLElement;
    expect(
      within(links)
        .getByRole('link', { name: /The sign-in spec/ })
        .getAttribute('href'),
    ).toBe('https://example.com/spec');
    expect(document.querySelector('[data-task-form="link"]')).toBeNull();

    fireEvent.click(within(links).getByRole('button', { name: 'Remove The sign-in spec' }));
    await waitFor(() => expect(task(api, 'web-t5w3')?.externalLinks).toEqual([]));
    const removed = (await screen.findByText('Removed the link')).closest('li') as HTMLElement;
    fireEvent.click(within(removed).getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(task(api, 'web-t5w3')?.externalLinks).toEqual([
        { url: 'https://example.com/spec', title: 'The sign-in spec', kind: 'document' },
      ]),
    );
  });

  it("draws each custom field's editor by its type, and a retired field as words", async () => {
    renderApp('/tasks/web-k3m9.2');
    const close = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    const picks = (menu: HTMLElement) =>
      [...menu.querySelectorAll('[role^="menuitem"]')].map(
        (item) => `${item.textContent}${item.getAttribute('aria-checked') === 'true' ? ' ✓' : ''}`,
      );

    fireEvent.click(await enabledButton('Product area: Accessibility'));
    expect(picks(await screen.findByRole('menu', { name: 'Product area' }))).toEqual([
      'Accessibility ✓',
      'Email',
      'Sign-in',
      'Performance',
      'None',
    ]);
    close();
    fireEvent.click(await enabledButton('Platforms: Web, iOS'));
    expect(picks(await screen.findByRole('menu', { name: 'Platforms' }))).toEqual(['Web ✓', 'iOS ✓', 'Android']);
    close();
    fireEvent.click(await enabledButton('Customer facing: Yes'));
    expect(picks(await screen.findByRole('menu', { name: 'Customer facing' }))).toEqual(['Yes ✓', 'No', 'None']);
    close();
    fireEvent.click(await enabledButton('Release date: None'));
    expect(picks(await screen.findByRole('menu', { name: 'Release date' }))).toEqual([
      'Today',
      'Tomorrow',
      'In a week',
    ]);
    expect(typedField('Release date').type).toBe('date');
    close();
    fireEvent.click(await enabledButton('Points: 3'));
    const points = await screen.findByRole('textbox', { name: 'Points' });
    expect([(points as HTMLInputElement).value, points.getAttribute('inputmode')]).toEqual(['3', 'decimal']);
    expect(picks(screen.getByRole('menu', { name: 'Points' }))).toEqual(['None']);
    close();
    fireEvent.click(await enabledButton('Spec: None'));
    expect(((await screen.findByRole('textbox', { name: 'Spec' })) as HTMLInputElement).type).toBe('url');
    close();
    fireEvent.click(await enabledButton('Team: None'));
    expect(((await screen.findByRole('textbox', { name: 'Team' })) as HTMLInputElement).type).toBe('text');
    close();
    // A retired field keeps its value, as words only.
    expect(within(fact('Sprint')).getByText('Sprint 14')).toBeTruthy();
    expect(within(fact('Sprint')).queryByRole('button')).toBeNull();
  });

  it('edits a choice, a multiple choice and a yes or no field through the API, and takes one off', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-k3m9.2', api);
    const values = () => task(api, 'web-k3m9.2')?.fields ?? {};

    fireEvent.click(await enabledButton('Product area: Accessibility'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Email' }));
    await waitFor(() => expect(values().area).toBe('Email'));

    fireEvent.click(await enabledButton('Platforms: Web, iOS'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Android' }));
    await waitFor(() => expect(values().platforms).toEqual(['Web', 'iOS', 'Android']));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Web', checked: true }));
    await waitFor(() => expect(values().platforms).toEqual(['iOS', 'Android']));
    // A second press before the first is read back builds on it, so neither is lost.
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Web', checked: false }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'iOS', checked: true }));
    await waitFor(() => expect(values().platforms).toEqual(['Web', 'Android']));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    fireEvent.click(await enabledButton('Customer facing: Yes'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'No' }));
    await waitFor(() => expect(values().customer_facing).toBe(false));

    fireEvent.click(await enabledButton('Product area: Email'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'None' }));
    await waitFor(() => expect(values().area).toBeUndefined());
    expect(await screen.findByRole('button', { name: 'Product area: None' })).toBeTruthy();
  });

  it('edits a number, a text, a date and a URL field through the API, refusing a value of the wrong type', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-k3m9.2', api);
    const values = () => task(api, 'web-k3m9.2')?.fields ?? {};
    async function type(button: string, field: string, value: string) {
      fireEvent.click(await enabledButton(button));
      await waitFor(() => typedField(field));
      fireEvent.change(typedField(field), { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: `Save ${field.toLowerCase()}` }));
    }

    await type('Points: 3', 'Points', 'many');
    expect(screen.getByText('Not a number')).toBeTruthy();
    expect(typedField('Points').getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(typedField('Points'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save points' }));
    await waitFor(() => expect(values().story_points).toBe(5));

    await type('Spec: None', 'Spec', 'example.com/spec');
    expect(screen.getByText('Not an http or https address')).toBeTruthy();
    expect(values().spec).toBeUndefined();
    fireEvent.change(typedField('Spec'), { target: { value: 'https://example.com/spec' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save spec' }));
    await waitFor(() => expect(values().spec).toBe('https://example.com/spec'));
    const spec = await within(fact('Spec')).findByRole('link', { name: 'example.com/spec' });
    expect([spec.getAttribute('href'), spec.getAttribute('target')]).toEqual(['https://example.com/spec', '_blank']);

    await type('Release date: None', 'Release date', '2030-02-01');
    await waitFor(() => expect(values().release_date).toBe('2030-02-01'));
    expect(await within(fact('Release date')).findByText('Feb 1, 2030')).toBeTruthy();

    await type('Team: None', 'Team', 'Accessibility guild');
    await waitFor(() => expect(values().team).toBe('Accessibility guild'));
    fireEvent.click(await enabledButton('Team: Accessibility guild'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'None' }));
    await waitFor(() => expect(values().team).toBeUndefined());
  });

  it("names a custom field from its key, read-only, while the project's fields cannot be read", async () => {
    const api = createFixtureTasksApi();
    let asked = 0;
    api.fields = () => {
      asked += 1;
      return Promise.reject(new ApiError('The fields of web: the server answered 503.', 503, null));
    };
    renderApp('/tasks/web-k3m9.2', api);
    await enabledButton('Priority: High');
    await waitFor(() => expect(asked).toBeGreaterThan(0));
    expect(within(fact('Area')).getByText('Accessibility')).toBeTruthy();
    expect(within(fact('Story points')).getByText('3')).toBeTruthy();
    expect(within(fact('Area')).queryByRole('button')).toBeNull();
    expect(fact('Team')).toBeNull();
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

  describe('an approval an agent relayed for the person', () => {
    const answer = {
      option: 'approve',
      quote: 'Approve web-g7p2',
      source: 'claude-code:session/example-session',
      recordedBy: 'agent:example',
      relayed: true,
      proposalVersion: '0123456789abcdef0123456789abcdef',
      at: '2026-11-06T12:00:00.000Z',
      disputedBy: null,
    };
    const approved = {
      status: 'closed',
      resolution: 'done',
      closeReason: 'Owner approved the recorded scope',
      closedAt: '2026-11-06T12:00:00.000Z',
    };

    it('shows what was recorded, by whom and from where, and disputes it', async () => {
      const api = createFixtureTasksApi();
      Object.assign(task(api, 'web-g7p2')!, { ...approved, answer });
      renderApp('/tasks/web-g7p2', api);

      const recorded = await screen.findByRole('region', { name: 'Recorded answer' });
      expect(within(recorded).getByRole('heading', { name: 'Approved' })).toBeTruthy();
      expect(within(recorded).getByText(answer.quote)).toBeTruthy();
      // The recorder by name, as every byline shows an agent.
      expect(within(recorded).getByText('example')).toBeTruthy();
      expect(within(recorded).getByText(`Relayed from ${answer.source}`)).toBeTruthy();
      fireEvent.click(await enabledButton('Dispute', recorded));
      await waitFor(() => expect(task(api, 'web-g7p2')?.status).toBe('open'));
    });

    it('offers no dispute once it is disputed', async () => {
      const api = createFixtureTasksApi();
      Object.assign(task(api, 'web-g7p2')!, { answer: { ...answer, disputedBy: 'Example Person' } });
      renderApp('/tasks/web-g7p2', api);
      const recorded = await screen.findByRole('region', { name: 'Recorded answer' });
      expect(within(recorded).getByText(/Disputed by Example Person/u)).toBeTruthy();
      expect(within(recorded).queryByRole('button', { name: 'Dispute' })).toBeNull();
    });
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
