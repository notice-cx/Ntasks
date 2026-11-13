import { ChevronRight } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { LiveEpic, LiveTask } from '../../api/types';
import { EpicBadge } from '../../components/EpicBadge';
import { ProgressBar, type ProgressParts } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { StatusMark } from '../../components/ui/symbols';
import { heldByApprovals } from '../../lib/board-read';
import { formatInt } from '../../lib/format';
import { usePaths } from '../../lib/paths';
import { STATUS_MARK_LABELS, statusMarkFor, type StatusMark as Mark } from '../../lib/symbols';
import { inboxAsk } from '../../lib/task-model';

const STATES = [
  ['done', 'done'],
  ['in-progress', 'inProgress'],
  ['waiting', 'waiting'],
  ['blocked', 'blocked'],
  ['open', 'open'],
  ['parked', 'parked'],
] as const satisfies readonly (readonly [Mark, keyof ProgressParts])[];

export function EpicTasks({
  id,
  epic,
  siblings,
}: {
  id: string;
  epic: LiveEpic | null;
  siblings: readonly LiveTask[];
}) {
  const heading = useId();
  const [show, setShow] = useState(8);
  const { tasks, parts } = useMemo(() => {
    const statuses = new Map(siblings.map((task) => [task.id, task.status]));
    const held = heldByApprovals(siblings.filter((task) => inboxAsk(task) !== null));
    const tasks = siblings
      .filter((task) => task.parent === id)
      .map((task) => ({ task, mark: statusMarkFor(task, statuses, held) }))
      .sort((a, b) => a.task.id.localeCompare(b.task.id, undefined, { numeric: true }));
    const parts: ProgressParts = { done: epic?.closed ?? 0, inProgress: 0, waiting: 0, blocked: 0, open: 0, parked: 0 };
    for (const [mark, part] of STATES) {
      if (mark !== 'done') parts[part] = tasks.filter((row) => row.mark === mark).length;
    }
    return { tasks, parts };
  }, [id, epic?.closed, siblings]);
  const paths = usePaths();
  const missingClosed = Math.max(0, (epic?.closed ?? 0) - tasks.filter(({ task }) => task.status === 'closed').length);

  return (
    <section aria-labelledby={heading} className="grid gap-3" data-epic-tasks="">
      <div className="flex items-baseline gap-2">
        <h2 id={heading} className="m-0 text-heading font-semibold text-ink">
          Tasks
        </h2>
        {epic ? <span className="nums text-meta text-ink-3">{formatInt(epic.total)}</span> : null}
      </div>
      {epic && epic.total > 0 ? (
        <div className="grid gap-2.5 rounded-xl border border-border bg-surface p-3.5 sm:p-4" data-epic-breakdown="">
          <p className="nums m-0 text-sm font-semibold text-ink">
            {formatInt(epic.closed)} of {formatInt(epic.total)} done
          </p>
          <ProgressBar parts={parts} className="h-2 w-full" />
          <ul className="m-0 flex list-none flex-wrap gap-x-3.5 gap-y-1.5 p-0 text-meta text-ink-2">
            {STATES.filter(([, part]) => parts[part] > 0).map(([mark, part]) => (
              <li key={mark} className="nums flex items-center gap-1.25">
                <StatusMark status={mark} label={null} size={13} />
                {formatInt(parts[part])} {STATUS_MARK_LABELS[mark].toLowerCase()}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {tasks.length > 0 ? (
        <ul className="m-0 list-none divide-y divide-border overflow-hidden rounded-xl border border-border p-0">
          {tasks.slice(0, show).map(({ task, mark }) => (
            <li key={task.id} data-linked-task={task.id}>
              <Link
                to={paths.task(task.id)}
                className="group grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 px-3 py-2 text-sm text-ink no-underline hover:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent sm:grid-cols-[auto_94px_minmax(0,1fr)_auto]"
              >
                <StatusMark status={mark} />
                <span className="nums truncate text-meta text-ink-3 max-sm:hidden">{task.id}</span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-1.75 gap-y-1">
                  {task.issueType === 'epic' ? <EpicBadge /> : null}
                  <span className="min-w-0 [overflow-wrap:anywhere]">{task.title}</span>
                </span>
                <ChevronRight aria-hidden size={14} className="text-ink-3 group-hover:text-ink" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-ink-3">
          {missingClosed > 0 ? 'No recent tasks to show' : 'No tasks in this epic'}
        </p>
      )}
      {tasks.length > show ? (
        <Button type="button" size="sm" className="justify-self-start" onClick={() => setShow((count) => count + 25)}>
          Show {formatInt(Math.min(25, tasks.length - show))} more
        </Button>
      ) : null}
      {missingClosed > 0 ? (
        <p className="m-0 text-meta text-ink-3">
          {formatInt(missingClosed)} {missingClosed === 1 ? 'task closed' : 'tasks closed'} before this week
        </p>
      ) : null}
    </section>
  );
}
