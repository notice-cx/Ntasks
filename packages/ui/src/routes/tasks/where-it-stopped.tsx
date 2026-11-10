import type { ReactNode } from 'react';
import { CirclePause } from 'lucide-react';
import { toast } from 'sonner';
import { sameActor } from '@ntasks/domain';
import type { LiveTask, TaskComment } from '../../api/types';
import { Button } from '../../components/ui/button';
import { useReleaseTask } from '../../hooks/useTasks';
import { httpUrl } from '../../lib/custom-fields';
import { ageMs, formatAge } from '../../lib/format';

/** One line of the block: its name, then what the holder left. */
function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-3">{label}</dt>
      <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

/**
 * A stalled task's "Where it stopped" block, under its title: who held it and
 * how long they have done nothing on it, what they left (the next step,
 * branch, pull request and their last comment), then Free it, which a person
 * presses to hand the task back on their own call. The comment the free adds
 * keeps the same lines, since the holder's work details go with the claim.
 * The free names the holder shown here, so it never frees a later claim.
 */
export function WhereItStopped({
  task,
  heldBy,
  holder,
  comments,
  project,
  nowMs,
  disabledReason,
}: {
  task: Pick<LiveTask, 'id' | 'lastActivityAt' | 'work'>;
  /** The holder as the task names it. */
  heldBy: string;
  /** The holder's name as the page shows it. */
  holder: string;
  comments: readonly TaskComment[];
  project: string;
  nowMs: number;
  /** Why this sign-in cannot free it, shown as the button's tip; null when it can. */
  disabledReason: string | null;
}) {
  const release = useReleaseTask();
  const age = ageMs(nowMs, task.lastActivityAt);
  const last = comments.findLast((comment) => sameActor(comment.author, heldBy));
  const pr = task.work?.pr ? httpUrl(task.work.pr) : null;
  return (
    <section
      aria-label="Where it stopped"
      data-task-stalled=""
      className="flex flex-col gap-3 rounded-xl bg-surface px-4 py-3.5 inset-ring inset-ring-border"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-label text-ink-2">
        <CirclePause aria-hidden size={16} className="text-ink-3" />
        <h2 className="m-0 text-sm font-semibold text-ink">Where it stopped</h2>
        <span>
          {holder} {age === null ? 'has recorded nothing here' : `has done nothing here for ${formatAge(age)}`}
        </span>
      </div>
      {task.work?.next || task.work?.branch || task.work?.pr || last ? (
        <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-label text-ink max-sm:grid-cols-1">
          {task.work?.next ? <Line label="Next step">{task.work.next}</Line> : null}
          {task.work?.branch ? (
            <Line label="Branch">
              <code className="font-mono text-meta">{task.work.branch}</code>
            </Line>
          ) : null}
          {task.work?.pr ? (
            <Line label="Pull request">
              {pr ? (
                <a href={pr} target="_blank" rel="noreferrer" className="text-accent-text no-underline hover:underline">
                  {pr}
                </a>
              ) : (
                task.work.pr
              )}
            </Line>
          ) : null}
          {last ? (
            <Line label="Last comment">
              <span className="line-clamp-2 text-ink-2">{last.text}</span>
            </Line>
          ) : null}
        </dl>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3">
        <Button
          variant="primary"
          disabled={disabledReason !== null || release.isPending}
          title={disabledReason ?? undefined}
          data-task-action="free"
          onClick={() =>
            release.mutate(
              { id: task.id, project, holder: heldBy },
              {
                onSuccess: () => toast.success(`Freed ${task.id}`),
                onError: (error) => toast.error(error.message),
              },
            )
          }
        >
          {release.isPending ? 'Freeing…' : 'Free it'}
        </Button>
        <span className="text-label text-ink-3">
          Back to Open, held by nobody. This block stays on the task as a comment.
        </span>
      </div>
    </section>
  );
}
