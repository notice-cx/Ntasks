import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TasksApiProvider } from '@/api/context';
import { createFixtureTasksApi } from '@/api/fixture';
import { AcceptForm } from '@/components/CloseResolution';

describe('the Done, my call form', () => {
  it('keeps the criteria and the proposal version it opened with when the task changes under it', async () => {
    const api = createFixtureTasksApi();
    const accept = vi.spyOn(api, 'accept').mockResolvedValue(undefined);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = (children: ReactNode) => (
      <QueryClientProvider client={client}>
        <TasksApiProvider api={api}>{children}</TasksApiProvider>
      </QueryClientProvider>
    );
    const form = (acceptance: string, proposalVersion: string) => (
      <AcceptForm
        id="web-b2r6"
        project="web"
        acceptance={acceptance}
        proposalVersion={proposalVersion}
        onDone={() => undefined}
      />
    );
    const { rerender } = render(wrap(form('- Merged.\n- Deployed.', 'a'.repeat(32))));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Deployed.' }));

    // A refresh brings an edited Done when and its new proposal version.
    rerender(wrap(form('- Announced.\n- Merged.\n- Deployed.', 'b'.repeat(32))));

    expect(screen.queryByRole('checkbox', { name: 'Announced.' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close, waiving 1 criterion' }));
    await waitFor(() => expect(accept).toHaveBeenCalledTimes(1));
    expect(accept).toHaveBeenCalledWith('web-b2r6', 'web', [2], { proposalVersion: 'a'.repeat(32) });
  });
});
