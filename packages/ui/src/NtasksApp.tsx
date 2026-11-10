import { LucideProvider } from 'lucide-react';
import { lazy, Suspense, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes, useInRouterContext, useParams } from 'react-router-dom';
import { App } from './App';
import type { TasksApi } from './api/client';
import { connect, originOf, sessionCookie, type TokenSource } from './api/connection';
import { ThemeScope } from './components/ui/popover';
import { AppToaster } from './components/ui/toaster';
import { appPaths } from './lib/paths';
import { useResolvedTheme, type Theme } from './lib/theme';

const DesignRoute = lazy(() => import('./routes/DesignRoute'));

export interface NtasksAppProps {
  /**
   * The Ntasks to read and write, such as `https://tasks.example.com`. Left
   * out, the page's own origin.
   */
  apiOrigin?: string;
  /**
   * How each request says who is asking. Left out, the Ntasks session cookie,
   * which only a page on the Ntasks origin itself has.
   */
  tokenSource?: TokenSource;
  /**
   * The address of the board, below the site's root; every other page is
   * under it. `/tasks` (the default) puts the board at `/tasks` and a task at
   * `/tasks/<id>`.
   */
  basePath?: string;
  /** `system` (the default) follows the system's preference while the page is open. */
  theme?: Theme;
  /**
   * Calls to read and write through in place of `apiOrigin` and
   * `tokenSource`, such as `@notice-cx/ntasks-ui/fixture`'s.
   */
  api?: TasksApi;
  /**
   * Receives each page's title, such as `web-b2r6 · Fix the reset link —
   * Ntasks`, in place of the document's title, so a host keeps its own tab
   * title and may show this one in it. Left out, the app sets the document's
   * title.
   */
  onTitle?: (title: string) => void;
}

/**
 * The Ntasks web app. Inside a host's React Router it uses the host's router:
 * render it as the element of the route `<basePath>/*`. Without a router it
 * makes its own on the page's history.
 */
export function NtasksApp(props: NtasksAppProps) {
  return useInRouterContext() ? (
    <Placed {...props} />
  ) : (
    <BrowserRouter>
      <Placed {...props} />
    </BrowserRouter>
  );
}

function Placed({
  apiOrigin: given,
  tokenSource,
  basePath = '/tasks',
  theme = 'system',
  api,
  onTitle,
}: NtasksAppProps) {
  const paths = useMemo(() => appPaths(basePath), [basePath]);
  const apiOrigin = given === undefined ? undefined : originOf(given);
  const current = tokenSource ?? sessionCookie(apiOrigin);
  // The source is read when each request is sent, so a host may pass a new
  // object on every render without the calls, and the workspace they are
  // made in, starting again. A layout effect updates it before the pages'
  // own effects send their requests.
  const source = useRef(current);
  useLayoutEffect(() => {
    source.current = current;
  });
  const calls = useMemo(() => api ?? connect(apiOrigin, () => source.current), [api, apiOrigin]);
  // In a host's `<basePath>/*` route the pages' routes are relative to it;
  // at the top of a router they sit under the base path themselves.
  const inHostRoute = '*' in useParams();
  const app = (
    <Root theme={theme}>
      {/* A new Ntasks starts the app again, with none of the last one's reads. */}
      <App key={apiOrigin} api={calls} paths={paths} signIn={current.signIn} onTitle={onTitle} />
    </Root>
  );
  if (inHostRoute) return app;
  return (
    <Routes>
      <Route path={`${paths.board}/*`} element={app} />
    </Routes>
  );
}

/**
 * The app's root element. The design system's tokens and every style the
 * package's stylesheet holds apply only inside `[data-ntasks]`, so they
 * neither reach the host's page nor take the host's values.
 */
function Root({ theme, children }: { theme: Theme; children: ReactNode }) {
  return (
    <ThemeScope theme={useResolvedTheme(theme)} data-ntasks="">
      {children}
    </ThemeScope>
  );
}

/**
 * The design system's gallery: every token, symbol and component, in light
 * or dark. It reads no tasks and needs no router.
 */
export function DesignGallery({ theme = 'system' }: { theme?: Theme }) {
  return (
    <Root theme={theme}>
      <LucideProvider size={16} strokeWidth={1.75}>
        <Suspense fallback={null}>
          <DesignRoute />
        </Suspense>
        {/* The gallery's Copy buttons say a failed copy in a toast. */}
        <AppToaster />
      </LucideProvider>
    </Root>
  );
}
