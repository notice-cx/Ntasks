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
    const field = screen.getByRole('textbox', { name: 'Note for the agent' });
    fireEvent.change(field, { target: { value: 'Reverify the keyboard flow.' } });
    fireEvent.submit(field.closest('form')!);
    await waitFor(() => expect((field as HTMLTextAreaElement).disabled).toBe(true));
    release();
    await screen.findByText('Reverify the keyboard flow.');
    expect(await api.task('web-k3m9.1', 'web')).toMatchObject({
      task: { status: 'open', assignee: null, labels: [NEXT_LABEL] },
      comments: [expect.objectContaining({ text: 'Reverify the keyboard flow.' })],
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove from Next' })).toBeTruthy());
  });
});
