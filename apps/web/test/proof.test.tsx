// Work closed as done with no commit, pull request or link: the task page
// and the closed tasks' rows show it has no proof.
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { renderApp } from './render';

/** An open task in the fixture's web project (fixture-data.ts). */
const TASK = 'web-t5w3';
/** Closed as done with a commit and a pull request. */
const BUILT = 'web-k3m9.1';

describe('a task closed as done without proof', () => {
  it('shows No proof on its page and its row, and not on work that shows its change', async () => {
    const api = createFixtureTasksApi();
    await api.closeTask(TASK, 'web', 'Renamed it.');

    const { unmount } = renderApp(`/tasks/${TASK}`, api);
    const closed = await screen.findByRole('region', { name: 'Closed as Done' });
    expect(closed.querySelector('[data-task-proof]')?.getAttribute('data-task-proof')).toBe('none');
    unmount();

    renderApp('/tasks?view=done', api);
    const row = (id: string) =>
      waitFor(() => {
        const found = document.querySelector(`[data-task-row="${id}"]`);
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });
    expect((await row(TASK)).querySelector('[data-row-proof]')).not.toBeNull();
    expect((await row(BUILT)).querySelector('[data-row-proof]')).toBeNull();
  });
});
