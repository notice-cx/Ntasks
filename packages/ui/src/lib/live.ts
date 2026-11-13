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
import { httpUrl } from './custom-fields';
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

/** The Live board's columns, in the order work moves through them. */
export const STAGES = ['progress', 'shipping', 'live'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Readonly<Record<Stage, string>> = Object.freeze({
  progress: 'In progress',
  shipping: 'Waiting to ship',
  live: 'Live',
});

export type LiveBoard = Readonly<Record<Stage, readonly BoardTask[]>>;

/** How far back the Live column reaches: the last 24 hours or the last 7 days. */
export const SHIPPED_WINDOWS = ['day', 'week'] as const;
export type ShippedWindow = (typeof SHIPPED_WINDOWS)[number];
const SHIPPED_WINDOW_MS: Readonly<Record<ShippedWindow, number>> = { day: 24 * 3_600_000, week: 7 * 24 * 3_600_000 };

/**
 * The holder's last activity while the task is in progress, including while
 * it waits for a pull request to merge, or the latest delivery time after it closes.
 */
export function stageTime(task: BoardTask): string | null {
  if (task.status === 'in_progress') return task.lastActivityAt ?? null;
  const delivery = task.delivery;
  if (!delivery) return null;
  return delivery.liveAt ?? delivery.mergedAt ?? delivery.builtAt;
}

/**
 * The Live board's columns. In progress uses the List view's activity order.
 * Waiting to ship holds tasks in progress whose work names a pull request,
 * built work waiting for a merge, and merged work waiting for a deploy.
 * Live holds work that reached its last stage within `shipped`. A decision
 * or approval ships nothing. The board read takes precedence over the
 * separate read of closed work still waiting to ship, which can lag behind.
 */
export function liveBoard(
  tasks: readonly BoardTask[],
  waits: { readonly merge: readonly BoardTask[]; readonly deploy: readonly BoardTask[] },
  deploys: (project: string) => boolean,
  nowMs: number,
  shipped: ShippedWindow = 'week',
): LiveBoard {
  const since = nowMs - SHIPPED_WINDOW_MS[shipped];
  const groups = liveGroups(tasks, nowMs);
  const columns: Record<Exclude<Stage, 'progress'>, BoardTask[]> = { shipping: [], live: [] };
  const placed = new Set<string>();
  const onBoard = new Set(tasks.map((task) => task.id));
  const waiting = [...waits.merge, ...waits.deploy].filter((task) => !onBoard.has(task.id));
  for (const task of [...tasks, ...waiting]) {
    if (placed.has(task.id) || task.issueType === 'decision' || task.issueType === 'gate') continue;
    if (task.status === 'in_progress' && httpUrl(task.work?.pr ?? '') !== null) {
      placed.add(task.id);
      columns.shipping.push(task);
      continue;
    }
    if (task.status !== 'closed') continue;
    const stage = task.delivery?.stage;
    const last = stage === 'live' || (stage === 'merged' && !deploys(task.project));
    if (!last && stage !== 'built' && stage !== 'merged') continue;
    placed.add(task.id);
    if (last && (Date.parse(stageTime(task) ?? '') || 0) < since) continue;
    columns[last ? 'live' : 'shipping'].push(task);
  }
  const at = (task: BoardTask) => Date.parse(stageTime(task) ?? '') || 0;
  for (const column of Object.values(columns)) {
    column.sort((a, b) => at(b) - at(a) || a.id.localeCompare(b.id));
  }
  const progress = [...groups.active, ...groups.quiet, ...groups.stalled].filter((task) => !placed.has(task.id));
  return { progress, ...columns };
}
