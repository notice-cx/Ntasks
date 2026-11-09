import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * A label on a row: a task label after a grey dot (`copy`), or a type after
 * its mark (Bug, Epic). 20 px tall, round, ringed in Border. It names a fact;
 * it is never a button.
 */
export function Badge({
  children,
  icon,
  dot = false,
  className,
}: {
  children: ReactNode;
  /** A type mark or another 12 px symbol before the words. */
  icon?: ReactNode;
  /** The grey dot a task label wears. */
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.25 whitespace-nowrap rounded-full px-1.75 text-chip font-medium text-ink-2 inset-ring inset-ring-border',
        className,
      )}
    >
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-ink-3" /> : null}
      {icon}
      {children}
    </span>
  );
}

/**
 * A count beside a label: Text 3, or, for the work waiting for you, Waiting
 * text on Waiting soft. Its number is its whole content.
 */
export function Count({
  value,
  tone = 'default',
  className,
}: {
  value: number;
  tone?: 'default' | 'wait';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'nums text-xs font-medium',
        tone === 'wait' ? 'rounded-full bg-wait-soft px-1.5 font-semibold leading-4.5 text-wait-text' : 'text-ink-3',
        className,
      )}
      data-count={tone}
    >
      {value}
    </span>
  );
}

/** The share done, 0 to 1, of `done` out of `total`; an empty total is none done. */
export function progressShare(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(Math.max(done / total, 0), 1);
}

/** The tasks a `ProgressBar` draws, by the mark each shows on the board. */
export interface ProgressParts {
  done: number;
  inProgress: number;
  waiting: number;
  blocked: number;
  open: number;
  parked: number;
}

/** The parts in the order the bar draws them, each in the colour of its board mark. */
const BAR_PARTS: readonly { key: keyof ProgressParts; className: string; words: string }[] = [
  { key: 'done', className: 'bg-done', words: 'done' },
  { key: 'inProgress', className: 'bg-accent', words: 'in progress' },
  { key: 'waiting', className: 'bg-wait', words: 'waiting for you' },
  { key: 'blocked', className: 'bg-block', words: 'blocked' },
  { key: 'open', className: 'bg-border-strong', words: 'open' },
  {
    key: 'parked',
    className: 'bg-[repeating-linear-gradient(90deg,var(--border-strong)_0_2px,transparent_2px_4px)]',
    words: 'parked',
  },
];

/**
 * An epic's tasks as one bar, a part per mark, each as wide as its share:
 * Done in green, In progress in Accent, Waiting for you in amber, Blocked in
 * red, Open in Border strong and Parked hatched. An epic with no tasks is an
 * empty ring.
 */
export function ProgressBar({ parts, className }: { parts: ProgressParts; className?: string }) {
  const shown = BAR_PARTS.filter((part) => parts[part.key] > 0);
  const total = BAR_PARTS.reduce((sum, part) => sum + parts[part.key], 0);
  const label =
    total === 0
      ? 'No tasks'
      : `${parts.done} of ${total} done${shown
          .filter((part) => part.key !== 'done')
          .map((part) => `, ${parts[part.key]} ${part.words}`)
          .join('')}`;
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        'flex h-1.5 w-20 shrink-0 gap-px overflow-hidden rounded-full',
        total === 0 ? 'inset-ring inset-ring-border-strong' : 'bg-border',
        className,
      )}
      data-progress-bar=""
    >
      {shown.map((part) => (
        <span
          key={part.key}
          className={cn('block min-w-0.5', part.className)}
          style={{ flex: `${parts[part.key]} 1 0` }}
        />
      ))}
    </span>
  );
}

/** An epic's or a checklist's progress: a 14 px ring that fills in Accent, then `1/4`. */
export function Progress({ done, total, className }: { done: number; total: number; className?: string }) {
  const share = progressShare(done, total);
  return (
    <span
      className={cn('nums inline-flex items-center gap-1.25 whitespace-nowrap text-meta text-ink-3', className)}
      role="img"
      aria-label={`${done} of ${total} done`}
    >
      <span
        aria-hidden
        className="size-3.5 shrink-0 rounded-full [mask:radial-gradient(circle,transparent_3.6px,#000_3.8px)]"
        style={
          {
            background: `conic-gradient(var(--accent) ${share * 100}%, var(--border-strong) 0)`,
          } as CSSProperties
        }
      />
      <span aria-hidden>
        {done}/{total}
      </span>
    </span>
  );
}
