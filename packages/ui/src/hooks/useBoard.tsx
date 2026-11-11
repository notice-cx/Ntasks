import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { needsSignIn } from '../api/client';
import type { LiveTasksPayload, TaskProject } from '../api/types';
import { fieldsProject, readBoard, type BoardFilters, type ProjectRead } from '../lib/board-read';
import { useChangeFeed, type RecentChange } from './useChangeFeed';
import { useBoards, useFilteredBoard, useTaskProjects, useTaskSearch } from './useTasks';

interface BoardsRead {
  catalog: UseQueryResult<readonly TaskProject[], Error>;
  /** The projects the board shows: every one but those disabled. */
  active: readonly TaskProject[];
  keys: readonly string[];
  boards: UseQueryResult<LiveTasksPayload, Error>[];
  /** Each task's latest change the feed brought in the last minute, in words. */
  recent: ReadonlyMap<string, RecentChange>;
}

const BoardsContext = createContext<BoardsRead | null>(null);

/**
 * Reads every project's board once for everything inside it, the sidebar's
 * counts and the page alike, and keeps them current with the one change feed.
 * A disabled project's board is not read: it leaves the sidebar, the board
 * and its menus, and its tasks still open on their own pages.
 */
export function BoardsProvider({
  children,
  pollMs,
}: {
  children: ReactNode;
  /** How often to ask the change feed. */
  pollMs?: number;
}) {
  const catalog = useTaskProjects();
  const active = useMemo(() => (catalog.data ?? []).filter((project) => project.disabled !== true), [catalog.data]);
  const keys = useMemo(() => active.map((project) => project.logicalKey), [active]);
  const boards = useBoards(keys);
  const recent = useChangeFeed(
    keys.map((project, index) => ({ project, lastSeq: boards[index]?.data?.lastSeq })),
    // Every project, so a change to a disabled project's task still refreshes its open page.
    catalog.data,
    pollMs,
  );
  // The query results are new objects on every draw, and the frame draws on
  // every navigation; the shared read changes only when a read's state does,
  // so the pages and the sidebar do not combine every board again for nothing.
  // `version` stands for the query results in the dependencies.
  const version = [catalog, ...boards]
    .map((query) => `${query.status}:${query.fetchStatus}:${query.dataUpdatedAt}:${query.errorUpdatedAt}`)
    .join('|');
  const value = useMemo(() => ({ catalog, active, keys, boards, recent }), [version, active, keys, recent]);
  return <BoardsContext.Provider value={value}>{children}</BoardsContext.Provider>;
}

/**
 * Every project's board, read and combined, with the filters applied. Inside
 * a `BoardsProvider`. A filter by custom field is the server's: the board of
 * the one project in view is read again with it, and that read takes the
 * project's place. The search is the server's too, of every project, so it
 * finds what no board read holds; the boards' own rows match it meanwhile.
 */
export function useBoard(filters: BoardFilters) {
  const shared = useContext(BoardsContext);
  if (!shared) throw new Error('useBoard needs a BoardsProvider around it.');
  const fieldProject = fieldsProject(filters, shared.active);
  const fieldFilters = fieldProject === null ? {} : filters.fields;
  const filtering = fieldProject !== null && Object.keys(fieldFilters).length > 0;
  const narrowed = useFilteredBoard(filtering ? fieldProject : null, fieldFilters);
  const search = useTaskSearch(filters.q);
  // A page passes a new filters object on every draw; the same filters are the same read.
  const filterKey = JSON.stringify(filters);
  const narrowedVersion = `${narrowed.status}:${narrowed.fetchStatus}:${narrowed.dataUpdatedAt}:${narrowed.errorUpdatedAt}`;
  return useMemo(() => {
    const { catalog, active, keys, boards } = shared;
    const reads = new Map<string, ProjectRead>(
      keys.map((key, index) => {
        const board = boards[index];
        return [key, { data: board?.data, error: board?.error ?? null, fetchedAt: board?.dataUpdatedAt || null }];
      }),
    );
    const boardFilters = JSON.parse(filterKey) as BoardFilters;
    let read = readBoard(active, reads, boardFilters, search.found);
    if (filtering && fieldProject !== null) {
      const whole = read;
      read = readBoard(
        active,
        new Map(reads).set(fieldProject, {
          data: narrowed.data,
          error: narrowed.error ?? null,
          fetchedAt: narrowed.dataUpdatedAt || null,
        }),
        boardFilters,
        search.found,
      );
      // The Filter menu's counts are the whole project's, as no other filter narrows them either.
      read = {
        ...read,
        statusCounts: whole.statusCounts,
        priorityCounts: whole.priorityCounts,
        assigneeCounts: whole.assigneeCounts,
        projectCounts: whole.projectCounts,
      };
    }
    // A refusal for want of sign-in is never one project's: every read gets it, so
    // the page asks for sign-in instead of naming the projects it could not read.
    const signedOut = boards.find((board) => needsSignIn(board.error))?.error ?? null;
    const fieldIndex = fieldProject === null ? -1 : keys.indexOf(fieldProject);
    return {
      ...read,
      catalog,
      /** The projects that take new tasks, which the board shows. */
      active,
      /** The project the Filter menu offers custom fields of, or null with several projects in view. */
      fieldProject,
      /** That project's tasks before any filter by custom field, which the Filter menu counts values in. */
      fieldTasks: (fieldIndex < 0 ? undefined : boards[fieldIndex]?.data?.tasks) ?? [],
      /** What stops the whole page: the project list's failure, or a board read refused for want of sign-in. */
      readFailure: catalog.isError ? catalog.error : signedOut,
      loading:
        catalog.isPending ||
        (keys.length > 0 && boards.every((board) => board.isPending)) ||
        (filtering && narrowed.isPending),
      fetching: catalog.isFetching || boards.some((board) => board.isFetching) || narrowed.isFetching,
      /** The server has not yet answered the search typed. */
      searching: search.searching,
      /** Why the server's search failed, when it did: only the boards' own rows match it. */
      searchFailure: search.failure,
      refetch: async () => {
        await Promise.all([
          catalog.refetch(),
          ...boards.map((board) => board.refetch()),
          ...(filtering ? [narrowed.refetch()] : []),
          search.refetch(),
        ]);
      },
    };
    // `narrowedVersion` and `search.version` stand for those reads, as `shared` does for the others.
  }, [shared, filterKey, narrowedVersion, search.version, fieldProject, filtering]);
}

export type Board = ReturnType<typeof useBoard>;

/** Each task's latest change the feed brought in the last minute, in words, by task id. Inside a `BoardsProvider`. */
export function useRecentChanges(): ReadonlyMap<string, RecentChange> {
  const shared = useContext(BoardsContext);
  if (!shared) throw new Error('useRecentChanges needs a BoardsProvider around it.');
  return shared.recent;
}
