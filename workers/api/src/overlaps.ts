/**
 * Work in progress that changes the same files: when a task's holder records
 * what its work touches (TaskWork.touches), a claim or a comment answers the
 * other held tasks of its project whose touches meet it. It is advice, never
 * a refusal: the holders agree which pull request merges first, and record it
 * with a `merges-after` link.
 */
import { overlappingTouches, type Task } from '@ntasks/domain';
import type { Reader } from './lookup.ts';

/** Another held task whose work touches what this one's does. */
export interface Overlap {
  readonly id: string;
  readonly title: string;
  readonly assignee: string;
  readonly status: Task['status'];
  /** Its pull request, from its holder's work details. */
  readonly pr: string | null;
  /** Its entries that meet this task's. */
  readonly touches: readonly string[];
  /** `after` when this task merges after it, `before` when it merges after this task, null while no link says. */
  readonly mergeOrder: 'after' | 'before' | null;
}

/** The project's other tasks in progress or blocked, held by someone, whose touches meet `task`'s. */
export async function overlapsOf({ engine }: Reader, task: Task): Promise<readonly Overlap[]> {
  const mine = task.work.touches ?? [];
  if (mine.length === 0) return [];
  const held = await engine.listBoard(task.projectId, {
    statuses: ['in_progress', 'blocked'],
    withoutExternalLinks: true,
  });
  const ordered = (links: Task['dependencies'], id: string) =>
    links.some((link) => link.taskId === id && link.type === 'merges-after');
  return held.flatMap((other) => {
    if (other.id === task.id || other.assignee === null) return [];
    const touches = overlappingTouches(mine, other.work.touches ?? []);
    if (touches.length === 0) return [];
    return [
      {
        id: other.id,
        title: other.title,
        assignee: other.assignee,
        status: other.status,
        pr: other.work.pr ?? null,
        touches,
        mergeOrder: ordered(task.dependencies, other.id)
          ? 'after'
          : ordered(task.dependents, other.id)
            ? 'before'
            : null,
      },
    ];
  });
}
