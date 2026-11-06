import type { ComponentType, ReactNode } from 'react';
import { Check, CircleDot, MessageSquare, Plus } from 'lucide-react';
import { ageMs, formatAge } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface TimelineEntry {
  id: string;
  /** Null for a moment nobody dated: it is listed last and says so. */
  at: string | null;
  kind: 'filed' | 'claimed' | 'comment' | 'closed';
  label: ReactNode;
  body?: ReactNode;
  /** The glyph for a close where nothing shipped. */
  glyph?: ComponentType<{ className?: string }>;
}

const KIND_GLYPH: Record<TimelineEntry['kind'], ComponentType<{ className?: string }>> = {
  filed: Plus,
  claimed: CircleDot,
  comment: MessageSquare,
  closed: Check,
};

/**
 * One task's history: its moments on a time axis that ends at now, then the
 * same moments in order with who did each and what they wrote, then the box
 * for the next comment.
 */
export function TaskTimeline({ entries, nowMs, composer }: { entries: readonly TimelineEntry[]; nowMs: number; composer: ReactNode }) {
  const dated = entries.filter((entry) => entry.at !== null && Number.isFinite(Date.parse(entry.at)));
  const ordered = [...dated].sort((a, b) => Date.parse(a.at ?? '') - Date.parse(b.at ?? '')).concat(entries.filter((entry) => !dated.includes(entry)));
  const first = dated.length > 0 ? Math.min(...dated.map((entry) => Date.parse(entry.at ?? ''))) : null;
  const span = first === null ? 0 : Math.max(1, nowMs - first);
  return (
    <div className="flex flex-col gap-4" data-task-timeline="">
      {first !== null ? (
        <div aria-hidden className="flex flex-col gap-1">
          <div className="relative h-4">
            <div className="absolute inset-x-0 top-1/2 h-px bg-viz-grid" />
            {dated.map((entry) => {
              const left = ((Date.parse(entry.at ?? '') - first) / span) * 100;
              return (
                <span
                  key={entry.id}
                  className={cn('absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full', entry.kind === 'comment' ? 'bg-muted-foreground' : 'bg-foreground')}
                  style={{ left: `${Math.min(100, Math.max(0, left))}%` }}
                />
              );
            })}
            <span className="absolute end-0 top-1/2 size-2.5 -translate-y-1/2 rounded-full border-2 border-primary bg-card" />
          </div>
          <div className="flex justify-between text-micro tabular-nums text-muted-foreground">
            <span>{formatAge(ageMs(nowMs, new Date(first).toISOString()))} ago</span>
            <span>now</span>
          </div>
        </div>
      ) : null}
      <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label="What happened to this task">
        {ordered.map((entry) => {
          const Glyph = entry.glyph ?? KIND_GLYPH[entry.kind];
          const age = ageMs(nowMs, entry.at);
          return (
            <li key={entry.id} className="flex gap-3" data-timeline-entry={entry.kind}>
              <span aria-hidden className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-border bg-card text-muted-foreground">
                <Glyph className="size-3.5" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="text-foreground">{entry.label}</span>
                  <time className="text-xs tabular-nums text-muted-foreground" dateTime={entry.at ?? undefined}>
                    {age === null ? 'time not recorded' : `${formatAge(age)} ago`}
                  </time>
                </div>
                {entry.body}
              </div>
            </li>
          );
        })}
      </ol>
      {composer}
    </div>
  );
}
