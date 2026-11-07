import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from './render';

// The renderer's module fails to load until `loads.fail` is turned off, as it
// would when the network drops between opening the board and asking for a preview.
const loads = vi.hoisted(() => ({ fail: true }));
vi.mock('@/routes/tasks/task-markdown', async (importOriginal) => {
  if (loads.fail) throw new TypeError('Failed to fetch dynamically imported module');
  return importOriginal();
});

describe("the composer's preview", () => {
  it('keeps the draft when the preview cannot load, and loads it on a second try', async () => {
    renderApp('/tasks?new=1&project=web');
    const title = await screen.findByLabelText(/Title/);
    fireEvent.change(title, { target: { value: 'Show the sign-in errors in red' } });
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Errors are **grey** today.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByText('The preview could not load')).toBeTruthy();
    expect(screen.getByText('Errors are **grey** today.')).toBeTruthy();
    expect((screen.getByLabelText(/Title/) as HTMLInputElement).value).toBe('Show the sign-in errors in red');

    loads.fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect((await screen.findByText('grey')).tagName).toBe('STRONG');
    fireEvent.click(screen.getByRole('button', { name: 'Write' }));
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Errors are **grey** today.');
  });
});
