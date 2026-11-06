import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Component, lazy, Suspense, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import type { TasksApi } from '@/api/client';
import { TasksApiProvider } from '@/api/context';
import { EmptyState, PageSkeleton } from '@/components/surface';
import { Button } from '@/components/ui/button';
import { pillControlClass } from '@/components/ui/chrome';
import { cn } from '@/lib/utils';

// Each page's code arrives when it is first opened, so the first screen loads only its own.
const TasksBoard = lazy(() => import('@/routes/TasksBoard'));
const TaskRoute = lazy(() => import('@/routes/TaskRoute'));
const FocusRoute = lazy(() => import('@/routes/FocusRoute'));

/**
 * AGPL-3.0 section 13 requires a modified copy that people use over a network
 * to offer them its source, so every version of the app links to it.
 */
export const SOURCE_URL = 'https://github.com/notice-cx/Ntasks';

export function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true } } });
}

/** The app: its providers and its pages. The router is the caller's, so tests can start at any address. */
export function App({ api, queryClient }: { api: TasksApi; queryClient?: QueryClient }) {
  const [client] = useState(() => queryClient ?? newQueryClient());
  return (
    <QueryClientProvider client={client}>
      <TasksApiProvider api={api}>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Navigate to="/tasks" replace />} />
            <Route path="tasks" element={<TasksBoard />} />
            <Route path="tasks/focus" element={<FocusRoute />} />
            <Route path="tasks/:id" element={<TaskRoute />} />
            <Route path="*" element={<NoPage />} />
          </Route>
        </Routes>
        <Toaster
          position="bottom-right"
          closeButton
          // The toasts wear the page's own tokens, so they follow its theme.
          style={
            {
              '--normal-bg': 'var(--card)',
              '--normal-text': 'var(--foreground)',
              '--normal-border': 'var(--border)',
            } as CSSProperties
          }
          toastOptions={{ className: 'font-sans' }}
        />
      </TasksApiProvider>
    </QueryClientProvider>
  );
}

function Shell() {
  const { pathname } = useLocation();
  const nav = ({ isActive }: { isActive: boolean }) =>
    cn(
      'rounded-md px-2.5 py-1.5 text-sm font-medium',
      pillControlClass,
      isActive ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
    );
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border bg-card/60">
        <div className="mx-auto flex w-full max-w-[1400px] items-center gap-4 px-4 py-2.5 md:px-6">
          <Link
            to="/tasks"
            className={cn('text-base font-semibold tracking-[-0.02em] text-foreground', pillControlClass)}
          >
            Ntasks
          </Link>
          <nav aria-label="Pages" className="flex items-center gap-1">
            <NavLink to="/tasks" end className={nav}>
              Tasks
            </NavLink>
            <NavLink to="/tasks/focus" className={nav}>
              Focus
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="page-arrive flex-1">
        {/* Keyed by the address, so moving to another page tries again. */}
        <PageBoundary key={pathname}>
          <Suspense
            fallback={
              <div className="mx-auto w-full max-w-[1400px] p-4 md:p-6">
                <PageSkeleton shape="list" />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </PageBoundary>
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-muted-foreground md:px-6">
          <span>Ntasks · AGPL-3.0</span>
          <a href={SOURCE_URL} className="underline-offset-4 hover:text-foreground hover:underline" data-source-link="">
            Source code
          </a>
        </div>
      </footer>
    </div>
  );
}

function NoPage() {
  return (
    <div className="mx-auto w-full max-w-[1400px] p-4 md:p-6">
      <EmptyState
        title="No page at this address"
        hint={
          <Link to="/tasks" className="text-foreground underline underline-offset-4">
            Go to Tasks
          </Link>
        }
      />
    </div>
  );
}

/**
 * A page that fails while it loads or draws, such as one whose code changed
 * under a new deployment, takes only itself down: the header and the
 * source-code link stay, with a way to load the page again.
 */
export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        className="mx-auto flex w-full max-w-[1400px] flex-col items-start gap-3 p-4 md:p-6"
        role="alert"
        data-page-failed=""
      >
        <EmptyState title="This page could not load" hint="Reloading fetches the current version of the app." />
        <Button type="button" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
}
