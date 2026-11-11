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

/** Opens the Add field menu and picks `name`, which shows that field's editor in the same menu. */
async function addField(name: string): Promise<void> {
  fireEvent.click(await enabledButton('Add field'));
  const menu = await screen.findByRole('menu', { name: 'Add field' });
  fireEvent.click(within(menu).getByRole('menuitem', { name }));
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
    expect(fact('Touches').textContent).toContain('src/pages/sign-in/fields.ts');
    expect(within(fact('Pull request')).getByRole('link').getAttribute('href')).toBe(
      'https://github.example.com/example/web/pull/42',
    );
  });

  it("shows the facts its epic pinned for its tasks, and what the epic's closed tasks left", async () => {
    renderApp('/tasks/web-k3m9.2');
    await screen.findByRole('heading', { level: 1, name: 'Check the sign-in form with a screen reader' });
    const fromEpic = await screen.findByRole('region', { name: 'From the epic' });
    const pinned = fromEpic.querySelector('[data-parent-pinned]') as HTMLElement;
    expect(within(pinned).getByText(/change them there/u)).toBeTruthy();
    const closed = fromEpic.querySelector('[data-parent-closed]') as HTMLElement;
    expect(closed.querySelector('[data-closed-sibling="web-k3m9.1"]')?.textContent).toContain(
      'the form renders its fields and errors',
    );
  });

  it('lists the closed tasks that closed at the same time lowest id first, as the Worker does', async () => {
    const api = createFixtureTasksApi();
    const closed = task(api, 'web-k3m9.1');
    if (!closed) throw new Error('The seed has no web-k3m9.1');
    const at = '2999-01-01T00:00:00.000Z';
    for (const id of ['web-k3m9.9', 'web-k3m9.4', 'web-k3m9.8', 'web-k3m9.5', 'web-k3m9.7', 'web-k3m9.6']) {
      api.state.tasks.push({ ...structuredClone(closed), id, closedAt: at });
    }
    const { parent } = await api.task('web-k3m9.2', 'web');
    expect(parent?.closedSiblings.map((sibling) => sibling.id)).toEqual([
      'web-k3m9.4',
      'web-k3m9.5',
      'web-k3m9.6',
      'web-k3m9.7',
      'web-k3m9.8',
    ]);
    expect(parent?.closedSiblingsTotal).toBe(7);
  });

  it('marks a pinned comment among the comments of the task it is pinned on', async () => {
    renderApp('/tasks/web-k3m9');
    await screen.findByRole('heading', { level: 1, name: 'Ship the new sign-in page' });
    await waitFor(() => expect(document.querySelector('[data-comment-pinned]')?.textContent).toBe('Pinned'));
    expect(screen.queryByRole('region', { name: 'From the epic' })).toBeNull();
  });

  describe("the action keys act on the page's task", () => {
    async function open(api: ReturnType<typeof createFixtureTasksApi>) {
      renderApp('/tasks/web-b2r6', api);
      // The keys wait for the sign-in's permissions, as the page's buttons do.
      await enabledButton('Claim');
    }
    const press = (key: string) => fireEvent.keyDown(document.body, { key });

    it('M claims it', async () => {
      const api = createFixtureTasksApi();
      await open(api);
      press('m');
      await waitFor(() => expect(task(api, 'web-b2r6')?.assignee).toBe(FIXTURE_ACTOR));
    });

    it('A opens Assignee', async () => {
      const api = createFixtureTasksApi();
      await open(api);
      press('a');
      const menu = await screen.findByRole('menu', { name: 'Assignee' });
      fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Codex' }));
      await waitFor(() => expect(task(api, 'web-b2r6')?.assignee).toBe('agent:codex'));
    });

    it('P opens Priority', async () => {
      const api = createFixtureTasksApi();
      await open(api);
      press('p');
      const menu = await screen.findByRole('menu', { name: 'Priority' });
      fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Low' }));
      await waitFor(() => expect(task(api, 'web-b2r6')?.priority).toBe(3));
    });

    it('Z opens Parked until', async () => {
      const api = createFixtureTasksApi();
      await open(api);
      press('z');
      const menu = await screen.findByRole('menu', { name: 'Parked until' });
      fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Tomorrow' }));
      await waitFor(() => expect(task(api, 'web-b2r6')?.deferUntil).not.toBeNull());
    });
  });

  it('names who filed the task with their avatar, and an import that recorded nobody as Filed alone', async () => {
    const api = createFixtureTasksApi();
    const imported = task(api, 'web-q8n5');
    if (!imported) throw new Error('The seed has no web-q8n5');
    imported.filedBy = null;
    imported.filedModel = null;
    const filedEntry = () => document.querySelector('[data-timeline-entry="filed"]') as HTMLElement;

    const { unmount } = renderApp('/tasks/web-b2r6', api);
    await screen.findByRole('heading', { level: 1, name: 'Fix the broken reset link in the welcome email' });
    await waitFor(() => expect(filedEntry().textContent).toContain('Claude filed this'));
    expect(filedEntry().querySelector('[data-avatar]')?.getAttribute('data-avatar')).toBe('claude');
    unmount();

    renderApp('/tasks/web-q8n5', api);
    await screen.findByRole('heading', { level: 1, name: 'Confirm the support address on the error page' });
    await waitFor(() => expect(filedEntry().textContent).toContain('Filed'));
    expect(filedEntry().textContent).not.toContain('filed this');
    expect(filedEntry().querySelector('[data-avatar]')).toBeNull();
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
    await addField('Release date');
    expect(picks(await screen.findByRole('menu', { name: 'Release date' }))).toEqual([
      'Today',
      'Tomorrow',
      'In a week',
    ]);
    // The menu shows the editor in its list's place, and focus moves to the editor's first value.
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Today' }));
    expect(typedField('Release date').type).toBe('date');
    close();
    fireEvent.click(await enabledButton('Points: 3'));
    const points = await screen.findByRole('textbox', { name: 'Points' });
    expect([(points as HTMLInputElement).value, points.getAttribute('inputmode')]).toEqual(['3', 'decimal']);
    expect(picks(screen.getByRole('menu', { name: 'Points' }))).toEqual(['None']);
    close();
    await addField('Spec');
    expect(((await screen.findByRole('textbox', { name: 'Spec' })) as HTMLInputElement).type).toBe('url');
    close();
    await addField('Team');
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

    // A field taken off leaves the panel, and Add field offers it again.
    fireEvent.click(await enabledButton('Product area: Email'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'None' }));
    await waitFor(() => expect(values().area).toBeUndefined());
    await waitFor(() => expect(fact('Product area')).toBeNull());
    fireEvent.click(await enabledButton('Add field'));
    const offered = await screen.findByRole('menu', { name: 'Add field' });
    expect(within(offered).getByRole('menuitem', { name: 'Product area' })).toBeTruthy();
  });

  it('saves the presses of a multiple choice in the order made, so a slow first save never lands last', async () => {
    const api = createFixtureTasksApi();
    const update = api.updateTask.bind(api);
    let release: (() => void) | null = null;
    let first = true;
    api.updateTask = async (...args) => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return update(...args);
    };
    renderApp('/tasks/web-k3m9.2', api);
    const values = () => task(api, 'web-k3m9.2')?.fields ?? {};
    fireEvent.click(await enabledButton('Platforms: Web, iOS'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Android' }));
    // The first save is held until the second press has been made.
    await waitFor(() => expect(release).not.toBeNull());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Web', checked: true }));
    (release as unknown as () => void)();
    await waitFor(() => expect(values().platforms).toEqual(['iOS', 'Android']));
  });

  it("undoes a field's save to what the task held, after a refused save and after another field", async () => {
    const api = createFixtureTasksApi();
    const update = api.updateTask.bind(api);
    let refuse = true;
    api.updateTask = async (...args) => {
      if (refuse) {
        refuse = false;
        throw new ApiError('The server answered 503.', 503, null);
      }
      return update(...args);
    };
    renderApp('/tasks/web-k3m9.2', api);
    const values = () => task(api, 'web-k3m9.2')?.fields ?? {};
    const undo = async (said: string) => {
      const saved = (await screen.findByText(said)).closest('li') as HTMLElement;
      fireEvent.click(within(saved).getByRole('button', { name: 'Undo' }));
    };
    // The first press is refused; the second, built on it, saves, and its Undo returns to the value the task held.
    fireEvent.click(await enabledButton('Platforms: Web, iOS'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Android' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Web', checked: true }));
    await waitFor(() => expect(values().platforms).toEqual(['iOS', 'Android']));
    await undo('Saved Platforms');
    await waitFor(() => expect(values().platforms).toEqual(['Web', 'iOS']));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    // Two fields set one after the other from Add field: the second's Undo takes off only its own value.
    await addField('Team');
    fireEvent.change(typedField('Team'), { target: { value: 'Growth' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save team' }));
    await waitFor(() => expect(values().team).toBe('Growth'));
    await addField('Spec');
    fireEvent.change(typedField('Spec'), { target: { value: 'https://example.com/spec' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save spec' }));
    await waitFor(() => expect(values().spec).toBe('https://example.com/spec'));
    await undo('Saved Spec');
    await waitFor(() => expect(values().spec).toBeUndefined());
    expect(values().team).toBe('Growth');
  });

  it('undoes a field set twice before the page reads it back to its first value, with another field set between', async () => {
    const api = createFixtureTasksApi();
    // The page keeps the task as first read, so Add field still offers Team after its first save.
    const first = await api.task('web-k3m9.2', 'web');
    api.task = async () => structuredClone(first);
    renderApp('/tasks/web-k3m9.2', api);
    const values = () => task(api, 'web-k3m9.2')?.fields ?? {};
    const save = async (field: string, value: string) => {
      await addField(field);
      fireEvent.change(typedField(field), { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: `Save ${field.toLowerCase()}` }));
    };
    await save('Team', 'Growth');
    await waitFor(() => expect(values().team).toBe('Growth'));
    await save('Spec', 'https://example.com/spec');
    await waitFor(() => expect(values().spec).toBe('https://example.com/spec'));
    await save('Team', 'Platform');
    await waitFor(() => expect(values().team).toBe('Platform'));
    // Toasts list the newest first.
    const saved = screen.getAllByText('Saved Team')[0]?.closest('li') as HTMLElement;
    fireEvent.click(within(saved).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(values().team).toBe('Growth'));
  });

  it('edits a number, a text, a date and a URL field through the API, refusing a value of the wrong type', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-k3m9.2', api);
    const values = () => task(api, 'web-k3m9.2')?.fields ?? {};
    /** Types `value` into `field`'s editor, opened from its line's button or, for a field with no value, from Add field. */
    async function type(button: string | null, field: string, value: string) {
      if (button === null) await addField(field);
      else fireEvent.click(await enabledButton(button));
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

    await type(null, 'Spec', 'example.com/spec');
    expect(screen.getByText('Not an http or https address')).toBeTruthy();
    expect(values().spec).toBeUndefined();
    fireEvent.change(typedField('Spec'), { target: { value: 'https://example.com/spec' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save spec' }));
    await waitFor(() => expect(values().spec).toBe('https://example.com/spec'));
    const spec = await waitFor(() => within(fact('Spec')).getByRole('link', { name: 'example.com/spec' }));
    expect([spec.getAttribute('href'), spec.getAttribute('target')]).toEqual(['https://example.com/spec', '_blank']);

    await type(null, 'Release date', '2030-02-01');
    await waitFor(() => expect(values().release_date).toBe('2030-02-01'));
    await waitFor(() => expect(fact('Release date')?.textContent).toContain('Feb 1, 2030'));

    await type(null, 'Team', 'Accessibility guild');
    await waitFor(() => expect(values().team).toBe('Accessibility guild'));
    fireEvent.click(await enabledButton('Team: Accessibility guild'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'None' }));
    await waitFor(() => expect(values().team).toBeUndefined());
  });

  it('lists only the custom fields a task holds, and sets another from Add field, which then gives it a line', async () => {
    const api = createFixtureTasksApi();
    const five = ['area', 'story_points', 'release_date', 'spec', 'team'];
    api.state.fields.set(
      'web',
      (api.state.fields.get('web') ?? []).filter((field) => five.includes(field.key)),
    );
    const held = task(api, 'web-b2r6');
    if (!held) throw new Error('The seed has no web-b2r6');
    held.fields = { area: 'Email', story_points: 2 };
    renderApp('/tasks/web-b2r6', api);
    await enabledButton('Product area: Email');
    const lines = () =>
      [...screen.getByRole('complementary', { name: 'Facts' }).querySelectorAll('[data-task-field-value]')].map(
        (value) => value.getAttribute('data-task-field-value'),
      );
    const offered = async () => {
      fireEvent.click(await enabledButton('Add field'));
      const menu = await screen.findByRole('menu', { name: 'Add field' });
      return within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent);
    };
    expect(lines()).toEqual(['area', 'story_points']);
    expect(await offered()).toEqual(['Release date', 'Spec', 'Team']);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Team' }));
    fireEvent.change(typedField('Team'), { target: { value: 'Growth' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save team' }));
    await waitFor(() => expect(task(api, 'web-b2r6')?.fields?.team).toBe('Growth'));
    await waitFor(() => expect(lines()).toEqual(['area', 'story_points', 'team']));
    expect(await offered()).toEqual(['Release date', 'Spec']);
  });

  it('offers no Add field once every field of the project holds a value', async () => {
    const api = createFixtureTasksApi();
    api.state.fields.set(
      'web',
      (api.state.fields.get('web') ?? []).filter((field) => field.key === 'area'),
    );
    renderApp('/tasks/web-b2r6', api);
    await enabledButton('Product area: Email');
    expect(screen.queryByRole('button', { name: 'Add field' })).toBeNull();
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

  describe('Done, my call', () => {
    it('closes as done on the person’s call, starting from the ticked boxes, and records the rest as waived', async () => {
      const api = createFixtureTasksApi();
      renderApp('/tasks/web-b2r6', api);
      fireEvent.click(await screen.findByRole('checkbox', { name: 'A new reset link opens the reset form' }));
      await waitFor(() => expect(task(api, 'web-b2r6')?.acceptance).toContain('- [x] A new reset link'));

      fireEvent.click(await enabledButton('Close'));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Done, my call' }));
      const form = document.querySelector('[data-task-form="accept"]') as HTMLElement;
      const box = (name: string) => within(form).getByRole('checkbox', { name }) as HTMLInputElement;
      expect(box('A new reset link opens the reset form').checked).toBe(true);
      expect(box('A test covers a link younger than an hour').checked).toBe(false);
      fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'The old links expire anyway.' } });
      fireEvent.click(within(form).getByRole('button', { name: 'Close, waiving 1 criterion' }));

      await waitFor(() => expect(task(api, 'web-b2r6')?.status).toBe('closed'));
      expect(task(api, 'web-b2r6')).toMatchObject({
        resolution: 'done',
        closeReason: 'The old links expire anyway.',
        proof: null,
        closeAcceptance: {
          by: FIXTURE_ACTOR,
          criteria: [
            { text: 'A new reset link opens the reset form', met: true },
            { text: 'A test covers a link younger than an hour', met: false },
          ],
        },
      });
      const closed = await screen.findByRole('region', { name: 'Closed as Done' });
      expect(within(closed).getByText(/1 criterion waived/u)).toBeTruthy();
      expect(
        within(within(closed).getByRole('list', { name: 'Waived' })).getByText(
          'A test covers a link younger than an hour',
        ),
      ).toBeTruthy();
      expect(within(closed).getByText('The old links expire anyway.')).toBeTruthy();
    });

    it('is offered on a task waiting on the person', async () => {
      const api = createFixtureTasksApi();
      const asked = api.state.tasks.find((entry) => entry.labels.includes('human') && entry.issueType !== 'gate')!;
      renderApp(`/tasks/${asked.id}`, api);
      fireEvent.click(await enabledButton('Close as'));
      expect(await screen.findByRole('menuitem', { name: 'Done, my call' })).toBeTruthy();
    });

    it('is not offered to a sign-in that may not accept', async () => {
      const limited = {
        ...createFixtureTasksApi(),
        capabilities: async () => ({ live: true, writable: true, operations: ['close', 'update'], reason: null }),
      };
      renderApp('/tasks/web-b2r6', limited);
      fireEvent.click(await enabledButton('Close'));
      await screen.findByRole('menuitem', { name: 'Done' });
      expect(screen.queryByRole('menuitem', { name: 'Done, my call' })).toBeNull();
    });

    it('shows an acceptance an agent relayed, from where and in the person’s words, and disputes it', async () => {
      const api = createFixtureTasksApi();
      Object.assign(task(api, 'web-b2r6')!, {
        status: 'closed',
        resolution: 'done',
        closeReason: 'Accepted as done',
        closedAt: '2026-11-06T12:00:00.000Z',
        closedBy: 'agent:example',
        closeAcceptance: {
          by: 'Example Person',
          relayed: { by: 'agent:example', source: 'claude-code:session/example-session', quote: 'Close it.' },
          criteria: [{ text: 'A new reset link opens the reset form', met: true }],
        },
      } satisfies Partial<LiveTask>);
      renderApp('/tasks/web-b2r6', api);

      const closed = await screen.findByRole('region', { name: 'Closed as Done' });
      expect(within(closed).getByText(/every criterion met/u)).toBeTruthy();
      expect(within(closed).getByText('Close it.')).toBeTruthy();
      expect(within(closed).getByText(/claude-code:session\/example-session/u)).toBeTruthy();
      expect(within(closed).queryByText('Accepted as done')).toBeNull();
      fireEvent.click(await enabledButton('Dispute', closed));
      await waitFor(() => expect(task(api, 'web-b2r6')).toMatchObject({ status: 'open', closeAcceptance: null }));
    });
  });

  describe('a test run', () => {
    it('shows the run a comment and a close reported, under each, and none under a comment that reported none', async () => {
      const api = createFixtureTasksApi();
      Object.assign(task(api, 'web-k3m9.1')!, {
        closeTest: { command: 'pnpm test', result: 'passed', passed: 22, failed: 0, commit: '1a2b3c4d5e' },
      } satisfies Partial<LiveTask>);
      api.state.comments.set('web-k3m9.1', [
        {
          id: 'run-1',
          author: FIXTURE_ACTOR,
          text: 'One link fails.',
          createdAt: '2026-11-05T12:00:00.000Z',
          test: { command: 'pnpm test', result: 'failed', passed: 21, failed: 1 },
        },
        { id: 'run-2', author: FIXTURE_ACTOR, text: 'Fixed it.', createdAt: '2026-11-05T13:00:00.000Z' },
      ]);
      renderApp('/tasks/web-k3m9.1', api);

      const activity = await screen.findByRole('list', { name: 'Activity' });
      await waitFor(() => expect(activity.querySelectorAll('[data-test-run]')).toHaveLength(2));
      const entries = (kind: string) =>
        within(activity)
          .getAllByRole('listitem')
          .filter((entry) => entry.dataset.timelineEntry === kind);
      const runOf = (entry: HTMLElement) => entry.querySelector<HTMLElement>('[data-test-run]');
      expect(entries('comment').map((entry) => runOf(entry)?.dataset.testRun ?? null)).toEqual(['failed', null]);
      const [closed] = entries('closed');
      expect(runOf(closed!)?.dataset.testRun).toBe('passed');
      expect(within(runOf(closed!)!).getByText(/22 passed/u)).toBeTruthy();
      expect(within(runOf(closed!)!).getByText('1a2b3c4')).toBeTruthy();
    });
  });

  describe('a stalled task', () => {
    it('shows where its work stopped and frees it on the person’s call, keeping that in a comment', async () => {
      const api = createFixtureTasksApi();
      renderApp('/tasks/web-w6n2', api);
      const block = await screen.findByRole('region', { name: 'Where it stopped' });
      expect(within(block).getByText('claude/sign-in-timing')).toBeTruthy();

      fireEvent.click(await enabledButton('Free it', block));

      await waitFor(() => expect(task(api, 'web-w6n2')).toMatchObject({ status: 'open', assignee: null }));
      expect(api.state.comments.get('web-w6n2')?.at(-1)?.text).toContain('freed web-w6n2 on their own call');
      expect(api.state.comments.get('web-w6n2')?.at(-1)?.text).toContain('- Branch: claude/sign-in-timing');
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Where it stopped' })).toBeNull());
    });

    it('frees only the claim it showed: a task another agent took meanwhile stays theirs', async () => {
      const fixture = createFixtureTasksApi();
      let freeing: Promise<void> | undefined;
      const api = {
        ...fixture,
        release: (...args: Parameters<typeof fixture.release>) => (freeing = fixture.release(...args)),
      };
      renderApp('/tasks/web-w6n2', api);
      const block = await screen.findByRole('region', { name: 'Where it stopped' });
      const free = await enabledButton('Free it', block);
      // Another agent claims it after the page drew, before the person presses.
      Object.assign(task(api, 'web-w6n2')!, { assignee: 'agent:other' });

      fireEvent.click(free);

      await waitFor(() => expect(freeing).toBeDefined());
      await expect(freeing).rejects.toBeInstanceOf(ApiError);
      expect(task(api, 'web-w6n2')).toMatchObject({ status: 'in_progress', assignee: 'agent:other' });
    });

    it('is not shown while its holder works on it', async () => {
      renderApp('/tasks/web-k3m9.2');
      await screen.findByRole('heading', { level: 1, name: 'Check the sign-in form with a screen reader' });
      expect(screen.queryByRole('region', { name: 'Where it stopped' })).toBeNull();
    });

    it('leaves Free it off for a sign-in that may not free a task', async () => {
      const limited = {
        ...createFixtureTasksApi(),
        capabilities: async () => ({ live: true, writable: true, operations: ['close', 'update'], reason: null }),
      };
      renderApp('/tasks/web-w6n2', limited);
      const block = await screen.findByRole('region', { name: 'Where it stopped' });
      await waitFor(() =>
        expect((within(block).getByRole('button', { name: 'Free it' }) as HTMLButtonElement).disabled).toBe(true),
      );
    });
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

  it('links the task to another as a duplicate by its id, and removes the link', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-b2r6', api);
    fireEvent.click(await enabledButton('More'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add link' }));
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'duplicates' } });
    fireEvent.change(screen.getByLabelText(/Task/), { target: { value: 'web-t5w3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    await waitFor(() =>
      expect(task(api, 'web-b2r6')?.dependencies).toEqual([
        { id: 'web-t5w3', type: 'duplicates', title: null, status: null },
      ]),
    );
    const links = () => document.querySelector('[data-task-links]') as HTMLElement;
    await waitFor(() => expect(within(links()).getByText('Duplicates')).toBeTruthy());
    expect(within(links()).getByRole('link', { name: /Rename the Settings tab to Account/ })).toBeTruthy();

    fireEvent.click(within(links()).getByRole('button', { name: 'Remove the link to web-t5w3' }));
    await waitFor(() => expect(task(api, 'web-b2r6')?.dependencies).toEqual([]));
    await waitFor(() => expect(document.querySelector('[data-task-links]')).toBeNull());
  });

  it('keeps every link as it was when the fixture refuses a change, as the API does', async () => {
    const api = createFixtureTasksApi();
    const links = (id: string) => task(api, id)?.dependencies.map(({ id: other, type }) => [other, type]);
    await api.updateTask('web-k3m9.2', 'web', { addLinks: [{ taskId: 'web-k3m9.4', type: 'related' }] });
    // web-k3m9.4 waits on web-k3m9.3, which waits on web-k3m9.2: waiting on web-k3m9.4 would loop.
    await expect(
      api.updateTask('web-k3m9.2', 'web', { addLinks: [{ taskId: 'web-k3m9.4', type: 'blocks' }] }),
    ).rejects.toMatchObject({ status: 409 });
    expect(links('web-k3m9.2')).toContainEqual(['web-k3m9.4', 'related']);
    await expect(
      api.updateTask('web-b2r6', 'web', { priority: 4, addLinks: [{ taskId: 'web-t5w3', type: 'related' }] }),
    ).rejects.toMatchObject({ status: 400 });
    expect([task(api, 'web-b2r6')?.priority, links('web-b2r6')]).toEqual([0, []]);
    // A link another project's task holds onto this one is changed from that task.
    task(api, 'docs-k8f2')?.dependencies.push({ id: 'web-b2r6', type: 'related', title: null, status: null });
    await expect(api.updateTask('web-b2r6', 'web', { removeLinks: ['docs-k8f2'] })).rejects.toMatchObject({
      status: 409,
    });
    expect(links('docs-k8f2')).toContainEqual(['web-b2r6', 'related']);
  });

  it("shows why a link is refused, and offers no Remove on another task's link onto this one", async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-k3m9.2', api);
    await screen.findByRole('heading', { level: 1, name: 'Check the sign-in form with a screen reader' });
    const links = document.querySelector('[data-task-links]') as HTMLElement;
    // web-k3m9.3 holds it back: that link is web-k3m9.3's own, changed from its page.
    const held = links.querySelector('[data-linked-task="web-k3m9.3"]') as HTMLElement;
    expect(within(held).queryByRole('button')).toBeNull();

    fireEvent.click(await enabledButton('Add link', links));
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'blocks' } });
    fireEvent.change(screen.getByLabelText(/Task/), { target: { value: 'web-k3m9.4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(
      await screen.findByText('web-k3m9.4 already waits on web-k3m9.2, so web-k3m9.2 cannot wait on it.'),
    ).toBeTruthy();
    expect(task(api, 'web-k3m9.2')?.dependencies.map((edge) => edge.id)).not.toContain('web-k3m9.4');
  });

  it('names the order two pull requests merge in, from either task', () => {
    const later = linkGroups(
      {
        id: 'web-m2',
        dependencies: [{ id: 'web-m1', type: 'merges-after', title: 'First change', status: 'in_progress' }],
        externalLinks: [],
      },
      [],
    );
    expect(later).toEqual([
      {
        label: 'Merges after',
        rows: [{ kind: 'task', id: 'web-m1', title: 'First change', status: 'in_progress', type: 'merges-after' }],
      },
    ]);
    const first = linkGroups({ id: 'web-m1', dependencies: [], externalLinks: [] }, [
      other('web-m2', [{ id: 'web-m1', type: 'merges-after', title: null, status: null }]),
    ]);
    expect(first).toEqual([
      { label: 'Merges before', rows: [{ kind: 'task', id: 'web-m2', title: 'Task web-m2', status: 'open' }] },
    ]);
    // The task's own dependents name a later task in another project, which its board does not hold.
    const across = linkGroups(
      {
        id: 'web-m1',
        dependencies: [],
        externalLinks: [],
        dependents: [{ id: 'docs-m3', type: 'merges-after', title: 'Document the header', status: 'open' }],
      },
      [],
    );
    expect(across).toEqual([
      {
        label: 'Merges before',
        rows: [{ kind: 'task', id: 'docs-m3', title: 'Document the header', status: 'open' }],
      },
    ]);
  });
});

describe('a task that relies on a dropped task', () => {
  it('names each dropped task, linked to its page, with how it ended', async () => {
    renderApp('/tasks/web-k3m9.4');
    const dropped = await screen.findByRole('region', { name: 'Dropped tasks this relies on' });
    expect(dropped.textContent).toBe(
      'Check: Remove the old landing page, which this relies on, closed as no longer needed',
    );
    fireEvent.click(within(dropped).getByRole('link', { name: 'Remove the old landing page' }));
    await screen.findByRole('heading', { level: 1, name: 'Remove the old landing page' });
  });

  it('shows nothing for a task that relies on none, and nothing once the task changes', async () => {
    renderApp('/tasks/web-b2r6');
    await screen.findByRole('heading', { level: 1, name: 'Fix the broken reset link in the welcome email' });
    expect(screen.queryByRole('region', { name: 'Dropped tasks this relies on' })).toBeNull();

    const api = createFixtureTasksApi();
    await api.updateTask('web-k3m9.4', 'web', { priority: 2 });
    renderApp('/tasks/web-k3m9.4', api);
    await screen.findByRole('heading', { level: 1, name: 'Remove the old sign-in page' });
    expect(screen.queryByRole('region', { name: 'Dropped tasks this relies on' })).toBeNull();
  });
});
