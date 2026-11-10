import { createContext, useContext, type ReactNode } from 'react';

/**
 * The addresses of the app's pages. Every page sits under the base path the
 * host mounts the app at: the board is the base path itself, a task is
 * `<base>/<id>`, and the other pages are `<base>/focus`, `<base>/live`,
 * `<base>/productivity`, `<base>/projects`, `<base>/members` and
 * `<base>/settings`. A task id
 * always holds a hyphen, so none of those words is ever a task's address.
 */
export interface AppPaths {
  /** The board: the base path itself. */
  readonly board: string;
  readonly focus: string;
  readonly live: string;
  readonly productivity: string;
  readonly projects: string;
  readonly members: string;
  readonly settings: string;
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
    projects: under('projects'),
    members: under('members'),
    settings: under('settings'),
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
