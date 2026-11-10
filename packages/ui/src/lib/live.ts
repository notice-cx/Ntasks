/**
 * How recently the holder of each task in progress worked on it: the Live
 * page's groups and the sidebar's live dots, by the rule the server lists
 * them by (activityOf in @ntasks/domain). The signal is the task's last
 * activity, when its holder last changed or commented on it, which the server
 * sends with every task. Stalled is the server's: the `stalled` it sends as of
 * its read, so a browser's clock never disagrees with it; a server that sends
 * none is read by the same rule. It is never written to the task: its status
 * stays In progress until someone frees it.
 */
import { activityOf as activityAt, ACTIVITIES, type Activity } from '@ntasks/domain';
import { ageMs } from './format';
import type { BoardTask } from './task-model';

export { ACTIVITIES, type Activity };

export const ACTIVITY_LABELS: Readonly<Record<Activity, string>> = Object.freeze({
  active: 'Active',
  quiet: 'Quiet',
  stalled: 'Stalled',
});

type Held = Pick<BoardTask, 'status' | 'assignee' | 'lastActivityAt' | 'stalled'>;

/** How recently a task's holder worked on it, at the page's clock with the server's stalled; null when it is not in progress. */
export function activityOf(task: Held, nowMs: number): Activity | null {
  return activityAt(task, new Date(nowMs).toISOString(), task.stalled);
}

/** Whether a task is in progress and its holder changed or commented on it within the hour. */
export function activeNow(task: Held, nowMs: number): boolean {
  return activityOf(task, nowMs) === 'active';
}

export type LiveGroups = Readonly<Record<Activity, readonly BoardTask[]>>;

/**
 * The tasks in progress by how recently their holders worked on them, each
 * group with the latest activity first and tasks with none recorded last.
 */
export function liveGroups(tasks: readonly BoardTask[], nowMs: number): LiveGroups {
  const groups: Record<Activity, BoardTask[]> = { active: [], quiet: [], stalled: [] };
  for (const task of tasks) {
    const activity = activityOf(task, nowMs);
    if (activity !== null) groups[activity].push(task);
  }
  const latest = (task: BoardTask) => ageMs(nowMs, task.lastActivityAt) ?? Number.POSITIVE_INFINITY;
  for (const group of Object.values(groups)) {
    group.sort((a, b) => latest(a) - latest(b) || a.id.localeCompare(b.id));
  }
  return groups;
}
