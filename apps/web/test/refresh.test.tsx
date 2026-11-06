import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useTaskRefresh } from '@/hooks/useTasks';

describe('the refresh after a write', () => {
  it('starts a new read even while an earlier read is still on its way', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let reads = 0;
    const answers: ((value: { title: string }) => void)[] = [];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => {
        useQuery({
          queryKey: ['task', 'web', 'web-a1'],
          queryFn: () => {
            reads += 1;
            return new Promise<{ title: string }>((resolve) => answers.push(resolve));
          },
        });
        return useTaskRefresh();
      },
      { wrapper },
    );
    await waitFor(() => expect(reads).toBe(1));
    // The first read started before the write; the refresh must not settle for its answer.
    void result.current();
    await waitFor(() => expect(reads).toBe(2));
    for (const answer of answers) answer({ title: 'A task' });
  });
});
