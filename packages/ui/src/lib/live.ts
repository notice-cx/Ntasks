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

/** The Live board's columns, in the order work moves through them. */
export const STAGES = ['progress', 'built', 'merged', 'live'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Readonly<Record<Stage, string>> = Object.freeze({
  progress: 'In progress',
  built: 'Built',
  merged: 'Merged',
  live: 'Live',
});

export type LiveBoard = Readonly<Record<Stage, readonly BoardTask[]>>;

/**
 * When a task reached its column: its holder's last activity while it is in
 * progress, else the time its change reached the stage it is at.
 */
export function stageTime(task: BoardTask, stage: Stage): string | null {
  if (stage === 'progress') return task.lastActivityAt ?? null;
  const delivery = task.delivery;
  if (!delivery) return null;
  if (stage === 'built') return delivery.builtAt;
  return stage === 'merged' ? (delivery.mergedAt ?? delivery.builtAt) : (delivery.liveAt ?? delivery.mergedAt);
}

/**
 * The Live board's columns. In progress holds every task in progress in the
 * Live list's order: Active, then Quiet, then Stalled, so the stalled ones
 * are the first a short column leaves out. The others hold closed tasks by
 * where their change is, the latest first: every task still waiting for a
 * merge or a deploy (`waits`, whenever it closed), and the board's own
 * closes, which reach back 7 days, for merged work of a project that does not
 * deploy and for work that went live. A task the board read holds is placed
 * by that read, never by a wait, which comes from a read of its own that can
 * lag behind or fail: a task reopened, or moved on, sits where the board
 * read puts it. A decision or an approval ships nothing.
 */
export function liveBoard(
  tasks: readonly BoardTask[],
  waits: { readonly merge: readonly BoardTask[]; readonly deploy: readonly BoardTask[] },
  nowMs: number,
): LiveBoard {
  const groups = liveGroups(tasks, nowMs);
  const columns: Record<Exclude<Stage, 'progress'>, BoardTask[]> = { built: [], merged: [], live: [] };
  const placed = new Set<string>();
  const onBoard = new Set(tasks.map((task) => task.id));
  const closes = tasks.filter((task) => task.status === 'closed');
  const waiting = [...waits.merge, ...waits.deploy].filter((task) => !onBoard.has(task.id));
  for (const task of [...closes, ...waiting]) {
    if (placed.has(task.id) || task.issueType === 'decision' || task.issueType === 'gate') continue;
    const stage = task.delivery?.stage;
    if (stage !== 'built' && stage !== 'merged' && stage !== 'live') continue;
    placed.add(task.id);
    columns[stage].push(task);
  }
  for (const [stage, column] of Object.entries(columns) as [Exclude<Stage, 'progress'>, BoardTask[]][]) {
    const at = (task: BoardTask) => Date.parse(stageTime(task, stage) ?? '') || 0;
    column.sort((a, b) => at(b) - at(a) || a.id.localeCompare(b.id));
  }
  return { progress: [...groups.active, ...groups.quiet, ...groups.stalled], ...columns };
}
