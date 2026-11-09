/**
 * Keeps the boards on screen current without reading them again on a timer.
 * A board costs about two database rows per task to read; a poll of the
 * change feed that finds nothing costs almost none. So the page asks the feed
 * what changed since the boards it shows, and reads a project's board and task
 * pages again only when the feed names a change in that project the board does
 * not yet reflect.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useRef } from 'react';
import { retryRead } from '../api/client';
import { useTasksApi } from '../api/context';
import type { TaskProject } from '../api/types';

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
  const keys = new Map((catalog ?? []).map((project) => [project.projectId, project.logicalKey]));
  // The committed render's facts, for a poll that a timer starts. They are set
  // once React commits, since a render it discards must not move the feed, and
  // in a layout effect, which runs before the query's own effects start a poll.
  const latest = useRef({ start, reflected, keys });
  useLayoutEffect(() => {
    latest.current = { start, reflected, keys };
  });
  // Where the last poll got to; a later board position takes over from it.
  const polled = useRef<number | null>(null);
  // Projects whose changes the feed has passed but whose pages have not yet
  // been read again. A project stays here until a read succeeds, because no
  // later poll names those changes again.
  const unread = useRef(new Set<string>());

  async function readAgain(project: string): Promise<void> {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['tasks', project] }),
      client.invalidateQueries({ queryKey: ['task', project] }),
    ]);
    const failure = [
      ...client.getQueryCache().findAll({ queryKey: ['tasks', project], type: 'active' }),
      ...client.getQueryCache().findAll({ queryKey: ['task', project], type: 'active' }),
    ].find((query) => query.state.status === 'error')?.state.error;
    // A refusal answers the same way every time, so only a failure worth retrying keeps the project here.
    if (failure === undefined || !retryRead(0, failure)) unread.current.delete(project);
  }

  useQuery({
    queryKey: ['changes'],
    enabled: start !== null,
    refetchInterval: CHANGE_POLL_MS,
    // Stopped while the page is hidden; asked again the moment it shows.
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const { start: from, reflected: shown, keys: projects } = latest.current;
      const after = Math.max(from ?? 0, polled.current ?? 0);
      const page = await api.changes(after, signal);
      for (const event of page.events) {
        const key = projects.get(event.projectId);
        if (key === undefined) continue;
        if (event.seq > (shown.get(key) ?? -1)) unread.current.add(key);
      }
      polled.current = page.lastSeq;
      for (const project of [...unread.current]) void readAgain(project);
      return page.lastSeq;
    },
  });
}
