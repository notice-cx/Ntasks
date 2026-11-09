import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it } from 'vitest';
import { NtasksApp } from '@notice-cx/ntasks-ui';
import { createFixtureTasksApi } from '@notice-cx/ntasks-ui/fixture';

// jsdom has no layout or media queries, which the app's menus and theme ask for.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as unknown as typeof window.matchMedia;

it('renders the board from the installed package', async () => {
  render(
    <MemoryRouter initialEntries={['/tasks']}>
      <Routes>
        <Route path="/tasks/*" element={<NtasksApp api={createFixtureTasksApi()} basePath="/tasks" />} />
      </Routes>
    </MemoryRouter>,
  );
  const task = await screen.findByRole(
    'link',
    { name: 'Fix the broken reset link in the welcome email' },
    { timeout: 10_000 },
  );
  expect(task.getAttribute('href')).toBe('/tasks/web-b2r6');
});
