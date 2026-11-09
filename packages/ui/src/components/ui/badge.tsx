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
