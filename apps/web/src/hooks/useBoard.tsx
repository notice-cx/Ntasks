import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { needsSignIn } from '@/api/client';
import type { LiveTasksPayload, TaskProject } from '@/api/types';
import { fieldsProject, readBoard, type BoardFilters, type ProjectRead } from '@/lib/board-read';
import { useChangeFeed } from './useChangeFeed';
import { useBoards, useFilteredBoard, useTaskProjects } from './useTasks';

interface BoardsRead {
  catalog: UseQueryResult<readonly TaskProject[], Error>;
  keys: readonly string[];
  boards: UseQueryResult<LiveTasksPayload, Error>[];
}

const BoardsContext = createContext<BoardsRead | null>(null);

/**
 * Reads every project's board once for everything inside it, the sidebar's
 * counts and the page alike, and keeps them current with the one change feed.
 */
export function BoardsProvider({ children }: { children: ReactNode }) {
  const catalog = useTaskProjects();
  const keys = useMemo(() => (catalog.data ?? []).map((project) => project.logicalKey), [catalog.data]);
  const boards = useBoards(keys);
  useChangeFeed(
    keys.map((project, index) => ({ project, lastSeq: boards[index]?.data?.lastSeq })),
    catalog.data,
  );
  // The query results are new objects on every draw, and the frame draws on
  // every navigation; the shared read changes only when a read's state does,
  // so the pages and the sidebar do not combine every board again for nothing.
  // `version` stands for the query results in the dependencies.
  const version = [catalog, ...boards]
    .map((query) => `${query.status}:${query.fetchStatus}:${query.dataUpdatedAt}:${query.errorUpdatedAt}`)
    .join('|');
  const value = useMemo(() => ({ catalog, keys, boards }), [version, keys]);
  return <BoardsContext.Provider value={value}>{children}</BoardsContext.Provider>;
}

/**
 * Every project's board, read and combined, with the filters applied. Inside
 * a `BoardsProvider`. A filter by custom field is the server's: the board of
 * the one project in view is read again with it, and that read takes the
 * project's place.
 */
export function useBoard(filters: BoardFilters) {
  const shared = useContext(BoardsContext);
  if (!shared) throw new Error('useBoard needs a BoardsProvider around it.');
  const fieldProject = fieldsProject(filters, shared.catalog.data ?? []);
  const fieldFilters = fieldProject === null ? {} : filters.fields;
  const filtering = fieldProject !== null && Object.keys(fieldFilters).length > 0;
  const narrowed = useFilteredBoard(filtering ? fieldProject : null, fieldFilters);
  // A page passes a new filters object on every draw; the same filters are the same read.
  const filterKey = JSON.stringify(filters);
  const narrowedVersion = `${narrowed.status}:${narrowed.fetchStatus}:${narrowed.dataUpdatedAt}:${narrowed.errorUpdatedAt}`;
  return useMemo(() => {
    const { catalog, keys, boards } = shared;
    const reads = new Map<string, ProjectRead>(
      keys.map((key, index) => {
        const board = boards[index];
        return [key, { data: board?.data, error: board?.error ?? null, fetchedAt: board?.dataUpdatedAt || null }];
      }),
    );
    const boardFilters = JSON.parse(filterKey) as BoardFilters;
    let read = readBoard(catalog.data ?? [], reads, boardFilters);
    if (filtering && fieldProject !== null) {
      const whole = read;
      read = readBoard(
        catalog.data ?? [],
        new Map(reads).set(fieldProject, {
          data: narrowed.data,
          error: narrowed.error ?? null,
          fetchedAt: narrowed.dataUpdatedAt || null,
        }),
        boardFilters,
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
      refetch: async () => {
        await Promise.all([
          catalog.refetch(),
          ...boards.map((board) => board.refetch()),
          ...(filtering ? [narrowed.refetch()] : []),
        ]);
      },
    };
    // `narrowedVersion` stands for the filtered read, as `shared` does for the others.
  }, [shared, filterKey, narrowedVersion, fieldProject, filtering]);
}

export type Board = ReturnType<typeof useBoard>;
