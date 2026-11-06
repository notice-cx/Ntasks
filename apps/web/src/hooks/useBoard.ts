import { useMemo } from 'react';
import { readBoard, type BoardFilters, type ProjectRead } from '@/lib/board-read';
import { useBoards, useTaskProjects } from './useTasks';

/** Every project's board, read and combined, with the filters applied. */
export function useBoard(filters: BoardFilters, nowMs: number) {
  const catalog = useTaskProjects();
  const keys = useMemo(() => (catalog.data ?? []).map((project) => project.logicalKey), [catalog.data]);
  const boards = useBoards(keys);
  const reads = new Map<string, ProjectRead>(
    keys.map((key, index) => [key, { data: boards[index]?.data, error: boards[index]?.error ?? null }]),
  );
  const read = readBoard(catalog.data ?? [], reads, filters, nowMs);
  return {
    ...read,
    catalog,
    loading: catalog.isPending || (keys.length > 0 && boards.every((board) => board.isPending)),
    fetching: catalog.isFetching || boards.some((board) => board.isFetching),
    refetch: async () => {
      await Promise.all([catalog.refetch(), ...boards.map((board) => board.refetch())]);
    },
  };
}
