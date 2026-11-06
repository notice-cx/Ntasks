import { QueryClient } from '@tanstack/react-query';
import { render, waitFor, within, type BoundFunctions, type queries } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { App } from '@/App';
import { createFixtureTasksApi } from '@/api/fixture';
import type { TasksApi } from '@/api/client';

/** The app at `path`, over a fresh fixture API unless one is given. */
export function renderApp(
  path: string,
  api: TasksApi = createFixtureTasksApi(),
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }),
) {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <App api={api} queryClient={queryClient} />
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
