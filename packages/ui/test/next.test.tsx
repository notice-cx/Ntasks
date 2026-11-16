import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NEXT_LABEL } from '@ntasks/domain';
import { createFixtureTasksApi } from '@/api/fixture';
import { enabledButton, renderApp } from './render';

describe('Next', () => {
  it('moves a task between its status group and Next from the board', async () => {
    renderApp('/tasks');
    const next = await screen.findByRole('region', { name: 'Next' });
    const open = await screen.findByRole('region', { name: 'Open' });
    const title = 'Fix the broken reset link in the welcome email';
    fireEvent.click(await enabledButton('Add to Next: web-b2r6', open));
    await within(next).findByRole('link', { name: title });
    expect(within(open).queryByRole('link', { name: title })).toBeNull();
    fireEvent.click(await enabledButton('Remove from Next: web-b2r6', next));
    await within(open).findByRole('link', { name: title });
    expect(within(next).queryByRole('link', { name: title })).toBeNull();
  });

  it('reopens completed work and leaves the note in its activity', async () => {
    const api = createFixtureTasksApi();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderApp('/tasks/web-k3m9.1', {
      ...api,
      async updateTask(...args) {
        await pending;
        await api.updateTask(...args);
      },
    });
    fireEvent.click(await enabledButton('Reopen and add to Next'));
    const next = await screen.findByRole('dialog', { name: 'Reopen and add to Next' });
    const field = within(next).getByRole('textbox', { name: 'Note for the agent' });
    fireEvent.change(field, { target: { value: 'Reverify the keyboard flow.' } });
    fireEvent.submit(field.closest('form')!);
    await waitFor(() => expect((field as HTMLTextAreaElement).disabled).toBe(true));
    release();
    await screen.findByText('Reverify the keyboard flow.');
    expect(await api.task('web-k3m9.1', 'web')).toMatchObject({
      task: { status: 'open', assignee: null, labels: [NEXT_LABEL] },
      comments: [expect.objectContaining({ text: 'Reverify the keyboard flow.' })],
    });
    expect(await enabledButton('Remove from Next')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Reopen and add to Next' })).toBeNull();
  });

  it('adds from the primary header action with a note, then removes from the header', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-b2r6', api);
    const add = await enabledButton('Add to Next');
    const header = add.closest('header')!;
    expect(add.classList.contains('bg-accent')).toBe(true);
    expect(within(header).getAllByRole('button', { name: 'Add to Next' })).toHaveLength(1);
    expect(
      within(await screen.findByRole('complementary', { name: 'Facts' })).queryByRole('button', {
        name: 'Add to Next',
      }),
    ).toBeNull();
    expect(within(header).getByRole('button', { name: 'Close' }).classList.contains('bg-accent')).toBe(false);

    fireEvent.click(add);
    const dialog = await screen.findByRole('dialog', { name: 'Add to Next' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Note for the agent' }), {
      target: { value: 'Check the link before the next welcome email.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to Next' }));
    await waitFor(() => expect(api.state.tasks.find((task) => task.id === 'web-b2r6')?.labels).toContain(NEXT_LABEL));
    expect(api.state.comments.get('web-b2r6')?.[0]?.text).toBe('Check the link before the next welcome email.');
    const remove = await enabledButton('Remove from Next', header);
    expect(remove.classList.contains('bg-accent')).toBe(false);
    fireEvent.click(remove);
    await enabledButton('Add to Next', header);
    expect(api.state.tasks.find((task) => task.id === 'web-b2r6')?.labels).not.toContain(NEXT_LABEL);
  });

  it.each([false, true])('hides Next actions when writable is %s and Next is unsupported', async (writable) => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-b2r6', {
      ...api,
      capabilities: async () => ({ live: true, writable, operations: ['close', 'update'], reason: null }),
    });
    await screen.findByRole('heading', { level: 1, name: 'Fix the broken reset link in the welcome email' });
    await enabledButton('More');
    expect(screen.queryByRole('button', { name: 'Add to Next' })).toBeNull();
    fireEvent.click(await enabledButton('More'));
    const claim = await screen.findByRole('menuitem', { name: 'Claim' });
    expect((claim as HTMLButtonElement).disabled).toBe(!writable);
    fireEvent.keyDown(document.body, { key: 'm' });
    if (!writable) expect(api.state.tasks.find((task) => task.id === 'web-b2r6')?.assignee).toBeNull();
  });

  it('does not offer Next or Claim for work already in progress', async () => {
    renderApp('/tasks/web-k3m9.2');
    await enabledButton('Close');
    expect(screen.queryByRole('button', { name: 'Add to Next' })).toBeNull();
    fireEvent.click(await enabledButton('More'));
    const menu = await screen.findByRole('menu', { name: 'Actions for web-k3m9.2' });
    expect(within(menu).queryByRole('menuitem', { name: 'Claim' })).toBeNull();
  });
});
