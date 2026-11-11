/**
 * Keeps the boards on screen current without reading them again on a timer.
 * A board costs about two database rows per task to read; a poll of the
 * change feed that finds nothing costs almost none. So the page asks the feed
 * what changed since the boards it shows, and reads a project's board and task
 * pages again only when the feed names a change in that project the board does
 * not yet reflect.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useRef, useState } from 'react';
import { retryRead } from '../api/client';
import { useTasksApi } from '../api/context';
import type { LiveTasksPayload, TaskChange, TaskProject } from '../api/types';
import type { TaskWork } from '@ntasks/domain';
import { changeWords } from '../lib/change-words';
import { actorLabel } from '../lib/task-model';

/** How often the feed is asked while the page is visible. A hidden page asks nothing. */
export const CHANGE_POLL_MS = 30_000;

/** How often the Live page asks, so a card moves within seconds of the change; a poll that finds nothing costs almost nothing. */
export const LIVE_POLL_MS = 5_000;

/** How long a change stays worth a label; one older than this is never shown. */
export const RECENT_MS = 60_000;

/** The latest change to a task that the feed brought while the app was open, in words. */
export interface RecentChange {
  readonly seq: number;
  /** Who made it and what it did, such as "Claude commented". */
  readonly label: string;
  /** When this page received it, by its own clock. */
  readonly receivedAt: number;
}

/** One board on screen: its project's key, and the latest change it reflects. */
export interface BoardPosition {
  project: string;
  lastSeq: number | undefined;
}

/**
 * Keeps the boards current, and returns each task's latest change the feed
 * brought in the last minute, in words, for the pages that label it.
 */
export function useChangeFeed(
  boards: readonly BoardPosition[],
  catalog: readonly TaskProject[] | undefined,
  intervalMs: number = CHANGE_POLL_MS,
): ReadonlyMap<string, RecentChange> {
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
  const [recent, setRecent] = useState<ReadonlyMap<string, RecentChange>>(() => new Map());

  /**
   * Each task's latest change on `page`, in words. A work update records the
   * holder's whole set of details, so each is compared with the task as the
   * board held it before the change, or as an earlier event on the page left it.
   */
  function label(events: readonly TaskChange[], projects: ReadonlyMap<string, string>, at: number) {
    const found = new Map<string, RecentChange>();
    const workAfter = new Map<string, TaskWork>();
    for (const event of events) {
      const key = projects.get(event.projectId);
      if (key === undefined) continue;
      const board = client.getQueryData<LiveTasksPayload>(['tasks', key]);
      const held = board?.tasks.find((task) => task.id === event.taskId);
      const words = changeWords(event, { work: workAfter.get(event.taskId) ?? held?.work });
      const work = event.changes?.work;
      if (typeof work === 'object' && work !== null) workAfter.set(event.taskId, work as TaskWork);
      if (words === null || event.actor === undefined) continue;
      const name = actorLabel(event.actor, board?.actors);
      found.set(event.taskId, { seq: event.seq, label: `${name} ${words}`, receivedAt: at });
    }
    if (found.size === 0) return;
    setRecent((before) => {
      const kept = [...before].filter(([, change]) => at - change.receivedAt < RECENT_MS);
      return new Map([...kept, ...found]);
    });
  }

  // Projects whose pages are being read again, and those a poll found a newer
  // change in meanwhile. A poll never cancels a read under way, which on a
  // slow board would restart it on every poll and never finish; the change it
  // found is read once that read is done.
  const reading = useRef(new Set<string>());
  const behind = useRef(new Set<string>());

  async function readAgain(project: string): Promise<void> {
    if (reading.current.has(project)) {
      behind.current.add(project);
      return;
    }
    reading.current.add(project);
    try {
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
    } finally {
      reading.current.delete(project);
    }
    if (behind.current.delete(project)) {
      unread.current.add(project);
      await readAgain(project);
    }
  }

  useQuery({
    queryKey: ['changes'],
    enabled: start !== null,
    refetchInterval: intervalMs,
    // Stopped while the page is hidden; asked again the moment it shows.
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const { start: from, reflected: shown, keys: projects } = latest.current;
      const after = Math.max(from ?? 0, polled.current ?? 0);
      const page = await api.changes(after, signal);
      // Worded before the boards are read again, while they still hold each task as it was.
      label(page.events, projects, Date.now());
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
  return recent;
}
