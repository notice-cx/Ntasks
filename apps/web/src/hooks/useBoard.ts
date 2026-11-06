import { useMemo } from 'react';
import { needsSignIn } from '@/api/client';
import { readBoard, type BoardFilters, type ProjectRead } from '@/lib/board-read';
import { useBoards, useTaskProjects } from './useTasks';

/** Every project's board, read and combined, with the filters applied. */
export function useBoard(filters: BoardFilters, nowMs: number) {
  const catalog = useTaskProjects();
  const keys = useMemo(() => (catalog.data ?? []).map((project) => project.logicalKey), [catalog.data]);
  const boards = useBoards(keys);
  const reads = new Map<string, ProjectRead>(
    keys.map((key, index) => {
      const board = boards[index];
      return [key, { data: board?.data, error: board?.error ?? null, fetchedAt: board?.dataUpdatedAt || null }];
    }),
  );
  const read = readBoard(catalog.data ?? [], reads, filters, nowMs);
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
