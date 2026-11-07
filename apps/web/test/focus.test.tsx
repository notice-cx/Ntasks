import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { UNDO_WINDOW_MS } from '@/lib/answer-queue';
import { enabledButton, renderApp } from './render';

function task(api: ReturnType<typeof createFixtureTasksApi>, id: string) {
  return api.state.tasks.find((entry) => entry.id === id);
}

function current(): string | null {
  return document.querySelector('[data-focus-decision]')?.getAttribute('data-focus-decision') ?? null;
}

describe('focus', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes the decisions one at a time, with keys for each answer', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/focus', api);
    expect(await screen.findByText('1 of 4')).toBeTruthy();
    expect(current()).toBe('web-g7p2');
    await enabledButton(/Approve/);

    // Enter approves the approval.
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(current()).toBe('web-d4x1'));
    expect(screen.getByText('2 of 4')).toBeTruthy();

    // → passes over a decision without answering it.
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(current()).toBe('docs-r4s9'));

    // An option's letter selects it, and Enter answers with it.
    fireEvent.keyDown(window, { key: 'b' });
    expect(screen.getByRole('radio', { name: /In a separate docs project/ }).getAttribute('aria-checked')).toBe('true');
    expect(current()).toBe('docs-r4s9');
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(current()).toBe('web-q8n5'));

    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS + 10);
    });
    await waitFor(() => expect(task(api, 'web-g7p2')?.status).toBe('closed'));
    await waitFor(() => expect(task(api, 'docs-r4s9')?.choice?.option).toBe('b'));
    expect(task(api, 'web-d4x1')?.status).toBe('open');
  });

  it('ends by counting the decisions passed with Not now, and starts over on them', async () => {
    renderApp('/tasks/focus?project=docs');
    expect(await screen.findByText('1 of 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(await screen.findByText('1 decision skipped')).toBeTruthy();
    expect(screen.queryByText('Nothing is waiting for you')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(current()).toBe('docs-r4s9');
  });

  it('ends on nothing waiting once every decision is answered', async () => {
    renderApp('/tasks/focus?project=docs');
    expect(await screen.findByText('1 of 1')).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole('radio', { name: /In a separate docs project/ }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('radio', { name: /In a separate docs project/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(await screen.findByText('Nothing is waiting for you')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start over' })).toBeNull();
  });

  it('starts at the decision the address names', async () => {
    renderApp('/tasks/focus?task=web-q8n5');
    await waitFor(() => expect(current()).toBe('web-q8n5'));
    const answer = screen.getByRole('textbox', { name: 'Your answer to web-q8n5' });
    // A key typed in a field is text, not a command.
    fireEvent.keyDown(answer, { key: 'ArrowRight' });
    expect(current()).toBe('web-q8n5');
  });
});
