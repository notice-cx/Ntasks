import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { TasksApiProvider } from '@/api/context';
import { createFixtureTasksApi } from '@/api/fixture';
import { BoardsProvider, useBoard } from '@/hooks/useBoard';
import { NO_FILTERS } from '@/lib/board-read';

describe('the shared board read', () => {
  it('gives the same read while nothing it holds changed, however often the page draws', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = createFixtureTasksApi();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <TasksApiProvider api={api}>
          <BoardsProvider>{children}</BoardsProvider>
        </TasksApiProvider>
      </QueryClientProvider>
    );
    const { result, rerender } = renderHook(({ filters }) => useBoard(filters), {
      wrapper,
      initialProps: { filters: { ...NO_FILTERS } },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.fetching).toBe(false));
    const first = result.current;
    // A new filters object with the same filters, as every draw of a page makes.
    rerender({ filters: { ...NO_FILTERS } });
    expect(result.current).toBe(first);
    rerender({ filters: { ...NO_FILTERS, project: 'docs' } });
    expect(result.current).not.toBe(first);
    expect(result.current.projects.map((project) => project.key)).toEqual(['docs']);
  });
});
