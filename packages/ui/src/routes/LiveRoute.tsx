import { Activity as ActivityIcon, Bot, GitBranch, GitPullRequest, Layers } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageSkeleton, ReadBanner, ReadFailed } from '../components/surface';
import { Avatar } from '../components/ui/avatar';
import { ProgressBar } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Tabs } from '../components/ui/choice';
import { EmptyState } from '../components/ui/empty-state';
import { GroupHeader, Row, RowAge, RowId, RowMeta, RowSpacer, RowTitle } from '../components/ui/row';
import { BarSpacer, TopBar } from '../components/ui/shell';
import { ActivityMark } from '../components/ui/symbols';
import { useBoard } from '../hooks/useBoard';
import { useNow } from '../hooks/useNow';
import { NO_FILTERS } from '../lib/board-read';
import { byEpic, readEpics, type EpicSummary } from '../lib/epics';
import { pullRequestLabel } from '../lib/wins';
import { httpUrl } from '../lib/custom-fields';
import { ageMs, formatAge, formatInt } from '../lib/format';
import {
  ACTIVITIES,
  ACTIVITY_LABELS,
  liveBoard,
  liveGroups,
  STAGES,
  type Activity,
  type ShippedWindow,
} from '../lib/live';
import { isAgentActor } from '../lib/symbols';
import { actorLabel, claimedModel, type BoardTask } from '../lib/task-model';
import { usePaths } from '../lib/paths';
import { cn } from '../lib/utils';
import { LiveBoardView } from './live/live-board';
import { useDeliveryWaits } from './tasks/delivery-groups';
import { progressParts } from './tasks/epics-view';
import { usePageTitle } from '../lib/page-title';

/** The stalled tasks shown before Show more: the most recently stalled, where work is likeliest to resume. */
const STALLED_SHOWN = 5;

/** What each group holds, in words. */
const GROUP_RULES: Readonly<Record<Activity, string>> = Object.freeze({
  active: 'Changed in the last hour',
  quiet: 'Last change 1 hour to 1 day ago',
  stalled: 'Nothing for 1 day or more',
});

/** The page's two views: the board, which it opens on, and the list, at `?view=list`. */
type LiveView = 'board' | 'list';
const VIEWS: readonly { value: LiveView; label: string }[] = [
  { value: 'board', label: 'Board' },
  { value: 'list', label: 'List' },
];

/**
 * Live, `<base>/live`. The board shows work in progress, work waiting on a
 * pull request or a deploy, and work that went live. It moves a card
 * to its new column as it ships. The list shows the tasks in progress grouped by how
 * recently their holder changed or commented on them: Active within the hour,
 * Quiet until a day, and Stalled after it or with nothing recorded, as the
 * server marks it. The page shows Stalled and changes nothing: the task stays
 * In progress.
 */
export function LiveRoute() {
  const now = useNow();
  const board = useBoard(NO_FILTERS);
  const [params, setParams] = useSearchParams();
  const view: LiveView = params.get('view') === 'list' ? 'list' : 'board';
  // The Live column's reach: 7 days unless the address names the last 24 hours.
  const shipped: ShippedWindow = params.get('shipped') === 'day' ? 'day' : 'week';
  // The List view's address, keeping the rest of this one, such as the Live column's window.
  const listParams = new URLSearchParams(params);
  listParams.set('view', 'list');
  const listSearch = listParams.toString();
  /** The address with `name` set to `value`, or without it for its default, keeping the rest. */
  function setParam(name: 'view' | 'shipped', value: string | null) {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(name);
    else next.set(name, value);
    setParams(next);
  }
  const [allStalled, setAllStalled] = useState(false);
  const groups = useMemo(() => liveGroups(board.allTasks, now), [board.allTasks, now]);
  const waits = useDeliveryWaits(board, NO_FILTERS, view === 'board');
  const deploying = useMemo(
    () => new Set((board.catalog.data ?? []).filter((project) => project.deploys === true).map((p) => p.logicalKey)),
    [board.catalog.data],
  );
  const columns = useMemo(
    () => liveBoard(board.allTasks, waits, (project) => deploying.has(project), now, shipped),
    [board.allTasks, waits, deploying, now, shipped],
  );
  const onBoard = STAGES.reduce((sum, stage) => sum + columns[stage].length, 0);
  const projectsByKey = useMemo(
    () => new Map(board.projects.map((project) => [project.key, project] as const)),
    [board.projects],
  );
  // Each project's open epics, so a task in progress sits under its own.
  const epics = useMemo(
    () =>
      new Map(
        board.projects
          .filter((project) => project.ok)
          .map((project) => [project.key, readEpics(project, board.statuses, board.held)] as const),
      ),
    [board.projects, board.statuses, board.held],
  );
  const epicOf = (task: BoardTask): EpicSummary | null =>
    task.parent === null ? null : (epics.get(task.project)?.byId.get(task.parent) ?? null);
  const total = ACTIVITIES.reduce((sum, activity) => sum + groups[activity].length, 0);
  usePageTitle(board.loading ? 'Live' : `Live (${formatInt(total)})`);
  const shown = board.readFailure === null && !board.loading && total > 0;
  const views = (
    <Tabs
      label="View"
      items={VIEWS}
      value={view}
      onChange={(next) => setParam('view', next === 'board' ? null : next)}
    />
  );

  let body;
  if (board.readFailure !== null) {
    body = (
      <ReadFailed
        title="Couldn't load your projects"
        error={board.readFailure}
        retrying={board.fetching}
        onRetry={() => void board.refetch()}
      />
    );
  } else if (board.loading || (view === 'board' && onBoard === 0 && waits.loading)) {
    body = <PageSkeleton shape="list" />;
  } else if (view === 'board' && (onBoard > 0 || shipped === 'day')) {
    // A board left empty by the 24-hour window stays, so its switch can widen it again.
    body = (
      <LiveBoardView
        columns={columns}
        projects={projectsByKey}
        nowMs={now}
        shipped={shipped}
        onShipped={(next) => setParam('shipped', next === 'week' ? null : next)}
      />
    );
  } else if (total === 0) {
    body = (
      <EmptyState
        icon={<ActivityIcon />}
        title={
          view === 'board'
            ? board.complete && waits.unread.length === 0
              ? 'No tasks in progress or shipped this week'
              : 'No tasks in progress or shipped this week in the projects that could be read'
            : board.complete
              ? 'No tasks in progress'
              : 'No tasks in progress in the projects that could be read'
        }
      />
    );
  } else {
    body = ACTIVITIES.map((activity) => {
      const tasks = groups[activity];
      if (tasks.length === 0) return null;
      const folded = activity === 'stalled' && !allStalled ? tasks.slice(0, STALLED_SHOWN) : tasks;
      const more = tasks.length - folded.length;
      const sections = byEpic(folded, epicOf);
      // Under-epic lines appear only where a task in the group has an epic.
      const underEpics = sections.some((section) => section.epic !== null);
      return (
        <section key={activity} aria-label={ACTIVITY_LABELS[activity]} data-live-group={activity}>
          <GroupHeader
            mark={<ActivityMark activity={activity} label={null} />}
            label={ACTIVITY_LABELS[activity]}
            count={tasks.length}
            end={<span className="text-meta font-normal text-ink-3 max-sm:hidden">{GROUP_RULES[activity]}</span>}
          />
          {sections.map((section) => (
            <Fragment key={section.epic?.id ?? 'none'}>
              {section.epic !== null ? (
                <EpicLine epic={section.epic} />
              ) : underEpics ? (
                <div
                  className="flex h-9 items-center gap-2.5 border-b border-border ps-5.5 pe-5 text-meta text-ink-3 max-sm:px-4"
                  data-live-epic="none"
                >
                  <span aria-hidden className="w-3.5 shrink-0" />
                  No epic
                </div>
              ) : null}
              {section.tasks.map((task) => (
                <LiveRow key={task.id} task={task} activity={activity} nowMs={now} indent={underEpics} />
              ))}
            </Fragment>
          ))}
          {more > 0 ? (
            <div className="flex h-9 items-center border-b border-border ps-[132px] pe-5 max-sm:ps-[31px]">
              <Button variant="ghost" size="sm" type="button" onClick={() => setAllStalled(true)} data-live-more="">
                Show {formatInt(more)} more
              </Button>
            </div>
          ) : null}
        </section>
      );
    });
  }

  return (
    <>
      <TopBar title="Live">
        {shown ? (
          <span className="flex items-center gap-4 max-sm:hidden" data-live-summary="">
            {ACTIVITIES.map((activity) => {
              const count = (
                <>
                  <ActivityMark activity={activity} label={null} />
                  {formatInt(groups[activity].length)} {ACTIVITY_LABELS[activity].toLowerCase()}
                </>
              );
              const look = 'nums inline-flex items-center gap-1.5 text-label font-medium text-ink-2';
              // On the board each count opens the List view, which groups the tasks it counts.
              return view === 'list' ? (
                <span key={activity} className={look}>
                  {count}
                </span>
              ) : (
                <Link
                  key={activity}
                  to={{ search: `?${listSearch}` }}
                  className={cn(look, 'no-underline outline-none hover:text-ink focus-visible:underline')}
                >
                  {count}
                </Link>
              );
            })}
          </span>
        ) : null}
        <BarSpacer />
        {views}
      </TopBar>
      {view === 'board' && board.readFailure === null && waits.unread.length > 0 ? (
        <ReadBanner
          title="Couldn't read the work waiting for a merge or a deploy in:"
          onRetry={waits.retry}
          data-live-unread=""
        >
          {waits.unread.join(', ')}
        </ReadBanner>
      ) : null}
      <div data-live-page="">{body}</div>
    </>
  );
}

/**
 * The epic a group's tasks below it belong to: its id and title as a link,
 * then its progress bar and its tasks done of all, as the Epics tab draws them.
 */
function EpicLine({ epic }: { epic: EpicSummary }) {
  const paths = usePaths();
  return (
    <Row tint={epic.mark} data-live-epic={epic.id}>
      <Layers aria-hidden size={14} className="shrink-0 text-ink-3" />
      <RowId>{epic.id}</RowId>
      <RowTitle className="max-sm:flex-1">
        <Link to={paths.task(epic.id)} className="text-ink-2 no-underline outline-none focus-visible:underline">
          {epic.title}
        </Link>
      </RowTitle>
      <RowSpacer className="max-sm:hidden" />
      <ProgressBar parts={progressParts(epic)} className="max-sm:w-12" />
      {epic.progress === null ? null : (
        <span
          className="nums w-15 shrink-0 text-right text-meta text-ink-2 max-sm:w-auto"
          aria-label={`${epic.progress.done} of ${epic.progress.total} done`}
        >
          {formatInt(epic.progress.done)}/{formatInt(epic.progress.total)}
        </span>
      )}
    </Row>
  );
}

/**
 * A task in progress: its activity, id and title, then what its holder
 * recorded (the next step, the pull request or else the branch, the helper),
 * the holder and how long ago they last worked on it. On a phone the holder
 * and the next step take a second line.
 */
function LiveRow({
  task,
  activity,
  nowMs,
  indent,
}: {
  task: BoardTask;
  activity: Activity;
  nowMs: number;
  /** It sits under its epic's line, or under No epic. */
  indent: boolean;
}) {
  const paths = usePaths();
  const age = ageMs(nowMs, task.lastActivityAt);
  const holder = task.assignee ? actorLabel(task.assignee, task.actors) : null;
  const next = task.work?.next ?? null;
  // A pull request that is not an http or https address shows no link, as on the task page.
  const pr = task.work?.pr ? httpUrl(task.work.pr) : null;
  const branch = task.work?.branch ?? null;
  const phoneLine = [holder, next ? `Next: ${next}` : null, age === null ? 'Nothing recorded' : null]
    .filter((part) => part !== null)
    .join(' · ');
  return (
    <Row
      data-live-row={task.id}
      tint="in-progress"
      data-activity={activity}
      className={cn('max-sm:h-auto max-sm:flex-wrap max-sm:gap-y-0.5 max-sm:py-2.5', indent && 'ps-11 max-sm:ps-8')}
    >
      <ActivityMark activity={activity} />
      <RowId>{task.id}</RowId>
      <RowTitle className="max-sm:flex-1">
        <Link to={paths.task(task.id)} className="text-ink no-underline outline-none focus-visible:underline">
          {task.title}
        </Link>
      </RowTitle>
      {next ? (
        <RowMeta className="min-w-0 shrink-[4]" data-live-next="">
          Next <span className="truncate text-ink-2">{next}</span>
        </RowMeta>
      ) : null}
      {pr ? (
        <RowMeta data-live-pr="">
          <GitPullRequest aria-hidden />
          <a href={pr} target="_blank" rel="noreferrer" className="text-accent-text no-underline hover:underline">
            {pullRequestLabel(pr)}
          </a>
        </RowMeta>
      ) : branch ? (
        <RowMeta className="min-w-0 shrink-[4]" data-live-branch="">
          <GitBranch aria-hidden />
          <span className="truncate">{branch}</span>
        </RowMeta>
      ) : null}
      {task.for ? (
        <RowMeta>
          <Bot aria-hidden />
          For <span className="text-ink-2">{task.for}</span>
        </RowMeta>
      ) : null}
      {age === null ? <RowMeta>Nothing recorded</RowMeta> : null}
      {/* On a phone the title takes the free width, which the spacer would halve. */}
      <RowSpacer className="max-sm:hidden" />
      {task.assignee && holder ? (
        <Avatar name={holder} agent={isAgentActor(task.assignee)} model={claimedModel(task)} />
      ) : null}
      <RowAge>{age === null ? '' : formatAge(age)}</RowAge>
      <span
        className="hidden min-w-0 basis-full truncate ps-[23px] text-meta text-ink-3 max-sm:block"
        data-live-phone=""
      >
        {phoneLine}
      </span>
    </Row>
  );
}

export default LiveRoute;
