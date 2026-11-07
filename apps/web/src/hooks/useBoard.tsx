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
  return <BoardsContext.Provider value={{ catalog, keys, boards }}>{children}</BoardsContext.Provider>;
}

/** Every project's board, read and combined, with the filters applied. Inside a `BoardsProvider`. */
export function useBoard(filters: BoardFilters) {
  const shared = useContext(BoardsContext);
  if (!shared) throw new Error('useBoard needs a BoardsProvider around it.');
  const { catalog, keys, boards } = shared;
  const reads = new Map<string, ProjectRead>(
    keys.map((key, index) => {
      const board = boards[index];
      return [key, { data: board?.data, error: board?.error ?? null, fetchedAt: board?.dataUpdatedAt || null }];
    }),
  );
  const read = readBoard(catalog.data ?? [], reads, filters);
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
}

export type Board = ReturnType<typeof useBoard>;
