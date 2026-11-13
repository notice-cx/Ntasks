import { createContext, useContext, type ReactNode } from 'react';

/**
 * The addresses of the app's pages. Every page sits under the base path the
 * host mounts the app at: the board is the base path itself, a task is
 * `<base>/<id>`, and the other pages are `<base>/focus`, `<base>/live`,
 * `<base>/productivity` and `<base>/settings`, whose tabs are
 * `<base>/settings/<tab>`, Projects and Members among them.
 * `<base>/projects` and `<base>/members` open those tabs. A task id always
 * holds a hyphen, so none of those words is ever a task's address.
 */
export interface AppPaths {
  /** The board: the base path itself. */
  readonly board: string;
  readonly focus: string;
  readonly live: string;
  readonly productivity: string;
  /** Settings's Projects tab. */
  readonly projects: string;
  /** Settings's Members tab. */
  readonly members: string;
  readonly settings: string;
  /** One of Settings's tabs. */
  settingsTab(tab: string): string;
  /** The project's landing page and its task queue. */
  project(key: string): string;
  projectTasks(key: string): string;
  /** Whether a path is Settings or one of its tabs. */
  isSettings(pathname: string): boolean;
  task(id: string): string;
  /** Whether a path on this site is one of the app's pages, which a link routes to instead of loading. */
  isAppPage(pathname: string): boolean;
}

/**
 * `/tasks`, `tasks/` and `/tasks/` all name `/tasks`. The site's root is
 * refused: there a task's address, such as `/web-b2r6`, would look like the
 * site's own, such as `/sign-in`, and a link could not tell them apart.
 */
export function normalBasePath(basePath: string): string {
  const trimmed = basePath.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') throw new Error('basePath names a path below the root, such as /tasks.');
  return `/${trimmed}`;
}

export function appPaths(basePath: string): AppPaths {
  const board = normalBasePath(basePath);
  const under = (rest: string) => `${board}/${rest}`;
  return {
    board,
    focus: under('focus'),
    live: under('live'),
    productivity: under('productivity'),
    projects: under('settings/projects'),
    members: under('settings/members'),
    settings: under('settings'),
    settingsTab: (tab) => under(`settings/${encodeURIComponent(tab)}`),
    project: (key) => under(`projects/${encodeURIComponent(key)}`),
    projectTasks: (key) => under(`projects/${encodeURIComponent(key)}/tasks`),
    isSettings: (pathname) => pathname === under('settings') || pathname.startsWith(`${under('settings')}/`),
    task: (id) => under(encodeURIComponent(id)),
    isAppPage: (pathname) => pathname === board || pathname.startsWith(`${board}/`),
  };
}

const Paths = createContext<AppPaths>(appPaths('/tasks'));

export function PathsProvider({ paths, children }: { paths: AppPaths; children: ReactNode }) {
  return <Paths.Provider value={paths}>{children}</Paths.Provider>;
}

export function usePaths(): AppPaths {
  return useContext(Paths);
}
