/**
 * The page furniture every screen shares: a screen's one answer, a section's
 * eyebrow, a state chip, the line that ends a list, and the designed empty,
 * failed and loading states.
 */
import type { ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { eyebrowClass } from '@/components/ui/chrome';
import { cn } from '@/lib/utils';

/** A state's meaning, mapped to the palette. Colour is never the only signal: a glyph or a word rides beside it. */
export type StateTone = 'affirmative' | 'caution' | 'critical' | 'declined' | 'na' | 'neutral';

export const STATE_TONE: Record<StateTone, { chip: string; text: string }> = {
  affirmative: { chip: 'border-border bg-muted/50 text-foreground', text: 'text-foreground' },
  caution: { chip: 'border-warn/30 bg-warn-soft text-warn', text: 'text-warn' },
  critical: { chip: 'border-error/30 bg-error-soft text-error', text: 'text-error' },
  declined: { chip: 'border-info/40 bg-info/10 text-info', text: 'text-info' },
  na: { chip: 'border-border bg-muted text-muted-foreground', text: 'text-muted-foreground' },
  neutral: { chip: 'border-border text-foreground', text: 'text-foreground' },
};

/** A state as a pill: its glyph and its word, in its tone. */
export function StateChip({
  label,
  tone,
  glyph,
  className,
}: {
  label: ReactNode;
  tone: StateTone;
  glyph: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium',
        STATE_TONE[tone].chip,
        className,
      )}
    >
      <span aria-hidden className="inline-flex shrink-0 items-center">
        {glyph}
      </span>
      {label}
    </span>
  );
}

/** A section's eyebrow, a quiet caption, and whatever belongs at the row's end. */
export function SectionLabel({
  title,
  caption,
  id,
  children,
  className,
}: {
  title: string;
  caption?: ReactNode;
  id?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-baseline gap-x-2.5 gap-y-1', className)}>
      <h2 id={id} className={cn('m-0', eyebrowClass)}>
        {title}
      </h2>
      {caption ? <span className="min-w-0 text-xs tabular-nums text-muted-foreground">{caption}</span> : null}
      {children ? <span className="ms-auto flex items-center gap-2">{children}</span> : null}
    </div>
  );
}

export interface AnswerFigure {
  label: string;
  value: string;
  /** A `data-*` hook for tests. */
  mark?: string;
}

/** A screen's one answer, first: one sentence, a muted line under it, and at most three figures beside it. */
export function PageAnswer({
  answer,
  detail,
  figures = [],
  marks,
}: {
  answer: ReactNode;
  detail?: ReactNode;
  figures?: readonly AnswerFigure[];
  marks?: Record<`data-${string}`, string>;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3" data-page-answer="" {...marks}>
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="m-0 text-[26px] font-bold leading-[1.1] tracking-[-0.03em] text-foreground [overflow-wrap:anywhere] max-sm:text-[22px]">
          {answer}
        </h1>
        {detail ? (
          <span className="text-[13px] tabular-nums text-muted-foreground" data-page-answer-detail="">
            {detail}
          </span>
        ) : null}
      </div>
      {figures.length > 0 ? (
        <dl className="m-0 flex flex-wrap gap-x-6 gap-y-2 tabular-nums">
          {figures.slice(0, 3).map((figure) => (
            <div
              key={figure.label}
              className="flex flex-col gap-0.5"
              {...(figure.mark ? { [`data-${figure.mark}`]: '' } : {})}
            >
              <dt className={eyebrowClass}>{figure.label}</dt>
              <dd className="m-0 text-figure-sm text-foreground">{figure.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/** The end of a list the eye can finish: one line that says it is done, then how old the reading is. */
export function FinishLine({ line, age, className }: { line: string; age?: string | null; className?: string }) {
  return (
    <Card
      kind="neutral"
      data-finish-line=""
      className={cn(
        'flex min-h-14 flex-col items-center justify-center gap-1 border-dashed p-3 text-center',
        className,
      )}
    >
      <span className="text-sm font-medium text-foreground">{line}</span>
      {age ? <span className="text-xs tabular-nums text-muted-foreground">{age}</span> : null}
    </Card>
  );
}

/** A designed empty state: what is empty, and the next step when there is one. */
export function EmptyState({ title, hint, className }: { title: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-start justify-center gap-1 py-2', className)} data-empty-state="">
      <span className="text-base font-medium text-foreground">{title}</span>
      {hint ? <span className="text-sm text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/** A read that failed: what could not be read, the server's words, and Retry. */
export function ReadFailed({
  title,
  error,
  retrying,
  onRetry,
}: {
  title: string;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  const said = error instanceof Error && error.message !== '' ? error.message : null;
  return (
    <Card
      kind="alert"
      className="flex flex-wrap items-center justify-between gap-3 p-4"
      data-read-failed=""
      role="alert"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{title}</span>
        {said ? <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{said}</span> : null}
      </div>
      <Button type="button" variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
        <RotateCw aria-hidden className={cn(retrying && 'motion-safe:animate-spin')} />
        {retrying ? 'Retrying…' : 'Retry'}
      </Button>
    </Card>
  );
}

/** A screen still loading shows its shape, never a value. */
export function PageSkeleton({ shape }: { shape: 'list' | 'page' }) {
  const rows = shape === 'list' ? 6 : 3;
  return (
    <div className="flex flex-col gap-3" role="status" data-page-skeleton={shape}>
      <span className="sr-only">Loading…</span>
      <div aria-hidden className="skeleton-group flex flex-col gap-3">
        <div className="skeleton h-8 w-2/3 rounded-md" />
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="skeleton h-10 w-full rounded-md" />
        ))}
      </div>
    </div>
  );
}
