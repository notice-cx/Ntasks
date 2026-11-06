import { Fragment, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { SectionLabel } from '@/components/surface';
import { Button } from '@/components/ui/button';
import { inlineLinkClass, pillControlClass } from '@/components/ui/chrome';
import { operationAvailable, useCapabilities, verbReason } from '@/hooks/useTasks';
import { ageMs, formatInt } from '@/lib/format';
import { askVerb, isGate, type BoardTask, type InboxAsk } from '@/lib/task-model';
import { taskPath } from '@/lib/task-path';
import { cn } from '@/lib/utils';
import { useAskActions } from './ask-actions';
import { askGlyph } from './task-face';

/** The list opens at five rows and shows the rest on a press; it never silently keeps five of nine. */
const ASK_ROWS = 5;
const DAY = 86_400_000;
const UNAVAILABLE = 'This sign-in cannot answer it.';

const ROW_ASKS: Readonly<Record<InboxAsk, string | null>> = {
  approve: 'needs your approval',
  answer: null,
  choose: 'needs your choice',
};

/**
 * Your decisions, as a queue: how many wait and how old the oldest is, then
 * each one with its age as a length and its verbs on the row.
 */
export function AskQueue({
  asks,
  projectNames,
  nowMs,
  showProject,
  writable,
}: {
  asks: readonly BoardTask[];
  projectNames: ReadonlyMap<string, string>;
  nowMs: number;
  showProject: boolean;
  /** The project's read answered, so its rows can be acted on. */
  writable: (task: BoardTask) => boolean;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? asks : asks.slice(0, ASK_ROWS);
  const oldest = asks.reduce<number | null>((most, task) => {
    const age = ageMs(nowMs, task.createdAt ?? task.updatedAt);
    return age === null ? most : Math.max(most ?? 0, age);
  }, null);
  return (
    <section
      className="flex flex-col rounded-[10px] border border-border bg-card"
      aria-labelledby="decisions-title"
      data-decision-queue=""
    >
      <SectionLabel
        id="decisions-title"
        title="Your decisions"
        caption={
          asks.length === 0
            ? undefined
            : `${formatInt(asks.length)} waiting${oldest === null ? '' : ` · oldest ${ageLabel(oldest / DAY)}`}`
        }
        className="px-4 pb-2 pt-3"
      />
      {asks.length === 0 ? (
        <p className="m-0 px-4 pb-4 text-xs text-muted-foreground">No decisions match these filters.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {shown.map((task) => (
            <AskRow
              key={task.id}
              task={task}
              project={projectNames.get(task.project) ?? task.project}
              nowMs={nowMs}
              showProject={showProject}
              writable={writable(task)}
            />
          ))}
        </ul>
      )}
      {asks.length > ASK_ROWS ? (
        <div className="border-t border-border/60 p-2">
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            aria-expanded={all}
            onClick={() => setAll((open) => !open)}
            data-decisions-more=""
          >
            {all ? 'Show fewer' : `Show ${formatInt(asks.length - ASK_ROWS)} more`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** One decision, answered on its row: the same verbs, options and answer box as the task's own page. */
function AskRow({
  task,
  project,
  nowMs,
  showProject,
  writable,
}: {
  task: BoardTask;
  project: string;
  nowMs: number;
  showProject: boolean;
  writable: boolean;
}) {
  const capabilities = useCapabilities();
  const [open, setOpen] = useState(false);
  const verb = askVerb(task);
  const { buttons, box } = useAskActions({
    ask: verb,
    id: task.id,
    title: task.title,
    project: task.project,
    placement: 'row',
    choices: task.choices ?? null,
    disabledReason: verbReason(
      capabilities,
      writable && operationAvailable(capabilities, isGate(task) ? 'resolve' : 'respond'),
      UNAVAILABLE,
    ),
    chooseDisabledReason: verbReason(capabilities, writable && operationAvailable(capabilities, 'choose'), UNAVAILABLE),
  });
  const evidence = [task.description, task.acceptance].some((value) => value.trim() !== '');
  const proceeds = task.proceeds ?? [];
  const age = ageMs(nowMs, task.createdAt ?? task.updatedAt);
  const caption = [showProject ? project : null, ROW_ASKS[verb]].filter(Boolean).join(' · ');

  return (
    <li className="group/ask border-b border-border/40 px-3 py-0.5 last:border-b-0" data-inbox-row={task.id}>
      {/* The verbs share the title's line while it keeps room for its words, and take a line of their own when it would not. */}
      <div className="flex flex-wrap items-start gap-x-2.5 gap-y-1.5 py-2">
        <span
          aria-hidden
          className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-[1.5px] border-current text-[11px] font-bold leading-none text-warn"
        >
          {askGlyph(task)}
        </span>
        <div className="flex min-w-[min(100%,14rem)] flex-1 basis-0 flex-col gap-0.5">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className={cn(
              'flex min-w-0 items-start gap-1.5 rounded-sm text-start text-sm font-medium text-foreground hover:underline',
              pillControlClass,
            )}
          >
            <span className="min-w-0 [overflow-wrap:anywhere]">{task.title}</span>
            <ChevronDown
              aria-hidden
              className={cn(
                'mt-0.5 size-4 shrink-0 text-muted-foreground motion-safe:transition-transform',
                open && 'rotate-180',
              )}
            />
          </button>
          {caption ? <span className="text-xs text-muted-foreground">{caption}</span> : null}
        </div>
        <AskAge days={age === null ? null : age / DAY} />
        {buttons !== null ? (
          <span className="flex flex-wrap items-center gap-2 opacity-70 transition-opacity group-hover/ask:opacity-100 group-focus-within/ask:opacity-100 max-sm:basis-full max-sm:ps-7.5 max-sm:opacity-100">
            {buttons}
          </span>
        ) : null}
      </div>
      {open ? (
        <div className="flex flex-col gap-2 pb-2 pe-2 ps-9 text-xs text-muted-foreground" data-inbox-evidence="">
          {evidence ? (
            <>
              {task.description.trim() ? (
                <span className="whitespace-pre-line text-foreground">{task.description.trim()}</span>
              ) : null}
              {task.acceptance.trim() ? (
                <span className="whitespace-pre-line">
                  <span className="font-medium text-foreground">Done when </span>
                  {task.acceptance.trim()}
                </span>
              ) : null}
            </>
          ) : null}
          <Link to={taskPath(task.id)} className={cn(inlineLinkClass, 'w-fit font-medium')}>
            Open task →
          </Link>
        </div>
      ) : null}
      {box}
      <span className="block pb-2 pe-2 ps-9 text-xs text-muted-foreground" data-inbox-proceeds="">
        <span className="font-medium text-foreground">After your answer: </span>
        {proceeds.length > 0 ? (
          <>
            {proceeds.slice(0, 2).map((row, index) => (
              <Fragment key={row.id}>
                {index > 0 ? '; ' : null}
                <Link to={taskPath(row.id)} className={inlineLinkClass}>
                  {row.title}
                </Link>
              </Fragment>
            ))}
            {proceeds.length > 2 ? `; ${formatInt(proceeds.length - 2)} more` : ''} can start.
          </>
        ) : isGate(task) ? (
          'Only the stated action is approved.'
        ) : task.issueType === 'decision' ? (
          'The decision is recorded.'
        ) : (
          'An agent can continue this task.'
        )}
      </span>
    </li>
  );
}

/** An age in days as a short word: `6h`, `3d`, `5w`. */
export function ageLabel(days: number): string {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  if (days < 14) return `${Math.round(days)}d`;
  return `${Math.round(days / 7)}w`;
}

/** How long a decision has waited, as a length and a figure; a month or more wears warn. */
function AskAge({ days }: { days: number | null }) {
  if (days === null) return <span className="text-xs text-muted-foreground">age unknown</span>;
  const old = days >= 30;
  // A log scale, so a day and a month both have a visible length.
  const length = Math.min(1, Math.log1p(days) / Math.log1p(60));
  return (
    <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-xs">
      <span aria-hidden className="h-1 w-12 overflow-hidden rounded-full bg-viz-track max-sm:hidden">
        <span
          className={cn('block h-full rounded-full', old ? 'bg-warn' : 'bg-muted-foreground/60')}
          style={{ width: `${length * 100}%` }}
        />
      </span>
      <span className={cn('w-8 text-end tabular-nums', old ? 'font-semibold text-warn' : 'text-muted-foreground')}>
        <span className="sr-only">waiting </span>
        {ageLabel(days)}
      </span>
    </span>
  );
}
