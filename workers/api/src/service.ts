/**
 * The reads the MCP tools and the HTTP routes share: a board, and a task's
 * whole history.
 */
import {
  TASK_LIMITS,
  type BoardQuery,
  type Task,
  type TaskEngine,
  type TaskEvent,
  type TaskStatus,
} from '@ntasks/domain';

/** How many days of closed tasks a board shows, and the most a reader may ask for. */
export const CLOSED_DAYS = 7;
export const CLOSED_HISTORY_DAYS = 56;
const DAY_MS = 86_400_000;

export interface Board {
  readonly readAt: string;
  /** The first day whose closed tasks the board holds, as YYYY-MM-DD. */
  readonly closedSince: string;
  readonly tasks: readonly Task[];
}

/**
 * A board, in one project or, with `projectId` null, in every project: the
 * tasks in the given statuses that are not closed, and those closed from
 * `closedDays` days before now, most urgent first. `filters` narrows both, in
 * the database.
 */
export async function board(
  engine: TaskEngine,
  projectId: string | null,
  statuses: readonly TaskStatus[],
  closedDays: number,
  filters: Omit<BoardQuery, 'statuses' | 'closedSince'>,
  now: () => string,
): Promise<Board> {
  const readAt = now();
  const closedSince = new Date(Date.parse(readAt) - closedDays * DAY_MS).toISOString().slice(0, 10);
  const open = statuses.filter((status): status is Exclude<TaskStatus, 'closed'> => status !== 'closed');
  const tasks = await engine.listBoard(projectId, {
    ...filters,
    statuses: open,
    ...(statuses.includes('closed') ? { closedSince: `${closedSince}T00:00:00.000Z` } : {}),
  });
  return { readAt, closedSince, tasks };
}

/** These tasks, read from a board without their external links, with their
 * external links: one read of these tasks' links alone, so a page of a board
 * costs the links it shows and no other task's. */
export async function withExternalLinks(engine: TaskEngine, tasks: readonly Task[]): Promise<Task[]> {
  if (tasks.length === 0) return [];
  const read = await engine.listExternalLinks(tasks.map((task) => task.id));
  const links = new Map(read.map((entry) => [entry.taskId, entry.externalLinks]));
  return tasks.map((task) => ({ ...task, externalLinks: links.get(task.id) ?? [] }));
}

/** Every event of a task, oldest first. */
export async function allEvents(engine: TaskEngine, projectId: string, taskId: string): Promise<TaskEvent[]> {
  const events: TaskEvent[] = [];
  let beforeSeq: number | undefined;
  for (;;) {
    const page = await engine.listHistory(projectId, taskId, {
      limit: TASK_LIMITS.page,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    });
    events.push(...page);
    if (page.length < TASK_LIMITS.page) break;
    beforeSeq = page.at(-1)!.seq;
  }
  return events.reverse();
}
