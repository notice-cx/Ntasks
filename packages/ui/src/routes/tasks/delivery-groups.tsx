/**
 * The closed tasks whose change waits on a person, which the Waiting for you
 * view lists after the decisions: built work waiting for its merge, and
 * merged work waiting for a deploy in a project whose changes go live by one.
 */
import { GitMerge, GitPullRequest } from 'lucide-react';
import type { ReactNode } from 'react';
import { GroupHeader } from '@/components/ui/row';
import type { Board } from '@/hooks/useBoard';
import { useDeliveryBoards } from '@/hooks/useTasks';
import { keptByFilters, type BoardFilters } from '@/lib/board-read';
import { boardOrder, boardRows, deliveryWait, type BoardTask, type DeliveryWait } from '@/lib/task-model';
import { TaskRow, type RowContext } from './task-row';

export const DELIVERY_GROUPS: readonly {
  readonly wait: DeliveryWait;
  readonly label: string;
  readonly icon: ReactNode;
}[] = [
  { wait: 'merge', label: 'Waiting for merge', icon: <GitPullRequest aria-hidden size={14} /> },
  { wait: 'deploy', label: 'Waiting for deploy', icon: <GitMerge aria-hidden size={14} /> },
];

/** The projects in view's work waiting for a merge or a deploy, read while `enabled`, with the board's filters applied. */
export function useDeliveryWaits(
  board: Board,
  filters: BoardFilters,
  enabled: boolean,
): Record<DeliveryWait, BoardTask[]> {
  const keys = board.projects.map((project) => project.key);
  const reads = useDeliveryBoards(keys, enabled);
  const deploys = new Map((board.catalog.data ?? []).map((project) => [project.logicalKey, project.deploys === true]));
  const waits: Record<DeliveryWait, BoardTask[]> = { merge: [], deploy: [] };
  if (!enabled) return waits;
  reads.forEach((read, index) => {
    const key = keys[index];
    if (key === undefined || read.data === undefined) return;
    for (const task of boardRows(key, read.data.tasks, read.data.actors)) {
      const wait = deliveryWait(task, deploys.get(key) ?? false);
      if (wait !== null && keptByFilters(task, filters, 'closed')) waits[wait].push(task);
    }
  });
  waits.merge.sort(boardOrder);
  waits.deploy.sort(boardOrder);
  return waits;
}

/** One group of work waiting for a merge or a deploy: its heading and its rows. */
export function DeliveryGroup({
  wait,
  rows,
  count,
  contextOf,
  more,
}: {
  wait: DeliveryWait;
  rows: readonly BoardTask[];
  /** How many wait, which can be more than the rows shown. */
  count: number;
  contextOf: (task: BoardTask) => RowContext;
  more?: ReactNode;
}) {
  const group = DELIVERY_GROUPS.find((candidate) => candidate.wait === wait)!;
  return (
    <section aria-label={group.label} data-group={`delivery-${wait}`}>
      <GroupHeader mark={<span className="grid text-ink-3">{group.icon}</span>} label={group.label} count={count} />
      {rows.map((task) => (
        <TaskRow key={task.id} task={task} context={contextOf(task)} />
      ))}
      {more}
    </section>
  );
}
