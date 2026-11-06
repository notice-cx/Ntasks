import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageBoundary } from '@/App';
import { CloseAsMenu } from '@/components/CloseResolution';
import { FactChip } from '@/components/FactChip';

describe('the Close as menu', () => {
  it('opens on its first item and moves with the arrow keys', async () => {
    render(<CloseAsMenu subject="A task" onPick={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Close as/ }));
    const menu = await screen.findByRole('menu', { name: 'Close A task as' });
    const items = within(menu).getAllByRole('menuitem');
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items.at(-1));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
  });
});

describe('a fact chip that offers choices', () => {
  it('holds only options in its list, opens on the value it holds and moves with the arrow keys', async () => {
    render(
      <FactChip
        label="Assignee"
        valueText="agent-two"
        editor={{
          kind: 'choice',
          value: 'agent-two',
          choices: [
            { value: 'agent-one', label: 'agent-one' },
            { value: 'agent-two', label: 'agent-two' },
            { value: '', label: 'Nobody' },
          ],
          other: { label: 'Someone else' },
        }}
        onSave={async () => true}
      >
        agent-two
      </FactChip>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change Assignee: agent-two' }));
    const list = await screen.findByRole('listbox', { name: 'Assignee' });
    const options = within(list).getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(within(list).queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Someone else' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(options[1]));
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(options[2]);
    fireEvent.keyDown(list, { key: 'Home' });
    expect(document.activeElement).toBe(options[0]);
  });
});

describe('a page that fails', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes down only itself and offers Reload', () => {
    // React reports the caught error to the console; the test expects it.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never {
      throw new Error('The page code could not be fetched.');
    }
    render(
      <div>
        <a href="https://example.com/source">Source code</a>
        <PageBoundary>
          <Broken />
        </PageBoundary>
      </div>,
    );
    expect(screen.getByText('This page could not load')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Source code' })).toBeTruthy();
  });
});
