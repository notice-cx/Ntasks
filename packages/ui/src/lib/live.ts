/**
 * How recently the holder of each task in progress worked on it: the Live
 * page's groups and the sidebar's live dots. The signal is the task's last
 * activity, when its holder last changed or commented on it, which the server
 * sends with every task. Stalled is the server's rule (isStalled in
 * @ntasks/domain), worked out here with the page's clock so a task turns
 * stalled without a new read. It is never written to the task: its status
 * stays In progress until someone frees it.
 */
import { isStalled } from '@ntasks/domain';
import { ageMs } from './format';
import { IN_PROGRESS, type BoardTask } from './task-model';

export type Activity = 'active' | 'quiet' | 'stalled';

export const ACTIVITIES: readonly Activity[] = ['active', 'quiet', 'stalled'];

export const ACTIVITY_LABELS: Readonly<Record<Activity, string>> = Object.freeze({
  active: 'Active',
  quiet: 'Quiet',
  stalled: 'Stalled',
});

/** A task whose holder wrote to it within this long is active. */
export const ACTIVE_WITHIN_MS = 3_600_000;

type Held = Pick<BoardTask, 'status' | 'assignee' | 'lastActivityAt'>;

/** How recently a task's holder worked on it: stalled by the server's rule, else active within the hour, else quiet. */
export function activityOf(task: Held, nowMs: number): Activity {
  if (isStalled(task, new Date(nowMs).toISOString())) return 'stalled';
  const age = ageMs(nowMs, task.lastActivityAt);
  return age !== null && age < ACTIVE_WITHIN_MS ? 'active' : 'quiet';
}

/** Whether a task is in progress and its holder changed or commented on it within the hour. */
export function activeNow(task: Held, nowMs: number): boolean {
  return task.status === IN_PROGRESS && activityOf(task, nowMs) === 'active';
}

export type LiveGroups = Readonly<Record<Activity, readonly BoardTask[]>>;

/**
 * The tasks in progress by how recently their holders worked on them, each
 * group with the latest activity first and tasks with none recorded last.
 */
export function liveGroups(tasks: readonly BoardTask[], nowMs: number): LiveGroups {
  const groups: Record<Activity, BoardTask[]> = { active: [], quiet: [], stalled: [] };
  for (const task of tasks) {
    if (task.status !== IN_PROGRESS) continue;
    groups[activityOf(task, nowMs)].push(task);
  }
  const latest = (task: BoardTask) => ageMs(nowMs, task.lastActivityAt) ?? Number.POSITIVE_INFINITY;
  for (const group of Object.values(groups)) {
    group.sort((a, b) => latest(a) - latest(b) || a.id.localeCompare(b.id));
  }
  return groups;
}
