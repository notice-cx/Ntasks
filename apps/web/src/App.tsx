import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Component, lazy, Suspense, useState, type CSSProperties, type ReactNode } from 'react';
import { LucideProvider } from 'lucide-react';
import { Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { retryRead, type TasksApi } from '@/api/client';
import { TasksApiProvider } from '@/api/context';
import { AppSidebar } from '@/components/AppSidebar';
import { PageSkeleton } from '@/components/surface';
import { WorkspaceGate } from '@/components/WorkspaceGate';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { AppShell, TopBar } from '@/components/ui/shell';
import { BoardsProvider } from '@/hooks/useBoard';
import { useShortcut } from '@/hooks/useShortcut';
import { useCapabilities, writesAvailable } from '@/hooks/useTasks';
import { COMPOSE_STATE, SEARCH_STATE, SOURCE_URL } from '@/lib/page-state';

// Each page's code arrives when it is first opened, so the first screen loads only its own.
const TasksBoard = lazy(() => import('@/routes/TasksBoard'));
const TaskRoute = lazy(() => import('@/routes/TaskRoute'));
const FocusRoute = lazy(() => import('@/routes/FocusRoute'));
const ProjectsRoute = lazy(() => import('@/routes/ProjectsRoute'));
const MembersRoute = lazy(() => import('@/routes/MembersRoute'));
const DesignRoute = lazy(() => import('@/routes/DesignRoute'));

export { SOURCE_URL };

export function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true, retry: retryRead } } });
}

/** The app: its providers and its pages. The router is the caller's, so tests can start at any address. */
export function App({ api, queryClient }: { api: TasksApi; queryClient?: QueryClient }) {
  const [client] = useState(() => queryClient ?? newQueryClient());
  return (
    <QueryClientProvider client={client}>
      {/* Every icon is drawn at 16 px with a 1.75 stroke unless its control sizes it (docs/design.md). */}
      <LucideProvider size={16} strokeWidth={1.75}>
        <TasksApiProvider api={api}>
          <Routes>
            <Route
              path="design"
              element={
                <Suspense fallback={null}>
                  <DesignRoute />
                </Suspense>
              }
            />
            <Route element={<WorkspaceGate />}>
              <Route element={<Shell />}>
                <Route index element={<Navigate to="/tasks" replace />} />
                <Route path="tasks" element={<TasksBoard />} />
                <Route path="tasks/focus" element={<FocusRoute />} />
                <Route path="tasks/:id" element={<TaskRoute />} />
                <Route path="projects" element={<ProjectsRoute />} />
                <Route path="members" element={<MembersRoute />} />
                <Route path="*" element={<NoPage />} />
              </Route>
            </Route>
          </Routes>
          <Toaster
            position="bottom-right"
            closeButton
            // The toasts wear the page's own tokens, so they follow its theme.
            style={
              {
                '--normal-bg': 'var(--background)',
                '--normal-text': 'var(--ink)',
                '--normal-border': 'var(--border)',
              } as CSSProperties
            }
            toastOptions={{ className: 'font-sans' }}
          />
        </TasksApiProvider>
      </LucideProvider>
    </QueryClientProvider>
  );
}

/**
 * The frame every task page shares: the sidebar, the page, and the keys that
 * work on any of them: `C` for a new task, `/` to search the board and `F`
 * for Focus.
 */
function Shell() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const writable = writesAvailable(useCapabilities());
  // The board keeps its filters when a key opens something on it.
  const board = `/tasks${pathname === '/tasks' ? search : ''}`;
  useShortcut('c', () => void navigate(board, { state: { [COMPOSE_STATE]: true } }), writable);
  useShortcut('/', () => void navigate(board, { state: { [SEARCH_STATE]: Date.now() } }));
  // On Focus itself, F would start it again and drop the decision and project its address names.
  useShortcut(
    'f',
    () => void navigate('/tasks/focus', { state: { returnTo: `${pathname}${search}` } }),
    pathname !== '/tasks/focus',
  );
  return (
    <BoardsProvider>
      <AppShell sidebar={<AppSidebar />}>
        <div className="page-arrive">
          {/* Moving to another address tries again, without rebuilding a page that did not fail. */}
          <PageBoundary resetKey={pathname}>
            <Suspense
              fallback={
                <div className="p-6 max-sm:p-4">
                  <PageSkeleton shape="list" />
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </PageBoundary>
        </div>
      </AppShell>
    </BoardsProvider>
  );
}

function NoPage() {
  return (
    <>
      <TopBar title="No page" />
      <EmptyState
        title="No page at this address"
        action={
          <Button asChild size="sm">
            <Link to="/tasks">Go to Tasks</Link>
          </Button>
        }
      />
    </>
  );
}

/**
 * A page that fails while it loads or draws, such as one whose code changed
 * under a new deployment, takes only itself down: the sidebar and its
 * source-code link stay, with a way to load the page again.
 */
export class PageBoundary extends Component<
  { children: ReactNode; resetKey?: string },
  { failed: boolean; resetKey: string | undefined }
> {
  override state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  /** A new address clears a failure; the pages that did not fail keep their state. */
  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { resetKey: string | undefined },
  ): { failed: boolean; resetKey: string | undefined } | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" data-page-failed="">
        <TopBar title="Ntasks" />
        <EmptyState
          title="This page could not load"
          action={
            <Button variant="primary" size="sm" type="button" onClick={() => window.location.reload()}>
              Reload
            </Button>
          }
        />
      </div>
    );
  }
}
