/**
 * The Epics view of a project's task page: each open epic on one line, in
 * groups by what it needs (Waiting for you, Moving, Not moving, Every task
 * done, No tasks), with how many of its tasks wait for you or are blocked,
 * its progress bar, its tasks done of all, and what closed this week. The
 * Live page draws an epic's line from the same parts.
 */
import { ChevronDown, ChevronRight, Layers, Search } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ProgressBar, type ProgressParts } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { GroupHeader, Row, RowAge, RowId, RowMeta, RowSpacer, RowTitle } from '../../components/ui/row';
import { ActivityMark, PriorityMark, StatusMark } from '../../components/ui/symbols';
import {
  EPIC_STATE_LABELS,
  EPIC_STATES,
  epicOrder,
  openCount,
  type EpicsRead,
  type EpicState,
  type EpicSummary,
  type OpenTally,
} from '../../lib/epics';
import { calendarDay, dayIn, useTimeZone } from '../../lib/dates';
import { ageMs, formatAge, formatInt } from '../../lib/format';
import { usePaths } from '../../lib/paths';
import { statusTint } from '../../lib/symbols';
import { sorted, type PageSort } from '../../lib/task-sort';
import { cn } from '../../lib/utils';

/** The mark of each group: the board's and the Live page's own marks, so none needs learning. */
export function EpicMark({ state, label }: { state: EpicState; label?: string | null }) {
  const name = label === undefined ? EPIC_STATE_LABELS[state] : label;
  if (state === 'waiting') return <StatusMark status="waiting" label={name} />;
  if (state === 'moving') return <ActivityMark activity="active" label={name} />;
  if (state === 'still') return <ActivityMark activity="stalled" label={name} />;
  if (state === 'finished') return <StatusMark status="done" label={name} />;
  return <StatusMark status="open" label={name} />;
}

/** "this week" as a day: `Nov 2`, or null when the read named no start. */
export function sinceDay(since: string | null, nowMs: number, zone: string): string | null {
  // The server names the day itself (`2026-11-02`); read as an instant it is UTC midnight, the day before west of UTC.
  if (since !== null && /^\d{4}-\d{2}-\d{2}$/.test(since)) return calendarDay(since, nowMs, zone);
  const at = since === null ? Number.NaN : Date.parse(since);
  return Number.isNaN(at) ? null : calendarDay(dayIn(at, zone), nowMs, zone);
}

/** What each group holds, in words. */
function groupRule(state: EpicState, day: string | null): string {
  const week = day === null ? 'this week' : `since ${day}`;
  if (state === 'waiting') return 'A task in it waits for you';
  if (state === 'moving') return `A task done ${week}`;
  if (state === 'still') return `Nothing done ${week}`;
  if (state === 'finished') return 'Ready to close';
  return 'Nothing filed in it';
}

/** An epic's tasks as its bar draws them: the done count is all-time, the rest are open now. */
export function progressParts(summary: Pick<EpicSummary, 'open' | 'progress'>): ProgressParts {
  return {
    done: summary.progress?.done ?? 0,
    inProgress: summary.open.inProgress,
    waiting: summary.open.waiting,
    blocked: summary.open.blocked,
    open: summary.open.open,
    parked: summary.open.parked,
  };
}

/** A count with its mark, kept in its column when it is zero so the columns line up; on a phone a zero takes no room. */
function MarkedCount({
  count,
  words,
  mark,
  wait = false,
}: {
  count: number;
  words: string;
  mark: ReactNode;
  wait?: boolean;
}) {
  return (
    <span
      className={cn(
        'nums inline-flex w-10 shrink-0 items-center gap-1.25 text-meta font-medium',
        wait ? 'text-wait-text' : 'text-ink-2',
        count === 0 && 'invisible max-sm:hidden',
      )}
      {...(count === 0 ? { 'aria-hidden': true } : { 'aria-label': `${count} ${words}` })}
    >
      {mark}
      <span aria-hidden>{formatInt(count)}</span>
    </span>
  );
}

/**
 * The facts at the end of an epic's line: tasks waiting for you, blocked
 * tasks, the bar, tasks done of all, and tasks done this week. Without
 * `progress`, as for the tasks in no epic, the bar's place stays empty and
 * the count is of the open tasks. On a phone they take a line of their own.
 */
export function EpicFacts({
  open,
  progress,
  doneThisWeek,
  className,
}: {
  open: OpenTally;
  progress: EpicSummary['progress'] | 'none';
  doneThisWeek: number;
  className?: string;
}) {
  const bar = progress !== 'none';
  const counted = progress === 'none' ? null : progress;
  return (
    <span
      className={cn('flex shrink-0 items-center gap-2.5 max-sm:order-last max-sm:basis-full max-sm:ps-6', className)}
      data-epic-facts=""
    >
      <MarkedCount
        count={open.waiting}
        words="waiting for you"
        mark={<StatusMark status="waiting" label={null} />}
        wait
      />
      <MarkedCount count={open.blocked} words="blocked" mark={<StatusMark status="blocked" label={null} />} />
      {bar ? (
        <ProgressBar parts={progressParts({ open, progress: counted })} className="max-sm:w-14" />
      ) : (
        <span aria-hidden className="w-20 shrink-0 max-sm:hidden" />
      )}
      <span
        className="nums w-15 shrink-0 text-right text-meta text-ink-2 max-sm:w-auto max-sm:text-left"
        data-epic-done=""
        {...(counted === null ? {} : { 'aria-label': `${counted.done} of ${counted.total} done` })}
      >
        {bar
          ? counted === null
            ? ''
            : `${formatInt(counted.done)}/${formatInt(counted.total)}`
          : `${formatInt(openCount(open))} open`}
      </span>
      <span className="nums w-22 shrink-0 whitespace-nowrap text-meta text-ink-3 max-sm:w-auto" data-epic-week="">
        {doneThisWeek > 0 ? `+${formatInt(doneThisWeek)} this week` : ''}
      </span>
    </span>
  );
}

/** What a sort reads of an epic: its last change is its tasks' and sub-epics' too, and an open epic has no close. */
function epicFacts(summary: EpicSummary) {
  return { ...summary, updatedAt: summary.lastChangedAt, closedAt: null };
}

/** Epics in the order chosen in the Sort menu, or in the tab's own: priority, then the latest change. */
function inOrder(epics: readonly EpicSummary[], sort: PageSort | null): EpicSummary[] {
  return sort === null ? [...epics].sort(epicOrder) : sorted(epics, sort, epicFacts);
}

/** Indents for a sub-epic's line, by depth; deeper ones stop at the third. */
const INDENTS = ['', 'ps-11 max-sm:ps-8', 'ps-17 max-sm:ps-12', 'ps-23 max-sm:ps-16'];

/** One epic's line, and when unfolded its sub-epics' lines under it. */
function EpicRow({
  summary,
  depth,
  expanded,
  onToggle,
  nowMs,
  sort,
}: {
  summary: EpicSummary;
  depth: number;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  nowMs: number;
  sort: PageSort | null;
}) {
  const paths = usePaths();
  const subs = summary.subEpics.length;
  const open = expanded.has(summary.id);
  const age = ageMs(nowMs, summary.lastChangedAt);
  return (
    <>
      <Row
        data-epic-row={summary.id}
        tint={summary.mark}
        data-epic-state={summary.state}
        className={cn(
          'max-sm:h-auto max-sm:flex-wrap max-sm:gap-y-1 max-sm:py-2.5',
          INDENTS[Math.min(depth, INDENTS.length - 1)],
        )}
      >
        {subs > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the sub-epics of ${summary.id}`}
            onClick={() => onToggle(summary.id)}
            className="-mx-0.5 grid size-4.5 shrink-0 place-items-center rounded-sm text-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            {open ? <ChevronDown aria-hidden size={14} /> : <ChevronRight aria-hidden size={14} />}
          </button>
        ) : (
          <span aria-hidden className="w-3.5 shrink-0" />
        )}
        <PriorityMark priority={summary.priority} className="max-sm:hidden" />
        <RowId>{summary.id}</RowId>
        <EpicMark state={summary.state} />
        <RowTitle className="max-sm:flex-1">
          <Link to={paths.task(summary.id)} className="text-ink no-underline outline-none focus-visible:underline">
            {summary.title}
          </Link>
        </RowTitle>
        {subs > 0 ? (
          <RowMeta className="max-sm:hidden">
            {subs} {subs === 1 ? 'sub-epic' : 'sub-epics'}
          </RowMeta>
        ) : null}
        <RowSpacer className="max-sm:hidden" />
        <EpicFacts open={summary.open} progress={summary.progress} doneThisWeek={summary.doneThisWeek} />
        <RowAge>{age === null ? '' : formatAge(age)}</RowAge>
      </Row>
      {open
        ? inOrder(summary.subEpics, sort).map((sub) => (
            <EpicRow
              key={sub.id}
              summary={sub}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              nowMs={nowMs}
              sort={sort}
            />
          ))
        : null}
    </>
  );
}

/** How many of the project's top epics are in each of the groups that need watching, for the top bar. */
export function EpicsSummary({ read }: { read: EpicsRead }) {
  const states: readonly EpicState[] = ['waiting', 'moving', 'still'];
  return (
    // Below 1024 px the top bar has no room for it beside the views and the search.
    <span className="flex items-center gap-4 max-lg:hidden" data-epics-summary="">
      {states.map((state) => (
        <span
          key={state}
          className="nums inline-flex items-center gap-1.5 whitespace-nowrap text-label font-medium text-ink-2"
        >
          <EpicMark state={state} label={null} />
          {formatInt(read.epics.filter((epic) => epic.state === state).length)} {EPIC_STATE_LABELS[state].toLowerCase()}
        </span>
      ))}
    </span>
  );
}

function matchesWords(summary: EpicSummary, words: readonly string[]): boolean {
  const text = `${summary.id} ${summary.title}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * The project's epics in their groups. A search lists every epic whose id or
 * title holds its words, sub-epics included, in the same groups.
 */
export function EpicsView({
  read,
  q,
  sort,
  nowMs,
  onClearSearch,
}: {
  read: EpicsRead;
  q: string;
  /** The order chosen in the Sort menu; null keeps the tab's own. */
  sort: PageSort | null;
  nowMs: number;
  onClearSearch: () => void;
}) {
  const paths = usePaths();
  const zone = useTimeZone();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [closedOpen, setClosedOpen] = useState(false);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searching = words.length > 0;
  const listed = searching
    ? [...read.byId.values()].filter((summary) => matchesWords(summary, words)).sort(epicOrder)
    : read.epics;
  const looseOpen = openCount(read.loose.open);
  const day = sinceDay(read.since, nowMs, zone);
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (searching && listed.length === 0) {
    return (
      <EmptyState
        icon={<Search />}
        title="No epics match this search"
        action={
          <Button size="sm" onClick={onClearSearch}>
            Clear search
          </Button>
        }
      />
    );
  }
  if (!searching && read.byId.size === 0 && read.closed.length === 0 && looseOpen === 0) {
    return <EmptyState icon={<Layers />} title="No epics in this project" />;
  }

  return (
    <div className="pb-6" data-epics-view="">
      {EPIC_STATES.map((state) => {
        const epics = inOrder(
          listed.filter((summary) => summary.state === state),
          sort,
        );
        if (epics.length === 0) return null;
        return (
          <section key={state} aria-label={EPIC_STATE_LABELS[state]} data-epic-group={state}>
            <GroupHeader
              mark={<EpicMark state={state} label={null} />}
              label={EPIC_STATE_LABELS[state]}
              count={epics.length}
              tone={state === 'waiting' ? 'wait' : 'default'}
              end={<span className="text-meta font-normal text-ink-3 max-sm:hidden">{groupRule(state, day)}</span>}
            />
            {epics.map((summary) => (
              <EpicRow
                key={summary.id}
                summary={summary}
                depth={0}
                expanded={expanded}
                onToggle={toggle}
                nowMs={nowMs}
                sort={sort}
              />
            ))}
          </section>
        );
      })}
      {!searching && read.closed.length > 0 ? (
        <section aria-label="Closed this week" data-epic-group="closed">
          <GroupHeader
            mark={<StatusMark status="done" label={null} />}
            label="Closed this week"
            count={read.closed.length}
            open={closedOpen}
            onToggle={() => setClosedOpen(!closedOpen)}
          />
          {closedOpen
            ? sorted(read.closed, sort).map((epic) => {
                const tint = statusTint('done', epic.resolution);
                return (
                  <Row key={epic.id} tint={tint} data-epic-row={epic.id} data-epic-state="closed">
                    <span aria-hidden className="w-3.5 shrink-0" />
                    <PriorityMark priority={epic.priority} className="max-sm:hidden" />
                    <RowId>{epic.id}</RowId>
                    <StatusMark
                      status="done"
                      muted={tint === 'closed'}
                      label={tint === 'closed' ? 'Closed' : undefined}
                    />
                    <RowTitle>
                      <Link
                        to={paths.task(epic.id)}
                        className="text-ink no-underline outline-none focus-visible:underline"
                      >
                        {epic.title}
                      </Link>
                    </RowTitle>
                    <RowSpacer />
                    <RowAge>{formatAge(ageMs(nowMs, epic.closedAt))}</RowAge>
                  </Row>
                );
              })
            : null}
        </section>
      ) : null}
      {!searching && looseOpen + read.loose.doneThisWeek > 0 ? (
        <section aria-label="No epic" data-epic-group="none">
          <GroupHeader
            mark={<StatusMark status="open" label={null} />}
            label="No epic"
            count={looseOpen}
            end={<span className="text-meta font-normal text-ink-3 max-sm:hidden">Open tasks in no epic</span>}
          />
          <Row data-epic-row="none" className="max-sm:h-auto max-sm:flex-wrap max-sm:gap-y-1 max-sm:py-2.5">
            <span aria-hidden className="w-3.5 shrink-0" />
            <RowTitle className="text-ink-2 max-sm:flex-1">
              {looseOpen === 1 ? '1 open task' : `${formatInt(looseOpen)} open tasks`} in no epic
            </RowTitle>
            <RowSpacer className="max-sm:hidden" />
            <EpicFacts open={read.loose.open} progress="none" doneThisWeek={read.loose.doneThisWeek} />
            <RowAge />
          </Row>
        </section>
      ) : null}
    </div>
  );
}
