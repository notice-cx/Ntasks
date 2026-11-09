import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { fixtureSeed } from '@/api/fixture-data';
import { renderApp } from './render';

const COMMANDS = 'pnpm install --frozen-lockfile\npnpm --filter @ntasks/ui run build';

/** The task web-b2r6, whose description holds one bash block. */
function openTask() {
  const seed = fixtureSeed(Date.now());
  const task = seed.tasks.find((entry) => entry.id === 'web-b2r6');
  if (!task) throw new Error('The fixture has no web-b2r6.');
  task.description = `Run these:\n\n\`\`\`bash\n${COMMANDS}\n\`\`\`\n\nThen open the page.`;
  return renderApp('/tasks/web-b2r6', createFixtureTasksApi({ seed }));
}

function clipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
  getSelection()?.removeAllRanges();
});

describe('Copy on a code block', () => {
  it("copies exactly the block's text, then shows Copied", async () => {
    const writeText = clipboard();
    openTask();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy the code' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(COMMANDS));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('selects the block and says so where the browser cannot copy', async () => {
    // jsdom has no clipboard, as a page served without HTTPS has none.
    openTask();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy the code' }));
    expect(await screen.findByText('Could not copy. The text is selected: copy it with your keyboard.')).toBeTruthy();
    expect(getSelection()?.toString().trim()).toBe(COMMANDS);
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });
});

describe("Copy beside a task's id", () => {
  it('copies the bare id', async () => {
    const writeText = clipboard();
    openTask();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy the task id' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('web-b2r6'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });
});
