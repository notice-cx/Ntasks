import { useInfiniteQuery } from '@tanstack/react-query';
import { ChartNoAxesColumn, ChevronDown, GitCommitHorizontal, GitMerge, GitPullRequest, Split } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTasksApi } from '../api/context';
import type { DecidedWin, FinishedWin, ShippedWin, Win, WinsDay, WinsPage } from '../api/types';
import { PageSkeleton, ReadFailed } from '../components/surface';
import { Avatar } from '../components/ui/avatar';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../components/ui/menu';
import { GroupHeader, Row, RowAge, RowId, RowMeta, RowSpacer, RowTitle } from '../components/ui/row';
import { BarSpacer, TopBar } from '../components/ui/shell';
import { StatusMark } from '../components/ui/symbols';
import { useNow } from '../hooks/useNow';
import { useTaskProjects } from '../hooks/useTasks';
import { ageMs, formatAge, formatInt } from '../lib/format';
import { usePageTitle } from '../lib/page-title';
import { usePaths } from '../lib/paths';
import { isAgentActor } from '../lib/symbols';
import { cn } from '../lib/utils';
import { dayIn, dayLabel, useTimeZone, weekdayDay } from '../lib/dates';
import { countsOf, firstShipped, pullRequestLabel, winsByDay, winsDayRule } from '../lib/wins';

/** The wins a day shows before Show more. */
const DAY_SHOWN = 8;
/** The tallest bar in the strip of days, in px. */
const BAR_MAX = 44;
/** The fewest wins the tallest bar stands for, so one win on a quiet week is a short bar, not a full one. */
const BAR_SCALE_LEAST = 4;

/**
 * Productivity, `<base>/productivity`: what you and your agents got done that
 * matters, day by day. A strip of the last seven days, then every win under
 * its day, newest first: changes shipped, answers you gave and epics
 * finished. It counts no tasks closed, and ranks nobody. Show the 7 days
 * before reads further back, to eight weeks.
 */
export function ProductivityRoute() {
  const api = useTasksApi();
  const now = useNow();
  const zone = useTimeZone();
  const [params, setParams] = useSearchParams();
  const project = params.get('project') ?? undefined;
  const projects = useTaskProjects();
  const named = projects.data?.find((row) => row.logicalKey === project) ?? null;
  const wins = useInfiniteQuery({
    // An object, so no project's key, which is text, can name the same query;
    // under the boards', so whatever reads every board again reads it again too.
    queryKey: ['tasks', { wins: project ?? null, zone }],
    queryFn: ({ pageParam, signal }) => api.wins({ project, before: pageParam ?? undefined, timeZone: zone }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last: WinsPage) => last.earlier,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const pages = wins.data?.pages ?? [];
  const first = pages[0];
  usePageTitle('Productivity', named?.displayName);

  function choose(key: string | null) {
    const next = new URLSearchParams(params);
    if (key === null) next.delete('project');
    else next.set('project', key);
    setParams(next, { replace: true });
  }

  let body;
  if (wins.isError && first === undefined) {
    body = (
      <ReadFailed
        title="Couldn't load the wins"
        error={wins.error}
        retrying={wins.isFetching}
        onRetry={() => void wins.refetch()}
      />
    );
  } else if (first === undefined) {
    body = <PageSkeleton shape="list" />;
  } else {
    const shippedFrom = firstShipped(pages);
    body = (
      <>
        <DayStrip days={first.days} today={dayIn(now, zone)} />
        <div
          className="flex flex-wrap items-center gap-x-4.5 gap-y-1 px-6 pb-3.5 text-sm font-normal text-ink-2 max-sm:px-4"
          data-wins-summary=""
        >
          <Legend tone="shipped" count={first.totals.shipped} label="shipped" />
          <Legend tone="decided" count={first.totals.decided} label="decided" />
          <Legend
            tone="finished"
            count={first.totals.finished}
            label={first.totals.finished === 1 ? 'epic finished' : 'epics finished'}
          />
          <span className="nums text-ink-3">
            and {formatInt(first.totals.approved)} {first.totals.approved === 1 ? 'approval' : 'approvals'}
          </span>
          {shippedFrom !== null || (!first.shippedBefore && first.totals.shipped === 0) ? (
            <span className="text-meta text-ink-3" data-wins-note="">
              {shippedFrom !== null ? `Merges are recorded from ${dayLabel(shippedFrom)}.` : 'No merges recorded yet.'}
            </span>
          ) : null}
        </div>
        {pages.map((page, index) => (
          <WinsFeed key={page.from} page={page} nowMs={now} first={index === 0} />
        ))}
        <div className="flex h-12 items-center gap-3 px-6 max-sm:px-4">
          {wins.hasNextPage ? (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={wins.isFetchingNextPage}
              onClick={() => void wins.fetchNextPage()}
              data-wins-earlier=""
            >
              {wins.isFetchingNextPage ? 'Loading…' : 'Show the 7 days before'}
            </Button>
          ) : (
            <span className="text-meta text-ink-3">The feed reaches back 8 weeks.</span>
          )}
          {wins.isFetchNextPageError ? (
            <span className="text-meta text-ink">Couldn't load the days before.</span>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar title="Productivity">
        <span className="text-meta text-ink-3 max-sm:hidden">Last 7 days</span>
        <BarSpacer />
        <Menu>
          <MenuTrigger asChild>
            <Button data-wins-project={project ?? ''}>
              {named?.displayName ?? 'All projects'}
              <ChevronDown aria-hidden />
            </Button>
          </MenuTrigger>
          <MenuContent label="Project" align="end">
            <MenuItem checked={project === undefined} onSelect={() => choose(null)}>
              All projects
            </MenuItem>
            {(projects.data ?? []).length > 0 ? <MenuSeparator /> : null}
            {(projects.data ?? []).map((row) => (
              <MenuItem
                key={row.logicalKey}
                checked={row.logicalKey === project}
                onSelect={() => choose(row.logicalKey)}
              >
                {row.displayName}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      </TopBar>
      <div data-wins-page="">{body}</div>
    </>
  );
}

/** The colour key beside each count under the strip. */
function Legend({ tone, count, label }: { tone: 'shipped' | 'decided' | 'finished'; count: number; label: string }) {
  return (
    <span className="nums inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn(
          'size-2.25 shrink-0',
          tone === 'shipped' && 'rounded-xs bg-done',
          tone === 'decided' && 'rounded-xs bg-ink-2',
          tone === 'finished' && 'rounded-full inset-ring-2 inset-ring-done',
        )}
      />
      <b className="font-semibold text-ink">{formatInt(count)}</b> {label}
    </span>
  );
}

/**
 * The seven days as a strip: each day's wins as one bar, shipped in green
 * under decided in Text 2, and a green ring for each epic finished. A day
 * with none says Nothing. Today's day is ringed in Accent.
 */
function DayStrip({ days, today }: { days: readonly WinsDay[]; today: string }) {
  const most = Math.max(BAR_SCALE_LEAST, ...days.map((day) => day.shipped + day.decided));
  const height = (count: number) => (count === 0 ? 0 : Math.max(2, Math.round((count / most) * BAR_MAX)));
  return (
    <ol
      className="grid grid-cols-7 gap-2 px-6 pt-4.5 pb-3 max-sm:gap-1 max-sm:px-3"
      aria-label="Wins by day"
      data-wins-strip=""
    >
      {days.map((day) => {
        const total = day.shipped + day.decided + day.finished;
        return (
          <li
            key={day.day}
            className={cn(
              'flex min-w-0 flex-col gap-1.5 rounded-[10px] px-2.5 pt-2 pb-2.5 inset-ring inset-ring-border max-sm:px-1.25',
              day.day === today && 'inset-ring-[1.5px] inset-ring-accent',
            )}
            aria-label={`${dayLabel(day.day)}: ${total === 0 ? 'nothing' : winsDayRule(day)}`}
            data-wins-day={day.day}
          >
            <span className="flex items-baseline justify-between gap-1 text-xs text-ink-3 max-sm:justify-center">
              <b className="truncate text-label font-semibold text-ink max-sm:hidden">{weekdayDay(day.day)}</b>
              {/* A phone has room for the date alone; the cell's name says the day in full. */}
              <b className="hidden text-xs font-semibold text-ink max-sm:block">{Number(day.day.slice(8))}</b>
              <span className="nums max-sm:hidden">{total > 0 ? formatInt(total) : ''}</span>
            </span>
            <span aria-hidden className="flex h-16 flex-col justify-end gap-0.75 max-sm:items-center">
              {total === 0 ? (
                <span className="text-meta text-ink-3 max-sm:text-[11px]">Nothing</span>
              ) : (
                <>
                  {day.finished > 0 ? (
                    <span className="flex flex-wrap gap-0.75">
                      {Array.from({ length: Math.min(day.finished, 8) }, (_, i) => (
                        <span key={i} className="size-2.25 rounded-full inset-ring-2 inset-ring-done" />
                      ))}
                    </span>
                  ) : null}
                  <span className="flex w-full flex-col overflow-hidden rounded-[3px] max-sm:w-3">
                    {day.decided > 0 ? (
                      <span className="block bg-ink-2" style={{ height: height(day.decided) }} />
                    ) : null}
                    {day.shipped > 0 ? (
                      <span
                        className={cn('block bg-done', day.decided > 0 && 'mt-px')}
                        style={{ height: height(day.shipped) }}
                      />
                    ) : null}
                  </span>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** One read's wins under their days, newest first; a day with many shows eight, then Show more. */
function WinsFeed({ page, nowMs, first }: { page: WinsPage; nowMs: number; first: boolean }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // The server cut these days in the zone it names; an older server names none and cut them in UTC.
  const days = winsByDay(page.wins, page.timeZone ?? 'UTC');
  if (days.length === 0) {
    if (first) return <EmptyState icon={<ChartNoAxesColumn />} title="No wins in the last 7 days" className="py-12" />;
    return (
      <div className="flex h-9 items-center border-b border-border px-6 text-meta text-ink-3 max-sm:px-4">
        No wins from {dayLabel(page.days[0]?.day ?? '')} to {dayLabel(page.days.at(-1)?.day ?? '')}
      </div>
    );
  }
  return (
    <>
      {days.map(({ day, wins }) => {
        const shown = open.has(day) ? wins : wins.slice(0, DAY_SHOWN);
        const more = wins.length - shown.length;
        return (
          <section key={day} aria-label={dayLabel(day)} data-wins-group={day}>
            <GroupHeader
              label={dayLabel(day)}
              count={wins.length}
              end={
                <span className="text-meta font-normal text-ink-3 max-sm:hidden">{winsDayRule(countsOf(wins))}</span>
              }
            />
            {shown.map((win) => (
              <WinRow key={`${win.kind} ${idOf(win)}`} win={win} nowMs={nowMs} />
            ))}
            {more > 0 ? (
              <div className="flex h-9 items-center border-b border-border ps-[46px] pe-5 max-sm:ps-10">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => setOpen((before) => new Set(before).add(day))}
                  data-wins-more={day}
                >
                  Show {formatInt(more)} more
                </Button>
              </div>
            ) : null}
          </section>
        );
      })}
    </>
  );
}

const idOf = (win: Win) => (win.kind === 'shipped' ? (win.tasks[0]?.id ?? win.at) : win.id);

function WinRow({ win, nowMs }: { win: Win; nowMs: number }) {
  if (win.kind === 'shipped') return <ShippedRow win={win} nowMs={nowMs} />;
  if (win.kind === 'decided') return <DecidedRow win={win} nowMs={nowMs} />;
  return <FinishedRow win={win} nowMs={nowMs} />;
}

/** A row's facts on a second line, on a phone only, where the row has no room for them. */
function PhoneLine({ children }: { children: ReactNode }) {
  return (
    <span className="hidden min-w-0 basis-full truncate ps-[25px] text-meta text-ink-3 max-sm:block" data-wins-phone="">
      {children}
    </span>
  );
}

function TaskLink({ id, title, strong = false }: { id: string; title: string; strong?: boolean }) {
  const paths = usePaths();
  return (
    <Link
      to={paths.task(id)}
      className={cn('text-ink no-underline outline-none focus-visible:underline', strong && 'font-semibold')}
    >
      {title}
    </Link>
  );
}

/**
 * A change that merged or went live: its first task, how many more it closed,
 * its pull request, or its commit when it has none, and its stage.
 */
function ShippedRow({ win, nowMs }: { win: ShippedWin; nowMs: number }) {
  const [task] = win.tasks;
  const others = win.tasks.length - 1;
  const stage = win.stage === 'live' ? 'Live' : 'Merged';
  const change =
    win.pullRequest !== null ? pullRequestLabel(win.pullRequest) : win.commit !== null ? win.commit.slice(0, 7) : null;
  return (
    <Row data-wins-row="shipped" className="max-sm:h-auto max-sm:flex-wrap max-sm:gap-y-0.5 max-sm:py-2.5">
      <GitMerge aria-label="Shipped" size={15} className="shrink-0 text-ink-3" />
      <RowId>{task?.id ?? ''}</RowId>
      <RowTitle className="max-sm:flex-1">{task ? <TaskLink id={task.id} title={task.title} /> : null}</RowTitle>
      {others > 0 ? <RowMeta>and {formatInt(others)} more</RowMeta> : null}
      <RowSpacer className="max-sm:hidden" />
      {win.pullRequest !== null ? (
        <RowMeta>
          <GitPullRequest aria-hidden />
          <a
            href={win.pullRequest}
            target="_blank"
            rel="noreferrer"
            className="text-accent-text no-underline hover:underline"
          >
            {pullRequestLabel(win.pullRequest)}
          </a>
        </RowMeta>
      ) : win.commit !== null ? (
        <RowMeta>
          <GitCommitHorizontal aria-hidden />
          <span className="nums">{win.commit.slice(0, 7)}</span>
        </RowMeta>
      ) : null}
      <RowMeta className="w-12">{stage}</RowMeta>
      <RowAge>{formatAge(ageMs(nowMs, win.at))}</RowAge>
      <PhoneLine>
        {[change, others > 0 ? `and ${formatInt(others)} more` : null, stage]
          .filter((part) => part !== null)
          .join(' · ')}
      </PhoneLine>
    </Row>
  );
}

/** A person's answer: the task, the option they chose and who chose it. */
function DecidedRow({ win, nowMs }: { win: DecidedWin; nowMs: number }) {
  return (
    <Row data-wins-row="decided" className="max-sm:h-auto max-sm:flex-wrap max-sm:gap-y-0.5 max-sm:py-2.5">
      <Split aria-label="Decided" size={15} className="shrink-0 text-ink-3" />
      <RowId>{win.id}</RowId>
      <RowTitle className="max-sm:flex-1">
        <TaskLink id={win.id} title={win.title} />
      </RowTitle>
      <RowSpacer className="max-sm:hidden" />
      <RowMeta className="min-w-0 shrink-[4]">
        Chose <span className="truncate text-ink-2">{win.label}</span>
      </RowMeta>
      <Avatar name={win.by} agent={isAgentActor(win.by)} />
      <RowAge>{formatAge(ageMs(nowMs, win.at))}</RowAge>
      <PhoneLine>Chose {win.label}</PhoneLine>
    </Row>
  );
}

/** An epic finished: drawn taller, after a Done mark at heading size, with its tasks done. */
function FinishedRow({ win, nowMs }: { win: FinishedWin; nowMs: number }) {
  return (
    <Row data-wins-row="finished" className="h-12 max-sm:h-auto max-sm:flex-wrap max-sm:gap-y-0.5 max-sm:py-2.5">
      <StatusMark status="done" size={20} label="Epic finished" className="-mx-0.5" />
      <RowId>{win.id}</RowId>
      <RowTitle className="max-sm:flex-1">
        <TaskLink id={win.id} title={win.title} strong />
      </RowTitle>
      <RowSpacer className="max-sm:hidden" />
      <RowMeta>
        Epic finished · <span className="nums">{formatInt(win.done)}</span> {win.done === 1 ? 'task' : 'tasks'} done
      </RowMeta>
      <RowAge>{formatAge(ageMs(nowMs, win.at))}</RowAge>
      <PhoneLine>
        Epic finished · {formatInt(win.done)} {win.done === 1 ? 'task' : 'tasks'} done
      </PhoneLine>
    </Row>
  );
}

export default ProductivityRoute;
