import { Children, Fragment, type ReactNode } from 'react';
import { Check, ChevronRight, CircleCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { TaskResolution } from '@ntasks/domain';
import type { TaskChoice, TaskChoices } from '@/api/types';
import { ChoiceButtons } from '@/components/ChoiceButtons';
import { RESOLUTION_GLYPH } from '@/components/CloseResolution';
import { StateChip } from '@/components/surface';
import { Card } from '@/components/ui/card';
import { eyebrowClass, pillControlClass } from '@/components/ui/chrome';
import { ageMs, formatAge } from '@/lib/format';
import { choiceName, RESOLUTION_LABELS, type InboxAsk } from '@/lib/task-model';
import { cn } from '@/lib/utils';
import { askGlyph, PriorityChip, TaskStatusChip, TypeMark, typeFace } from './task-face';

/** What a task page's header states. */
export interface TaskHeadFacts {
  title: string;
  issueType: string;
  awaitType: string | null;
  status: string;
  priority: number;
  /** Who holds it, the model they named when they claimed it, and when. */
  holder: { name: string; model: string | null; since: string | null } | null;
  ask: InboxAsk | null;
  /** An epic's closed children of all its children. */
  progress: { closed: number; total: number } | null;
}

export interface Crumb {
  label: string;
  to: string;
}

const ASK_LINE: Readonly<Record<InboxAsk, string>> = {
  approve: 'Needs your approval',
  answer: 'Needs your answer',
  choose: 'Needs your choice',
};

/**
 * The top of a task's page, read in one look: where the task sits, what kind
 * of task it is and its id, the title, then its state, priority, holder and
 * what it asks of you, with the actions beside it, the primary one first.
 * `children` sits under it: a closed task's reason, or the form an action opened.
 */
export function TaskHead({
  id,
  facts,
  crumbs,
  actions,
  nowMs,
  children,
}: {
  id: string;
  facts: TaskHeadFacts | null;
  crumbs: readonly Crumb[];
  actions?: ReactNode;
  nowMs: number;
  children?: ReactNode;
}) {
  const face = facts ? typeFace(facts.issueType, facts.awaitType, facts.status) : null;
  const holderAge = facts?.holder ? ageMs(nowMs, facts.holder.since) : null;
  return (
    <Card
      kind={face?.surface ?? 'neutral'}
      data-task-band={facts?.issueType ?? ''}
      className="viz-arrive rounded-xl px-4 py-4 md:px-5"
    >
      <nav
        aria-label="Where this task sits"
        className="mb-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
      >
        {crumbs.map((crumb, index) => (
          <Fragment key={crumb.to}>
            {index > 0 ? <ChevronRight aria-hidden className="size-3.5" /> : null}
            <Link
              to={crumb.to}
              className={cn(
                'underline-offset-4 hover:text-foreground hover:underline',
                pillControlClass,
                'max-sm:inline-flex max-sm:items-center',
              )}
            >
              {crumb.label}
            </Link>
          </Fragment>
        ))}
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className={eyebrowClass} data-task-type={facts?.issueType ?? ''}>
              {face?.word ?? 'Task'}
            </span>
            {/* The id is what people quote in a commit and type into a command, so it stays whole and in its own case. */}
            <span className="font-mono text-xs text-muted-foreground">{id}</span>
          </div>
          <h1 className="m-0 flex min-w-0 items-center gap-3 font-semibold text-foreground">
            {facts ? <TypeMark issueType={facts.issueType} awaitType={facts.awaitType} status={facts.status} /> : null}
            <span className="min-w-0 text-2xl leading-tight [overflow-wrap:anywhere] max-sm:text-xl">
              {facts?.title ?? 'Task'}
            </span>
          </h1>
          {facts ? (
            <div className="flex flex-wrap items-center gap-2" data-task-chips="">
              <TaskStatusChip status={facts.status} />
              <PriorityChip priority={facts.priority} />
              {facts.ask ? (
                <StateChip
                  tone="caution"
                  glyph={<span className="text-micro font-bold leading-none">{askGlyph(facts)}</span>}
                  label={<span data-task-ask={facts.ask}>{ASK_LINE[facts.ask]}</span>}
                />
              ) : null}
              {facts.holder ? (
                // Its parts wrap as wholes, so a name or a model is never broken inside itself.
                <span
                  className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 rounded-xl border border-border bg-card/70 px-2.5 py-0.5 text-xs text-muted-foreground"
                  data-task-holder=""
                >
                  {/* A claim still being worked carries the slow ring of something still under way. */}
                  <span
                    aria-hidden
                    className={cn(
                      'size-1.5 rounded-full bg-foreground',
                      facts.status === 'in_progress' && 'viz-breathe',
                    )}
                  />
                  <span className="whitespace-nowrap font-medium text-foreground">{facts.holder.name}</span>
                  {facts.holder.model ? <span className="whitespace-nowrap">· {facts.holder.model}</span> : null}
                  {holderAge !== null ? (
                    <time className="whitespace-nowrap tabular-nums" dateTime={facts.holder.since ?? undefined}>
                      · claimed {formatAge(holderAge)} ago
                    </time>
                  ) : null}
                </span>
              ) : null}
              {facts.progress ? <EpicProgress closed={facts.progress.closed} total={facts.progress.total} /> : null}
            </div>
          ) : null}
        </div>
        {actions}
      </div>
      {Children.toArray(children).length > 0 ? (
        <div className="mt-3 flex flex-col gap-3 border-t border-border/70 pt-3">{children}</div>
      ) : null}
    </Card>
  );
}

/** An epic's tasks as one segment each, filled as they close, with the count beside them. */
export function EpicProgress({ closed, total }: { closed: number; total: number }) {
  const shown = Math.min(total, 24);
  const filled = total === 0 ? 0 : Math.round((closed / total) * shown);
  return (
    <span
      className="inline-flex items-center gap-2 text-xs text-muted-foreground"
      data-epic-progress={`${closed}/${total}`}
    >
      <span aria-hidden className="flex gap-0.5">
        {Array.from({ length: shown }, (_, index) => (
          <span
            key={index}
            className={cn('h-2 w-2.5 rounded-[2px]', index < filled ? 'bg-foreground/80' : 'bg-viz-track')}
          />
        ))}
      </span>
      <span className="tabular-nums">
        {closed} of {total} closed
      </span>
    </span>
  );
}

/**
 * A closed task's evidence, under its header: who closed it, when, and the
 * reason. Neutral ink: closing records what shipped, not a measured outcome.
 * A close where nothing shipped leads with its resolution.
 */
export function ClosedSummary({
  by,
  at,
  nowMs,
  resolution,
  duplicate,
  children,
}: {
  by: string | null;
  at: string | null;
  nowMs: number;
  resolution: TaskResolution;
  duplicate?: ReactNode;
  children?: ReactNode;
}) {
  const age = ageMs(nowMs, at);
  const Glyph = resolution === 'done' ? Check : RESOLUTION_GLYPH[resolution];
  const heading = resolution === 'done' ? 'Close reason' : `Closed as ${RESOLUTION_LABELS[resolution]}`;
  return (
    <section
      aria-label={heading}
      data-task-closed=""
      data-task-resolution={resolution}
      className="flex flex-col gap-1.5"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Glyph className="size-3.5 shrink-0" aria-hidden />
        {resolution === 'done' ? (
          <h2 className={cn('m-0', eyebrowClass)}>Close reason</h2>
        ) : (
          <h2 className="m-0 text-sm font-medium text-foreground">
            {heading}
            {duplicate ? <> of {duplicate}</> : null}
          </h2>
        )}
        {by ? <span className="font-medium text-foreground">{by}</span> : null}
        {age !== null ? (
          <time className="tabular-nums" dateTime={at ?? undefined}>
            {formatAge(age)} ago
          </time>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** A person's pick, under the header once it is recorded: what was chosen, by whom and when, their note, then the options as a record. */
export function ChoiceSummary({
  choice,
  choices,
  by,
  nowMs,
}: {
  choice: TaskChoice;
  choices: TaskChoices | null;
  by: string;
  nowMs: number;
}) {
  const age = ageMs(nowMs, choice.at);
  return (
    <section aria-label="Choice" data-task-choice={choice.option} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <CircleCheck className="size-3.5 shrink-0" aria-hidden />
        <h2 className="m-0 text-sm font-medium text-foreground">Chose {choiceName(choice.option, choice.label)}</h2>
        <span className="font-medium text-foreground">{by}</span>
        {age !== null ? (
          <time className="tabular-nums" dateTime={choice.at}>
            {formatAge(age)} ago
          </time>
        ) : null}
      </div>
      {choice.note ? <p className="m-0 whitespace-pre-line text-sm">{choice.note}</p> : null}
      {choices ? <ChoiceButtons choices={choices} chosen={choice.option} /> : null}
    </section>
  );
}
