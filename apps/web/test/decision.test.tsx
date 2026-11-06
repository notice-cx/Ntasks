import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { FIXTURE_ACTOR } from '@/api/fixture-data';
import { UNDO_WINDOW_MS } from '@/lib/answer-queue';
import { enabledButton, renderApp } from './render';

function task(api: ReturnType<typeof createFixtureTasksApi>, id: string) {
  return api.state.tasks.find((entry) => entry.id === id);
}

async function waitOutUndo() {
  await act(async () => {
    vi.advanceTimersByTime(UNDO_WINDOW_MS + 10);
  });
}

describe('answering a decision', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('picks an option on the task page, sent after the Undo window', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-d4x1', api);
    expect(await screen.findByText('Which sign-in methods should the page offer?')).toBeTruthy();
    expect(screen.getByText('Needs your choice')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'Fewer paths to support.' } });
    fireEvent.click(await enabledButton('(a) Email link only'));

    // The pick is drawn at once and the toast offers Undo; nothing is sent yet.
    expect(await screen.findByText('Chose (a) Email link only')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(task(api, 'web-d4x1')?.choice).toBeNull();

    await waitOutUndo();
    await waitFor(() => expect(task(api, 'web-d4x1')?.status).toBe('closed'));
    expect(task(api, 'web-d4x1')?.choice).toMatchObject({
      option: 'a',
      label: 'Email link only',
      by: FIXTURE_ACTOR,
      note: 'Fewer paths to support.',
    });
    // Read again, the page records who chose and how.
    expect(await screen.findByRole('region', { name: 'Choice' })).toBeTruthy();
  });

  it('Undo cancels an answer before it is sent', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks', api);
    const queue = await screen.findByRole('region', { name: 'Your decisions' });
    const row = within(queue)
      .getByText('Approve sending the new sign-in page to every visitor')
      .closest('li') as HTMLElement;
    fireEvent.click(await enabledButton('Approve', row));
    // The row leaves the list at once.
    await waitFor(() =>
      expect(within(queue).queryByText('Approve sending the new sign-in page to every visitor')).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitOutUndo();
    expect(task(api, 'web-g7p2')?.status).toBe('open');
    expect(await within(queue).findByText('Approve sending the new sign-in page to every visitor')).toBeTruthy();
  });

  it('answers a question from its row in the decisions list', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks', api);
    const queue = await screen.findByRole('region', { name: 'Your decisions' });
    const row = within(queue).getByText('Confirm the support address on the error page').closest('li') as HTMLElement;
    fireEvent.click(await enabledButton('Answer', row));
    const box = within(row).getByRole('textbox', { name: 'Your answer to web-q8n5' });
    fireEvent.change(box, { target: { value: 'support@example.com' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitOutUndo();
    // A question that is not a decision goes back to ready work, its answer a comment.
    await waitFor(() => expect(task(api, 'web-q8n5')?.labels).not.toContain('human'));
    expect(api.state.comments.get('web-q8n5')?.[0]?.text).toBe('support@example.com');
    expect(task(api, 'web-q8n5')?.status).toBe('open');
  });

  it("closes a question as Won't do, with its note", async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-q8n5', api);
    fireEvent.click(await enabledButton('Close as'));
    fireEvent.click(await screen.findByRole('menuitem', { name: "Won't do" }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), {
      target: { value: 'The page will not name an address.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close task' }));
    expect(await screen.findByText("Closed as Won't do")).toBeTruthy();
    await waitOutUndo();
    await waitFor(() => expect(task(api, 'web-q8n5')?.status).toBe('closed'));
    expect(task(api, 'web-q8n5')?.resolution).toBe('wont-do');
    expect(task(api, 'web-q8n5')?.closeReason).toBe('Dismissed: The page will not name an address.');
  });
});
