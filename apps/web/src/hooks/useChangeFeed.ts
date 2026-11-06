/**
 * Keeps the boards on screen current without reading them again on a timer.
 * A board costs about two database rows per task to read; a poll of the
 * change feed that finds nothing costs almost none. So the page asks the feed
 * what changed since the boards it shows, and reads a project's board and task
 * pages again only when the feed names a change in that project the board does
 * not yet reflect.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useTasksApi } from '@/api/context';
import type { TaskProject } from '@/api/types';

/** How often the feed is asked while the page is visible. A hidden page asks nothing. */
export const CHANGE_POLL_MS = 30_000;

/** One board on screen: its project's key, and the latest change it reflects. */
export interface BoardPosition {
  project: string;
  lastSeq: number | undefined;
}

export function useChangeFeed(boards: readonly BoardPosition[], catalog: readonly TaskProject[] | undefined): void {
  const api = useTasksApi();
  const client = useQueryClient();
  const reflected = new Map(
    boards.flatMap((board) => (typeof board.lastSeq === 'number' ? [[board.project, board.lastSeq] as const] : [])),
  );
  // Every board reflects every change up to the oldest of their positions, so the feed starts there.
  const start = reflected.size === 0 ? null : Math.min(...reflected.values());
  // The latest render's facts, for a poll that a timer starts.
  const latest = useRef({ start, reflected, keys: new Map<string, string>() });
  latest.current = {
    start,
    reflected,
    keys: new Map((catalog ?? []).map((project) => [project.projectId, project.logicalKey])),
  };
  // Where the last poll got to; a later board position takes over from it.
  const polled = useRef<number | null>(null);

  useQuery({
    queryKey: ['changes'],
    enabled: start !== null,
    refetchInterval: CHANGE_POLL_MS,
    // Stopped while the page is hidden; asked again the moment it shows.
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const { start: from, reflected: shown, keys } = latest.current;
      const after = Math.max(from ?? 0, polled.current ?? 0);
      const page = await api.changes(after, signal);
      const changed = new Set<string>();
      for (const event of page.events) {
        const key = keys.get(event.projectId);
        if (key === undefined) continue;
        if (event.seq > (shown.get(key) ?? -1)) changed.add(key);
      }
      polled.current = page.lastSeq;
      for (const key of changed) {
        void client.invalidateQueries({ queryKey: ['tasks', key] });
        void client.invalidateQueries({ queryKey: ['task', key] });
      }
      return page.lastSeq;
    },
  });
}
