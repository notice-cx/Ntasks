import { Activity as ActivityIcon, Bot, GitBranch, GitPullRequest } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageSkeleton, ReadFailed } from '../components/surface';
import { Avatar } from '../components/ui/avatar';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { GroupHeader, Row, RowAge, RowId, RowMeta, RowSpacer, RowTitle } from '../components/ui/row';
import { BarSpacer, TopBar } from '../components/ui/shell';
import { ActivityMark } from '../components/ui/symbols';
import { useBoard } from '../hooks/useBoard';
import { useNow } from '../hooks/useNow';
import { NO_FILTERS } from '../lib/board-read';
import { httpUrl } from '../lib/custom-fields';
import { ageMs, formatAge, formatInt } from '../lib/format';
import { ACTIVITIES, ACTIVITY_LABELS, liveGroups, type Activity } from '../lib/live';
import { isAgentActor } from '../lib/symbols';
import { actorLabel, claimedModel, type BoardTask } from '../lib/task-model';
import { usePaths } from '../lib/paths';

/** The stalled tasks shown before Show more: the most recently stalled, where work is likeliest to resume. */
const STALLED_SHOWN = 5;

/** What each group holds, in words. */
const GROUP_RULES: Readonly<Record<Activity, string>> = Object.freeze({
  active: 'Changed in the last hour',
  quiet: 'Last change 1 hour to 1 day ago',
  stalled: 'Nothing for 1 day or more',
});

/** A pull request's number from its URL, as `#42`, or its kind when the URL names none. */
function pullRequestLabel(url: string): string {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number === undefined ? 'Pull request' : `#${number}`;
}

/**
 * Live, `<base>/live`: every task in progress, grouped by how recently its
 * holder changed or commented on it: Active within the hour, Quiet until a
 * day, and Stalled after it or with nothing recorded, as the server marks it.
 * The page shows Stalled and changes nothing: the task stays In progress.
 */
export function LiveRoute() {
  const now = useNow();
  const board = useBoard(NO_FILTERS);
  const [allStalled, setAllStalled] = useState(false);
  const groups = useMemo(() => liveGroups(board.allTasks, now), [board.allTasks, now]);
  const total = ACTIVITIES.reduce((sum, activity) => sum + groups[activity].length, 0);
  const shown = board.readFailure === null && !board.loading && total > 0;

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
  } else if (board.loading) {
    body = <PageSkeleton shape="list" />;
  } else if (total === 0) {
    body = (
      <EmptyState
        icon={<ActivityIcon />}
        title={board.complete ? 'No tasks in progress' : 'No tasks in progress in the projects that could be read'}
      />
    );
  } else {
    body = ACTIVITIES.map((activity) => {
      const tasks = groups[activity];
      if (tasks.length === 0) return null;
      const folded = activity === 'stalled' && !allStalled ? tasks.slice(0, STALLED_SHOWN) : tasks;
      const more = tasks.length - folded.length;
      return (
        <section key={activity} aria-label={ACTIVITY_LABELS[activity]} data-live-group={activity}>
          <GroupHeader
            mark={<ActivityMark activity={activity} label={null} />}
            label={ACTIVITY_LABELS[activity]}
            count={tasks.length}
            end={<span className="text-meta font-normal text-ink-3 max-sm:hidden">{GROUP_RULES[activity]}</span>}
          />
          {folded.map((task) => (
            <LiveRow key={task.id} task={task} activity={activity} nowMs={now} />
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
            {ACTIVITIES.map((activity) => (
              <span key={activity} className="nums inline-flex items-center gap-1.5 text-label font-medium text-ink-2">
                <ActivityMark activity={activity} label={null} />
                {formatInt(groups[activity].length)} {ACTIVITY_LABELS[activity].toLowerCase()}
              </span>
            ))}
          </span>
        ) : null}
        <BarSpacer />
      </TopBar>
      <div data-live-page="">{body}</div>
    </>
  );
}

/**
 * A task in progress: its activity, id and title, then what its holder
 * recorded (the next step, the pull request or else the branch, the helper),
 * the holder and how long ago they last worked on it. On a phone the holder
 * and the next step take a second line.
 */
function LiveRow({ task, activity, nowMs }: { task: BoardTask; activity: Activity; nowMs: number }) {
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
      data-activity={activity}
      className="max-sm:h-auto max-sm:flex-wrap max-sm:gap-y-0.5 max-sm:py-2.5"
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
