import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { LucideProvider } from 'lucide-react';
import { Link, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { retryRead, type TasksApi } from './api/client';
import type { TokenSource } from './api/connection';
import { TasksApiProvider } from './api/context';
import { AppSidebar } from './components/AppSidebar';
import { PageSkeleton } from './components/surface';
import { WorkspaceGate } from './components/WorkspaceGate';
import { Button } from './components/ui/button';
import { EmptyState } from './components/ui/empty-state';
import { AppToaster } from './components/ui/toaster';
import { AppShell, TopBar } from './components/ui/shell';
import { BoardsProvider } from './hooks/useBoard';
import { useShortcut } from './hooks/useShortcut';
import { useCapabilities, writesAvailable } from './hooks/useTasks';
import { COMPOSE_STATE, SEARCH_STATE } from './lib/page-state';
import { PathsProvider, usePaths, type AppPaths } from './lib/paths';
import { browserTimeZone, TimeZoneProvider } from './lib/dates';
import { TitleProvider, usePageTitle } from './lib/page-title';

// Each page's code arrives when it is first opened, so the first screen loads only its own.
const TasksBoard = lazy(() => import('./routes/TasksBoard'));
const TaskRoute = lazy(() => import('./routes/TaskRoute'));
const FocusRoute = lazy(() => import('./routes/FocusRoute'));
const LiveRoute = lazy(() => import('./routes/LiveRoute'));
const ProductivityRoute = lazy(() => import('./routes/ProductivityRoute'));
const ProjectsRoute = lazy(() => import('./routes/ProjectsRoute'));
const MembersRoute = lazy(() => import('./routes/MembersRoute'));
const SettingsRoute = lazy(() => import('./routes/SettingsRoute'));

export function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true, retry: retryRead } } });
}

/**
 * The app: its providers and its pages. The router and the route the pages
 * sit under are the caller's: the pages' routes are relative to it, and
 * `paths` names the same addresses for links.
 */
export function App({
  api,
  paths,
  signIn,
  queryClient,
  onTitle,
  timeZone,
}: {
  api: TasksApi;
  paths: AppPaths;
  signIn?: TokenSource['signIn'];
  queryClient?: QueryClient;
  /** Receives each page's title in place of the document's title (`TitleProvider`). */
  onTitle?: (title: string) => void;
  /** The IANA time zone dates are shown in; the browser's when left out (`lib/dates.ts`). */
  timeZone?: string;
}) {
  const [client] = useState(() => queryClient ?? newQueryClient());
  const zone = timeZone ?? browserTimeZone();
  return (
    <QueryClientProvider client={client}>
      {/* Every icon is drawn at 16 px with a 1.75 stroke unless its control sizes it (docs/design.md). */}
      <LucideProvider size={16} strokeWidth={1.75}>
        <PathsProvider paths={paths}>
          <TitleProvider onTitle={onTitle}>
            <TimeZoneProvider zone={zone}>
              <TasksApiProvider api={api} signIn={signIn}>
                <Routes>
                  <Route element={<WorkspaceGate />}>
                    <Route element={<Shell />}>
                      <Route index element={<TasksBoard />} />
                      <Route path="focus" element={<FocusRoute />} />
                      <Route path=":id" element={<TaskRoute />} />
                      <Route path="live" element={<LiveRoute />} />
                      <Route path="productivity" element={<ProductivityRoute />} />
                      <Route path="projects" element={<ProjectsRoute />} />
                      <Route path="members" element={<MembersRoute />} />
                      <Route path="settings" element={<SettingsRoute />} />
                      <Route path="*" element={<NoPage />} />
                    </Route>
                  </Route>
                </Routes>
                <AppToaster />
              </TasksApiProvider>
            </TimeZoneProvider>
          </TitleProvider>
        </PathsProvider>
      </LucideProvider>
    </QueryClientProvider>
  );
}

/**
 * The frame every task page shares: the sidebar, the page, and the keys that
 * work on any of them: `C` for a new task, `/` to search the board, `F` for
 * Focus and `L` for Live.
 */
function Shell() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const paths = usePaths();
  const writable = writesAvailable(useCapabilities());
  // The board keeps its filters when a key opens something on it.
  const board = `${paths.board}${pathname === paths.board ? search : ''}`;
  useShortcut('c', () => void navigate(board, { state: { [COMPOSE_STATE]: true } }), writable);
  useShortcut('/', () => void navigate(board, { state: { [SEARCH_STATE]: Date.now() } }));
  // On Focus itself, F would start it again and drop the decision and project its address names.
  useShortcut(
    'f',
    () => void navigate(paths.focus, { state: { returnTo: `${pathname}${search}` } }),
    pathname !== paths.focus,
  );
  useShortcut('l', () => void navigate(paths.live), pathname !== paths.live);
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
  const paths = usePaths();
  usePageTitle('No page');
  return (
    <>
      <TopBar title="No page" />
      <EmptyState
        title="No page at this address"
        action={
          <Button asChild size="sm">
            <Link to={paths.board}>Go to Tasks</Link>
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
