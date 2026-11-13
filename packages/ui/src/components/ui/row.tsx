import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import type { StatusTint } from '../../lib/symbols';
import { cn } from '../../lib/utils';

/**
 * A list row: one line, 36 px, divided by Border. Left to right: priority
 * mark, task id, status mark, title, its facts (labels, checks, comments,
 * what it waits on), then at the end the actions, the assignee and the age.
 * On a phone the id and the facts drop out; a row that answers in place
 * wraps its answer onto a second line.
 */
export function Row({
  className,
  answer = false,
  tint,
  ...props
}: ComponentProps<'div'> & {
  /**
   * It holds an answer (`RowAnswer`): on a phone the row wraps and the answer
   * takes its own line. A `wide` answer, a decision's options side by side or
   * an approval's pull request beside its buttons, also takes its own line,
   * under the title, below 1240 px wide.
   */
  answer?: boolean | 'wide';
  tint?: StatusTint;
}) {
  return (
    <div
      data-answer={answer === 'wide' ? 'wide' : undefined}
      data-status-tint={tint}
      className={cn(
        'group/row relative flex h-9 items-center gap-2.5 border-b border-border ps-5.5 pe-5 text-sm',
        'transition-colors duration-120 hover:bg-hover focus-within:bg-hover',
        'max-sm:gap-2.25 max-sm:px-4 max-sm:hover:bg-transparent',
        tint && 'bg-status-tint',
        answer &&
          'max-sm:h-auto max-sm:flex-wrap max-sm:items-start max-sm:gap-y-2 max-sm:pt-2.5 max-sm:pb-3 max-sm:[&>svg]:mt-0.75 max-sm:[&>[data-priority-mark]]:mt-0.5',
        answer === 'wide' &&
          'sm:max-[1240px]:h-auto sm:max-[1240px]:flex-wrap sm:max-[1240px]:gap-y-1.5 sm:max-[1240px]:py-2',
        className,
      )}
      {...props}
    />
  );
}

/** The task id, in a fixed 84 px column so titles line up. */
export function RowId({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn('nums w-21 shrink-0 whitespace-nowrap text-meta text-ink-3 max-sm:hidden', className)}
      {...props}
    />
  );
}

/** The title: 14 px medium, cut with an ellipsis rather than wrapped, except on a phone in a row that answers. */
export function RowTitle({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'min-w-0 truncate font-medium text-ink',
        'group-has-[[data-row-answer]]/row:max-sm:flex-1 group-has-[[data-row-answer]]/row:max-sm:whitespace-normal',
        className,
      )}
      {...props}
    />
  );
}

/** A fact after the title, in Text 3 with its 14 px icon: `1/3`, a comment count, `Waits on web-k3m9.2`. */
export function RowMeta({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'nums inline-flex shrink-0 items-center gap-1.25 whitespace-nowrap text-meta text-ink-3 max-sm:hidden [&_svg]:size-3.5',
        className,
      )}
      {...props}
    />
  );
}

/** Takes the free width between the title and the end of the row. */
export function RowSpacer({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('min-w-3 flex-1 group-has-[[data-row-answer]]/row:max-sm:hidden', className)} />
  );
}

/** The row's own actions (Claim, its menu). They show while the row is hovered or holds focus, never on a phone. */
export function RowActions({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        // A menu opened from here keeps its actions shown, so the menu stays anchored once focus moves into it.
        'ms-2 hidden items-center gap-1 group-hover/row:inline-flex group-focus-within/row:inline-flex has-[[aria-expanded=true]]:inline-flex max-sm:hidden!',
        className,
      )}
      {...props}
    />
  );
}

/** How long since the task changed: `40m`, `9h`, `12d`, right-aligned in a fixed column. */
export function RowAge({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('nums w-8.5 shrink-0 text-right text-meta text-ink-3', className)} {...props} />;
}

/** The answer a waiting row offers in place: Approve, the options, or Answer. On a line of its own it wraps. */
export function RowAnswer({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-row-answer=""
      className={cn(
        'flex items-center gap-1.5 max-sm:order-last max-sm:basis-full max-sm:flex-wrap max-sm:gap-y-2 max-sm:ps-13.75',
        // Under the title: past the priority tag, the id and the status mark.
        'group-data-[answer=wide]/row:sm:max-[1240px]:order-last group-data-[answer=wide]/row:sm:max-[1240px]:basis-full group-data-[answer=wide]/row:sm:max-[1240px]:flex-wrap group-data-[answer=wide]/row:sm:max-[1240px]:gap-y-2 group-data-[answer=wide]/row:sm:max-[1240px]:ps-[150px]',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A group's heading in a list: its status mark, its name and its count, on
 * Surface. The Waiting for you group is drawn in amber. A group that folds
 * starts with a chevron and is a button.
 */
export function GroupHeader({
  mark,
  label,
  count,
  tone = 'default',
  open,
  onToggle,
  end,
  className,
}: {
  mark?: ReactNode;
  label: string;
  count?: number;
  tone?: 'default' | 'wait';
  /** Set for a group that folds: whether its rows show. */
  open?: boolean;
  onToggle?: () => void;
  /** What ends the heading, such as the Focus button. */
  end?: ReactNode;
  className?: string;
}) {
  const folds = open !== undefined;
  const Chevron = open ? ChevronDown : ChevronRight;
  const body = (
    <>
      {folds ? <Chevron aria-hidden size={14} strokeWidth={1.75} className="-me-0.5 shrink-0 text-ink-3" /> : null}
      {mark}
      <span>{label}</span>
      {count !== undefined ? (
        <span className={cn('nums font-medium', tone === 'wait' ? 'text-wait-text/80' : 'text-ink-3')}>{count}</span>
      ) : null}
    </>
  );
  return (
    <div
      className={cn(
        'flex h-9 items-center gap-2 border-b border-border ps-5.5 pe-5 text-label font-semibold max-sm:px-4',
        tone === 'wait' ? 'bg-wait-soft text-wait-text' : 'bg-surface text-ink',
        className,
      )}
      data-group-header={tone}
    >
      {folds ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="-ms-1 flex items-center gap-2 rounded-md px-1 focus-visible:outline-2 focus-visible:outline-accent"
        >
          {body}
        </button>
      ) : (
        body
      )}
      {end ? <span className="ms-auto flex items-center gap-2">{end}</span> : null}
    </div>
  );
}
