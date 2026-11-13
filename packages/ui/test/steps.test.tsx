// A request that a person do steps: its checklist on the task page and in
// Waiting for you, what each control sends, and what a sign-in that may not
// mark steps is offered.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TasksApi } from '@/api/client';
import { createFixtureTasksApi } from '@/api/fixture';
import type { StepMarking } from '@/api/types';
import { FIXTURE_ACTOR } from '@/api/fixture-data';
import { UNDO_WINDOW_MS } from '@/lib/answer-queue';
import { enabledButton, renderApp } from './render';

type FixtureApi = ReturnType<typeof createFixtureTasksApi>;

const STEPS = [
  { text: 'Back up the database.', command: 'pnpm backup', done: null, note: null, stuck: null },
  {
    text: 'Update to the merged commit.',
    command: './update.sh --commit a1b2c3d4',
    done: null,
    note: null,
    stuck: null,
  },
  { text: 'Open the site and sign in.', command: null, done: null, note: null, stuck: null },
];

/** The fixture with its approval web-g7p2 turned into a request to do STEPS. */
function asked(): FixtureApi {
  const api = createFixtureTasksApi();
  Object.assign(
    api.state.tasks.find((entry) => entry.id === 'web-g7p2')!,
    {
      title: 'Update the site to the new release',
      steps: STEPS,
    },
  );
  return api;
}

function gate(api: FixtureApi) {
  return api.state.tasks.find((entry) => entry.id === 'web-g7p2')!;
}

/** The fixture, with every step marking it receives kept in `marks`. */
function recording(api: FixtureApi): { api: TasksApi; marks: StepMarking[] } {
  const marks: StepMarking[] = [];
  return {
    marks,
    api: {
      ...api,
      markStep: async (id, project, marking, options) => {
        marks.push(marking);
        await api.markStep(id, project, marking, options);
      },
    },
  };
}

async function box(place: number): Promise<HTMLButtonElement> {
  const found = (await screen.findByRole('checkbox', { name: `Step ${place}` })) as HTMLButtonElement;
  await waitFor(() => expect(found.disabled).toBe(false));
  return found;
}

describe('a request to do steps, on its page', () => {
  it('ticks the steps in any order and closes the request on the last, offering no Approve', async () => {
    const fixture = asked();
    const { api, marks } = recording(fixture);
    renderApp('/tasks/web-g7p2', api);

    const steps = await screen.findByRole('region', { name: /Your steps/ });
    expect(within(steps).getByText('./update.sh --commit a1b2c3d4').closest('pre')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();

    fireEvent.click(await box(3));
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Step 3' }).getAttribute('aria-checked')).toBe('true'),
    );
    expect(gate(fixture).status).toBe('open');
    fireEvent.click(await box(1));
    await waitFor(() => expect(gate(fixture).steps![0]!.done).not.toBeNull());
    fireEvent.click(await box(2));

    await waitFor(() => expect(gate(fixture).status).toBe('closed'));
    expect(marks.map((mark) => mark.step)).toEqual([3, 1, 2]);
    expect(marks.every((mark) => mark.done === true)).toBe(true);
    expect(gate(fixture).steps!.every((step) => step.done !== null)).toBe(true);
  });

  it('sends where the person is stuck and why, and a note, on the step they name', async () => {
    const fixture = asked();
    const { api, marks } = recording(fixture);
    renderApp('/tasks/web-g7p2', api);
    const second = (await screen.findAllByRole('listitem')).find((item) => item.dataset.step === '2')!;

    await waitFor(() => expect(within(second).getByRole('button', { name: 'Stuck here' })).toBeTruthy());
    fireEvent.click(within(second).getByRole('button', { name: 'Stuck here' }));
    fireEvent.change(within(second).getByRole('textbox', { name: 'What stopped you at step 2' }), {
      target: { value: 'The host asks for a password.' },
    });
    fireEvent.click(within(second).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(gate(fixture).steps![1]!.stuck?.reason).toBe('The host asks for a password.'));
    await waitFor(() => expect(second.dataset.stepState).toBe('stuck'));

    fireEvent.click(within(second).getByRole('button', { name: 'Add note' }));
    const note = within(second).getByRole('textbox', { name: 'Note on step 2' });
    fireEvent.change(note, { target: { value: 'Tried the key from the vault.' } });
    fireEvent.keyDown(note, { key: 'Enter' });
    await waitFor(() => expect(gate(fixture).steps![1]!.note?.text).toBe('Tried the key from the vault.'));

    expect(marks).toEqual([
      { step: 2, stuck: 'The host asks for a password.' },
      { step: 2, note: 'Tried the key from the vault.' },
    ]);
    expect(gate(fixture).status).toBe('open');
  });

  it('shows the steps without controls to a sign-in that may not mark them', async () => {
    const fixture = asked();
    const api: TasksApi = {
      ...fixture,
      capabilities: async () => ({
        live: true,
        writable: true,
        operations: ['create', 'update', 'comment', 'close'],
        reason: null,
      }),
    };
    renderApp('/tasks/web-g7p2', api);
    const first = await screen.findByRole('checkbox', { name: 'Step 1' });
    await waitFor(() => expect((first as HTMLButtonElement).disabled).toBe(true));
    expect(((await screen.findByRole('button', { name: 'Did it myself' })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Stuck here' })).toBeNull();
  });
});

describe('finishing a request another way', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it.each(['/tasks/web-g7p2', '/tasks'])('records the outcome from %s and preserves the steps', async (path) => {
    const fixture = asked();
    await fixture.markStep('web-g7p2', 'web', { step: 1, done: true });
    const before = structuredClone(gate(fixture).steps);
    renderApp(path, fixture);
    const scope = path === '/tasks' ? await screen.findByRole('region', { name: 'Waiting for you' }) : null;
    fireEvent.click(await enabledButton('Did it myself', scope));
    const form = await screen.findByRole('form', { name: 'Did it myself: web-g7p2' });
    expect(within(form).getByText(/Got the same result another way/)).toBeTruthy();
    fireEvent.change(within(form).getByRole('textbox', { name: 'Note' }), {
      target: { value: 'Used the installer instead.' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Send' }));
    expect(gate(fixture).status).toBe('open');
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS + 10);
    });
    await waitFor(() => expect(gate(fixture).status).toBe('closed'));
    expect(gate(fixture).steps).toEqual(before);
    expect(gate(fixture).answer).toMatchObject({
      option: 'done',
      recordedBy: FIXTURE_ACTOR,
      quote: 'Used the installer instead.',
      relayed: false,
    });
    expect(gate(fixture).closeReason).toBe('Did it myself: Used the installer instead.');
  });

  it('allows completion without a note, and Undo leaves the request open', async () => {
    const fixture = asked();
    renderApp('/tasks/web-g7p2', fixture);
    fireEvent.click(await enabledButton('Did it myself'));
    const form = await screen.findByRole('form', { name: 'Did it myself: web-g7p2' });
    fireEvent.click(within(form).getByRole('button', { name: 'Send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS + 10);
    });
    expect(gate(fixture).status).toBe('open');
    expect(gate(fixture).answer ?? null).toBeNull();
    expect(gate(fixture).steps).toEqual(STEPS);
  });
});

describe('a request to do steps, in Waiting for you', () => {
  it('opens its steps under the row, where a tick is sent, and offers no Approve', async () => {
    const fixture = asked();
    const { api, marks } = recording(fixture);
    renderApp('/tasks', api);
    const row = (await screen.findAllByText('Update the site to the new release'))
      .map((title) => title.closest<HTMLElement>('[data-inbox-row]'))
      .find((found) => found !== null)!;
    expect(within(row).queryByRole('button', { name: 'Approve' })).toBeNull();

    fireEvent.click(within(row).getByRole('button', { name: /Your steps/ }));
    await screen.findByRole('checkbox', { name: 'Step 1' });
    fireEvent.click(await enabledButton('Did it myself', row));
    expect(await screen.findByRole('form', { name: 'Did it myself: web-g7p2' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Step 1' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: /Your steps/ }));
    expect(screen.queryByRole('form', { name: 'Did it myself: web-g7p2' })).toBeNull();
    fireEvent.click(await box(1));

    await waitFor(() => expect(marks).toEqual([{ step: 1, done: true }]));
  });
});
