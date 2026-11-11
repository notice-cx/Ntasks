/**
 * The tasks a task relies on that were dropped after it last changed: closed
 * as won't do or no longer needed. Whoever picks the task up checks that its
 * premise still holds; any change to the task clears the list (the Worker's
 * `reliesOnDropped`).
 */
import { CircleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { DroppedTask } from '../../api/types';
import { usePaths } from '../../lib/paths';
import { RESOLUTION_LABELS } from '../../lib/task-model';

/** How a dropped task ended, as a sentence continues it: "won't do", "no longer needed". */
function endedAs(task: DroppedTask): string {
  return RESOLUTION_LABELS[task.resolution].toLowerCase();
}

/** A task page's line for each dropped task it relies on, each linked to its page; nothing when there is none. */
export function ReliesOnDropped({ dropped }: { dropped: readonly DroppedTask[] }) {
  const paths = usePaths();
  if (dropped.length === 0) return null;
  return (
    <section
      aria-label="Dropped tasks this relies on"
      data-task-dropped=""
      className="flex flex-col gap-1.5 rounded-xl bg-surface px-4 py-3.5 text-label text-ink-2 inset-ring inset-ring-border"
    >
      {dropped.map((task) => (
        <p key={task.id} className="m-0 flex items-start gap-2.5">
          <CircleAlert aria-hidden size={16} className="mt-0.5 shrink-0 text-ink-3" />
          <span>
            Check:{' '}
            <Link to={paths.task(task.id)} className="text-accent-text no-underline hover:underline">
              {task.title}
            </Link>
            , which this relies on, closed as {endedAs(task)}
          </span>
        </p>
      ))}
    </section>
  );
}

/** A board row's fact: the ids of the dropped tasks it relies on, each linked to its page. */
export function DroppedFact({ dropped }: { dropped: readonly DroppedTask[] }) {
  const paths = usePaths();
  return (
    <>
      <CircleAlert aria-hidden />
      Relies on dropped{' '}
      {dropped.map((task, index) => (
        <span key={task.id}>
          {index > 0 ? ', ' : null}
          <Link
            to={paths.task(task.id)}
            title={`${task.title}, closed as ${endedAs(task)}`}
            className="text-ink-2 no-underline hover:underline"
          >
            {task.id}
          </Link>
        </span>
      ))}
    </>
  );
}
