/**
 * The activity STATE-20 gives a task in progress, written out once: the
 * checks judge a server's answers by it, and `../cases/activity.json` holds
 * it at a fixed clock, which a test of each implementation runs against its
 * own rule. Nothing here reaches a server.
 */
export const ACTIVITIES = ['active', 'quiet', 'stalled'] as const;
export type Activity = (typeof ACTIVITIES)[number];

/** How many tasks in progress are in each group of activity (STATE-21). */
export type ActivityCounts = Readonly<Record<Activity, number>>;

/** A task in progress whose holder changed or commented on it less than this long before the read is active. */
export const ACTIVE_WITHIN_MS = 60 * 60 * 1000;

/** What a task's activity is worked out from: its status and its holder's last activity. */
export interface ActivityInput {
  readonly status: string;
  readonly assignee?: string | null;
  readonly lastActivityAt?: string | null;
}

/** The time `value` names, or null when it names none, as a last activity that was never recorded. */
const timeOf = (value: string | null | undefined): number | null => {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? time : null;
};

/**
 * Whether STATE-16 marks `task` stalled at `readAt`, on a server that states
 * `periodMs` as its period: in progress and held, and its holder has no
 * activity for that long, or none recorded.
 */
export function stalledAt(task: ActivityInput, readAt: string, periodMs: number): boolean {
  if (task.status !== 'in_progress' || task.assignee === null || task.assignee === undefined) return false;
  const last = timeOf(task.lastActivityAt);
  return last === null || Date.parse(readAt) - last >= periodMs;
}

/**
 * The activity STATE-20 gives `task` at `readAt`, the time of the read,
 * where `stalled` is whether STATE-16 marks it stalled then; null for a task
 * that is not in progress.
 */
export function activityAt(task: ActivityInput, readAt: string, stalled: boolean): Activity | null {
  if (task.status !== 'in_progress') return null;
  if (stalled) return 'stalled';
  const last = timeOf(task.lastActivityAt);
  return last !== null && Date.parse(readAt) - last < ACTIVE_WITHIN_MS ? 'active' : 'quiet';
}
