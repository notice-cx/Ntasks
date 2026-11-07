import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { needsSignIn } from '@/api/client';
import type { LiveTasksPayload, TaskProject } from '@/api/types';
import { readBoard, type BoardFilters, type ProjectRead } from '@/lib/board-read';
import { useChangeFeed } from './useChangeFeed';
import { useBoards, useTaskProjects } from './useTasks';

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

/** Every project's board, read and combined, with the filters applied. Inside a `BoardsProvider`. */
export function useBoard(filters: BoardFilters) {
  const shared = useContext(BoardsContext);
  if (!shared) throw new Error('useBoard needs a BoardsProvider around it.');
  // A page passes a new filters object on every draw; the same filters are the same read.
  const filterKey = JSON.stringify(filters);
  return useMemo(() => {
    const { catalog, keys, boards } = shared;
    const reads = new Map<string, ProjectRead>(
      keys.map((key, index) => {
        const board = boards[index];
        return [key, { data: board?.data, error: board?.error ?? null, fetchedAt: board?.dataUpdatedAt || null }];
      }),
    );
    const read = readBoard(catalog.data ?? [], reads, JSON.parse(filterKey) as BoardFilters);
    // A refusal for want of sign-in is never one project's: every read gets it, so
    // the page asks for sign-in instead of naming the projects it could not read.
    const signedOut = boards.find((board) => needsSignIn(board.error))?.error ?? null;
    return {
      ...read,
      catalog,
      /** What stops the whole page: the project list's failure, or a board read refused for want of sign-in. */
      readFailure: catalog.isError ? catalog.error : signedOut,
      loading: catalog.isPending || (keys.length > 0 && boards.every((board) => board.isPending)),
      fetching: catalog.isFetching || boards.some((board) => board.isFetching),
      refetch: async () => {
        await Promise.all([catalog.refetch(), ...boards.map((board) => board.refetch())]);
      },
    };
  }, [shared, filterKey]);
}

export type Board = ReturnType<typeof useBoard>;
