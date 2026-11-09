/**
 * How recently the holder of each task in progress worked on it: the Live
 * page's groups and the sidebar's live dots. The signal is the task's last
 * activity, when its holder last changed or commented on it, which the server
 * sends with every task. Stalled is worked out here for the page and never
 * written to the task: its status stays In progress until someone releases it.
 */
import { ageMs } from './format';
import { IN_PROGRESS, type BoardTask } from './task-model';

export type Activity = 'active' | 'quiet' | 'stalled';

export const ACTIVITIES: readonly Activity[] = ['active', 'quiet', 'stalled'];

export const ACTIVITY_LABELS: Readonly<Record<Activity, string>> = Object.freeze({
  active: 'Active',
  quiet: 'Quiet',
  stalled: 'Stalled',
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A task whose holder wrote to it within this long is active. */
export const ACTIVE_WITHIN_MS = HOUR;

/** The choices of how long without activity makes a task stalled, each longer than an active hour. */
export const STALLED_AFTER = [
  { ms: 4 * HOUR, label: '4 hours' },
  { ms: DAY, label: '1 day' },
  { ms: 3 * DAY, label: '3 days' },
  { ms: 7 * DAY, label: '1 week' },
] as const;

export const DEFAULT_STALLED_AFTER_MS = DAY;

/**
 * How recently a task's holder worked on it: active within the hour, quiet
 * until `stalledAfterMs`, stalled from then on, and stalled when nothing is
 * recorded, as for a task imported with no history of its holder.
 */
export function activityOf(lastActivityAt: string | null | undefined, nowMs: number, stalledAfterMs: number): Activity {
  const age = ageMs(nowMs, lastActivityAt);
  if (age === null) return 'stalled';
  if (age < ACTIVE_WITHIN_MS) return 'active';
  return age < stalledAfterMs ? 'quiet' : 'stalled';
}

/** Whether a task is in progress and its holder changed or commented on it within the hour. */
export function activeNow(task: Pick<BoardTask, 'status' | 'lastActivityAt'>, nowMs: number): boolean {
  return task.status === IN_PROGRESS && activityOf(task.lastActivityAt, nowMs, DEFAULT_STALLED_AFTER_MS) === 'active';
}

export type LiveGroups = Readonly<Record<Activity, readonly BoardTask[]>>;

/**
 * The tasks in progress by how recently their holders worked on them, each
 * group with the latest activity first and tasks with none recorded last.
 */
export function liveGroups(tasks: readonly BoardTask[], nowMs: number, stalledAfterMs: number): LiveGroups {
  const groups: Record<Activity, BoardTask[]> = { active: [], quiet: [], stalled: [] };
  for (const task of tasks) {
    if (task.status !== IN_PROGRESS) continue;
    groups[activityOf(task.lastActivityAt, nowMs, stalledAfterMs)].push(task);
  }
  const latest = (task: BoardTask) => ageMs(nowMs, task.lastActivityAt) ?? Number.POSITIVE_INFINITY;
  for (const group of Object.values(groups)) {
    group.sort((a, b) => latest(a) - latest(b) || a.id.localeCompare(b.id));
  }
  return groups;
}

const STORAGE_KEY = 'ntasks.live.stalledAfter';

/** The stalled threshold chosen last in this browser, or the default when none is kept or storage is refused. */
export function storedStalledAfter(): number {
  try {
    const kept = Number(window.localStorage.getItem(STORAGE_KEY));
    return STALLED_AFTER.some((option) => option.ms === kept) ? kept : DEFAULT_STALLED_AFTER_MS;
  } catch {
    return DEFAULT_STALLED_AFTER_MS;
  }
}

export function storeStalledAfter(ms: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(ms));
  } catch {
    // Kept for this page only; the next load starts at the default.
  }
}
