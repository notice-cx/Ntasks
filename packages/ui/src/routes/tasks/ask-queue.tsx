import { Target } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { Kbd } from '../../components/ui/kbd';
import { GroupHeader } from '../../components/ui/row';
import { StatusMark } from '../../components/ui/symbols';
import type { BoardTask } from '../../lib/task-model';
import { WaitingRow, type RowContext } from './task-row';
import { usePaths } from '../../lib/paths';

/**
 * The first group of the board: the tasks waiting for you, most urgent first,
 * each answered on its row. Its heading carries the way into Focus, where
 * they come one at a time.
 */
export function WaitingGroup({
  asks,
  count,
  contextOf,
  writable,
  more,
}: {
  asks: readonly BoardTask[];
  /** How many wait, which can be more than the rows shown. */
  count: number;
  contextOf: (task: BoardTask) => RowContext;
  /** The project's read answered, so its rows can be answered. */
  writable: (task: BoardTask) => boolean;
  /** What ends the group when it has more rows than it shows. */
  more?: ReactNode;
}) {
  const location = useLocation();
  const paths = usePaths();
  return (
    <section aria-label="Waiting for you" data-group="waiting">
      <GroupHeader
        mark={<StatusMark status="waiting" label={null} />}
        label="Waiting for you"
        count={count}
        tone="wait"
        end={
          <Button asChild variant="ghost" size="sm">
            <Link
              to={paths.focus}
              state={{ returnTo: `${location.pathname}${location.search}` }}
              aria-keyshortcuts="F"
              data-focus-link=""
            >
              <Target aria-hidden />
              Focus <Kbd className="max-sm:hidden">F</Kbd>
            </Link>
          </Button>
        }
      />
      {asks.map((task) => (
        <WaitingRow key={task.id} task={task} context={contextOf(task)} writable={writable(task)} />
      ))}
      {more}
    </section>
  );
}

/** An age in days as a short word: `6h`, `3d`, `5w`. */
export function ageLabel(days: number): string {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  if (days < 14) return `${Math.round(days)}d`;
  return `${Math.round(days / 7)}w`;
}
