import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageBoundary } from '@/App';
import { CloseMenu } from '@/components/CloseResolution';
import { Fact, type FactEditor } from '@/components/Fact';

describe('the Close menu', () => {
  it('offers Done first when it may, then every close where nothing shipped, and hands back the pick', async () => {
    const onPick = vi.fn();
    render(<CloseMenu label="Close" subject="web-a1" done onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    const menu = await screen.findByRole('menu', { name: 'Close web-a1 as' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Done',
      "Won't do",
      'Duplicate',
      "Can't reproduce",
      'Already handled',
      'No longer needed',
    ]);
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items.at(-1));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Duplicate' }));
    expect(onPick).toHaveBeenCalledWith('duplicate');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('leaves Done out where the task cannot be closed as done', () => {
    render(<CloseMenu label="Close as" subject="web-a1" onPick={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Close as/ }));
    expect(screen.queryByRole('menuitem', { name: 'Done' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: "Won't do" })).toBeTruthy();
  });
});

describe('a fact', () => {
  const ASSIGNEE: FactEditor = {
    kind: 'choice',
    value: 'agent-two',
    choices: [
      { value: 'agent-one', label: 'agent-one' },
      { value: 'agent-two', label: 'agent-two' },
      { value: '', label: 'Nobody' },
    ],
    other: 'Someone else',
  };

  function draw(props: Partial<Parameters<typeof Fact>[0]> = {}) {
    return render(
      <dl>
        <Fact label="Assignee" valueText="agent-two" {...props}>
          agent-two
        </Fact>
      </dl>,
    );
  }

  it('is only words where this sign-in cannot change it', () => {
    draw();
    expect(screen.getByText('agent-two')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('opens a menu on the value it holds, with a field for another value outside the menu, and saves a pick', async () => {
    const onSave = vi.fn(async () => true);
    draw({ editor: ASSIGNEE, onSave });
    fireEvent.click(screen.getByRole('button', { name: 'Assignee: agent-two' }));
    const menu = await screen.findByRole('menu', { name: 'Assignee' });
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items).toHaveLength(3);
    expect(within(menu).queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Someone else' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(items[1]));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.click(items[2] as HTMLElement);
    expect(onSave).toHaveBeenCalledWith('', undefined);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('saves a typed value with Enter', async () => {
    const onSave = vi.fn(async () => true);
    draw({ editor: ASSIGNEE, onSave });
    fireEvent.click(screen.getByRole('button', { name: 'Assignee: agent-two' }));
    const other = await screen.findByRole('textbox', { name: 'Someone else' });
    fireEvent.change(other, { target: { value: ' agent-three ' } });
    fireEvent.submit(other.closest('form') as HTMLFormElement);
    expect(onSave).toHaveBeenCalledWith('agent-three', undefined);
  });

  it('turns values on and off and stays open while they change', async () => {
    const onSave = vi.fn(async () => true);
    draw({
      label: 'Labels',
      valueText: 'copy',
      editor: {
        kind: 'toggle',
        values: ['copy'],
        choices: [
          { value: 'copy', label: 'copy' },
          { value: 'docs', label: 'docs' },
        ],
      },
      onSave,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Labels: copy' }));
    const menu = await screen.findByRole('menu', { name: 'Labels' });
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'copy' }));
    expect(onSave).toHaveBeenLastCalledWith('copy', false);
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'docs' }));
    expect(onSave).toHaveBeenLastCalledWith('docs', true);
    expect(screen.getByRole('menu', { name: 'Labels' })).toBeTruthy();
  });

  it('ignores a second press on a value while its first save is still running', async () => {
    let finish: (saved: boolean) => void = () => {};
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    draw({
      label: 'Labels',
      valueText: 'None',
      editor: { kind: 'toggle', values: [], choices: [{ value: 'copy', label: 'copy' }] },
      onSave,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Labels: None' }));
    const menu = await screen.findByRole('menu', { name: 'Labels' });
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'copy' }));
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'copy' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'copy' }));
    expect(onSave).toHaveBeenCalledTimes(2);
  });
});

describe('a page that fails', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tries again when the address changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never {
      throw new Error('The page code could not be fetched.');
    }
    const { rerender } = render(
      <PageBoundary resetKey="/tasks/web-a1">
        <Broken />
      </PageBoundary>,
    );
    expect(screen.getByText('This page could not load')).toBeTruthy();
    rerender(
      <PageBoundary resetKey="/tasks/web-a2">
        <p>The next page</p>
      </PageBoundary>,
    );
    expect(screen.getByText('The next page')).toBeTruthy();
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
