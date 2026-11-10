/**
 * An epic is a container with no work of its own (STATE-22,
 * spec/protocol.md): once every task under it is closed, the server closes
 * it in the same write, and reopens it when one of them is open again.
 */
import type { TaskResolution, TaskStatus, TaskType } from './task.ts';

/** The actor Ntasks records the changes it makes on its own under, such as an epic it closes. */
export const NTASKS_ACTOR = 'service:Ntasks';

/** The label that keeps a task as it is when its work ends: in progress after its pull request merges, or an epic open after its last task closes. */
export const KEEP_OPEN = 'keep-open';

/** The closes that leave nothing to do and nothing shipped. */
const NOTHING_NEEDED: readonly TaskResolution[] = ['wont-do', 'no-longer-needed'];

/** An epic's close when its tasks closed as these: no-longer-needed when each closed as wont-do or no-longer-needed, else done. */
export function epicResolution(children: readonly TaskResolution[]): TaskResolution {
  return children.length > 0 && children.every((resolution) => NOTHING_NEEDED.includes(resolution))
    ? 'no-longer-needed'
    : 'done';
}

/** A task under an epic, as a write leaves it. */
export interface EpicChild {
  readonly closed: boolean;
  readonly resolution: TaskResolution | null;
}

/** The epic's own fields that decide whether it closes or reopens on its own. */
export interface EpicFacts {
  readonly type: TaskType;
  readonly status: TaskStatus;
  readonly labels: readonly string[];
  readonly closedBy: string | null;
}

/**
 * What a write does to the task its children are under: closes it, with the
 * resolution its children give, when it is an open epic not labelled
 * keep-open with at least one task under it and every one closed; reopens it
 * when it is an epic Ntasks closed and one of them is open; else nothing.
 */
export function epicChange(
  epic: EpicFacts,
  children: readonly EpicChild[],
): { readonly close: TaskResolution } | 'reopen' | null {
  if (epic.type !== 'epic') return null;
  const open = children.some((child) => !child.closed);
  if (epic.status === 'closed') return epic.closedBy === NTASKS_ACTOR && open ? 'reopen' : null;
  if (children.length === 0 || open || epic.labels.includes(KEEP_OPEN)) return null;
  return { close: epicResolution(children.map((child) => child.resolution ?? 'done')) };
}

/** The reason an epic's own close records: what closed or moved last. */
export function epicCloseReason(childId: string, moved: boolean): string {
  return moved
    ? `Every task under this epic is closed now that ${childId}, the last one open, moved out of it.`
    : `Every task under this epic is closed; ${childId} closed last.`;
}

/** Whether Ntasks closed this task on its own, as it closes an epic whose last task closed. */
export function closedByNtasks(task: {
  readonly type: TaskType;
  readonly close: { readonly by: string | null } | null;
}) {
  return task.type === 'epic' && task.close?.by === NTASKS_ACTOR;
}
