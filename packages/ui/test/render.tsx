import { QueryClient } from '@tanstack/react-query';
import { render, waitFor, within, type BoundFunctions, type queries } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { expect } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { App } from '@/App';
import { appPaths } from '@/lib/paths';
import { createFixtureTasksApi } from '@/api/fixture';
import type { TasksApi } from '@/api/client';

/**
 * The app under `/tasks`, as the web app serves it, inside its root element,
 * at `path`, over a fresh fixture API unless one is given.
 */
export function renderApp(
  path: string,
  api: TasksApi = createFixtureTasksApi(),
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }),
) {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/tasks/*"
          element={
            <div data-ntasks="">
              <App api={api} paths={appPaths('/tasks')} queryClient={queryClient} />
            </div>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { ...view, api, queryClient };
}

/** A button once it can be pressed: verbs stay disabled until the sign-in's permissions have arrived. */
export async function enabledButton(
  name: string | RegExp,
  scope: HTMLElement | null = null,
): Promise<HTMLButtonElement> {
  const query: BoundFunctions<typeof queries> = scope ? within(scope) : screen;
  let found: HTMLButtonElement | null = null;
  await waitFor(() => {
    found = query.getByRole('button', { name }) as HTMLButtonElement;
    expect(found.disabled).toBe(false);
  });
  return found as unknown as HTMLButtonElement;
}
