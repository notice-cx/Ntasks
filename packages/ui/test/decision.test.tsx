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
    const facts = screen.getByRole('complementary', { name: 'Facts' });
    expect(within(facts).getByText('Waiting for you')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'Fewer paths to support.' } });
    // A press selects an option; Answer sends it.
    await waitFor(() =>
      expect((screen.getByRole('radio', { name: /Email link only/ }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole('radio', { name: /Email link only/ }));
    expect(task(api, 'web-d4x1')?.choice).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));

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
    // Read again, the page records who chose and how, with the options as a record.
    const choice = await screen.findByRole('region', { name: 'Choice' });
    expect(choice.querySelector('[data-choice-chosen]')?.getAttribute('data-choice-option')).toBe('a');
    expect(within(choice).queryByRole('radio')).toBeNull();
  });

  it('Undo cancels an answer before it is sent', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks', api);
    const queue = await screen.findByRole('region', { name: 'Waiting for you' });
    const row = queue.querySelector('[data-task-row="web-g7p2"]') as HTMLElement;
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

  it('answers a question from its row in Waiting for you', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks', api);
    const queue = await screen.findByRole('region', { name: 'Waiting for you' });
    const row = queue.querySelector('[data-task-row="web-q8n5"]') as HTMLElement;
    fireEvent.click(await enabledButton('Answer', row));
    const box = screen.getByRole('textbox', { name: 'Your answer to web-q8n5' });
    fireEvent.change(box, { target: { value: 'support@example.com' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitOutUndo();
    await waitFor(() => expect(task(api, 'web-q8n5')?.status).toBe('closed'));
    expect(api.state.comments.get('web-q8n5')?.[0]?.text).toBe('support@example.com');
  });

  it('answers a question on its page', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/web-q8n5', api);
    fireEvent.click(await enabledButton('Answer'));
    const box = screen.getByRole('textbox', { name: 'Your answer to web-q8n5' });
    fireEvent.change(box, { target: { value: 'help@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    // The answer waits in the Undo window, and the page offers nothing more to do meanwhile.
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull();
    await waitOutUndo();
    await waitFor(() => expect(api.state.comments.get('web-q8n5')?.[0]?.text).toBe('help@example.com'));
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

  it('lets a person reply and return a task to the agents’ queue', async () => {
    const api = createFixtureTasksApi();
    task(api, 'web-q8n5')!.issueType = 'task';
    renderApp('/tasks/web-q8n5', api);
    await enabledButton('Mark done');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reply to agent' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Your reply to web-q8n5' }), {
      target: { value: 'Please use help@example.com.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reply and return task' }));
    await waitOutUndo();
    await waitFor(() => expect(task(api, 'web-q8n5')?.labels).not.toContain('human'));
    expect(task(api, 'web-q8n5')?.status).toBe('open');
    expect(api.state.comments.get('web-q8n5')?.[0]?.text).toBe('Please use help@example.com.');
  });
});
