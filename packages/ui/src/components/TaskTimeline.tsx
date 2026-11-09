import type { ReactNode } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { ageMs, formatAge } from '@/lib/format';

export interface TimelineEntry {
  id: string;
  /** Null for a moment nobody dated: it is listed last, with no age. */
  at: string | null;
  kind: 'filed' | 'claimed' | 'comment' | 'closed';
  /** Who did it, drawn as their avatar; null when the read does not say. */
  actor: { name: string; agent: boolean; model: string | null } | null;
  /** What stands in the avatar's place when nobody is named: a 16 px icon or mark. */
  icon?: ReactNode;
  label: ReactNode;
  body?: ReactNode;
}

/** The moments with a readable time, oldest first, then the ones without. */
export function timelineOrder(entries: readonly TimelineEntry[]): TimelineEntry[] {
  const time = (entry: TimelineEntry) => (entry.at === null ? Number.NaN : Date.parse(entry.at));
  const dated = entries.filter((entry) => Number.isFinite(time(entry)));
  return [...dated].sort((a, b) => time(a) - time(b)).concat(entries.filter((entry) => !dated.includes(entry)));
}

/**
 * One task's history, oldest first: each moment on a line with who did it
 * and how long ago, what they wrote under it, then the box for the next
 * comment.
 */
export function TaskTimeline({
  entries,
  nowMs,
  composer,
}: {
  entries: readonly TimelineEntry[];
  nowMs: number;
  composer: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1" data-task-timeline="">
      <ol className="m-0 flex list-none flex-col p-0" aria-label="Activity">
        {timelineOrder(entries).map((entry) => {
          const age = ageMs(nowMs, entry.at);
          return (
            <li key={entry.id} className="flex flex-col" data-timeline-entry={entry.kind}>
              <div className="flex min-h-8 items-center gap-2.5 text-[13.5px] text-ink-2">
                <span aria-hidden className="grid w-5 shrink-0 place-items-center text-ink-3 [&_svg]:size-3.5">
                  {entry.actor ? (
                    <Avatar name={entry.actor.name} agent={entry.actor.agent} model={entry.actor.model} decorative />
                  ) : (
                    entry.icon
                  )}
                </span>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere] [&_b]:font-medium [&_b]:text-ink">
                  {entry.label}
                </span>
                {age !== null ? (
                  <time className="nums shrink-0 text-meta text-ink-3" dateTime={entry.at ?? undefined}>
                    {formatAge(age)}
                  </time>
                ) : null}
              </div>
              {entry.body ? <div className="ms-7.5 pb-2">{entry.body}</div> : null}
            </li>
          );
        })}
      </ol>
      {composer}
    </div>
  );
}
