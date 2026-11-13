import { ArrowRight, ChevronRight, Layers, List, Plus } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Link, NavLink, useOutlet, useParams } from 'react-router-dom';
import { ProjectIcon } from '../components/ProjectIcon';
import { PageSkeleton, ReadFailed } from '../components/surface';
import { ProgressBar } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { Kbd } from '../components/ui/kbd';
import { BarSpacer, TopBar } from '../components/ui/shell';
import { StatusMark } from '../components/ui/symbols';
import { useBoard } from '../hooks/useBoard';
import { useNow } from '../hooks/useNow';
import { useAnswerHides, useCapabilities, writesAvailable } from '../hooks/useTasks';
import { isWork, NO_FILTERS, type BoardProject } from '../lib/board-read';
import { EPIC_STATE_LABELS, readEpics, type EpicSummary, type EpicsRead } from '../lib/epics';
import { ageMs, formatAge, formatInt } from '../lib/format';
import { COMPOSE_STATE } from '../lib/page-state';
import { usePageTitle } from '../lib/page-title';
import { usePaths } from '../lib/paths';
import { statusMarkFor } from '../lib/symbols';
import { type BoardTask } from '../lib/task-model';
import { progressParts } from './tasks/epics-view';

const TAB =
  'inline-flex min-h-10 items-center gap-2 border-b-2 border-transparent text-label text-ink-3 no-underline hover:text-ink focus-visible:outline-2 focus-visible:outline-accent aria-[current=page]:border-accent aria-[current=page]:text-ink';
const WRAP = 'mx-auto w-full max-w-[1184px] px-4 sm:px-7 xl:px-10';
const PANEL = 'overflow-hidden rounded-xl border border-border bg-background';
const LINK =
  'text-ink no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';
const TASK_PREVIEW_LIMIT = 3;

export default function ProjectRoute() {
  const { project: key = '' } = useParams();
  const paths = usePaths();
  const queue = paths.projectTasks(key);
  const board = useBoard(NO_FILTERS);
  const project = board.available.find((item) => item.key === key);
  const tasks = useOutlet(project);
  const onTasks = tasks !== null;
  const writable = writesAvailable(useCapabilities());

  const showingTasks = onTasks && project !== undefined && board.readFailure === null;
  let content: ReactNode;
  if (board.readFailure !== null) {
    content = (
      <ReadFailed
        title="Couldn't load your projects"
        error={board.readFailure}
        retrying={board.fetching}
        onRetry={() => void board.refetch()}
      />
    );
  } else if (board.catalog.isPending || (project && !onTasks && !project.ok && project.error === null)) {
    content = <PageSkeleton shape="page" />;
  } else if (!project) {
    content = (
      <EmptyState
        icon={<Layers />}
        title="Project not found"
        action={
          <Button asChild size="sm">
            <Link to={paths.board}>Go to Tasks</Link>
          </Button>
        }
      />
    );
  } else if (!onTasks && !project.ok) {
    content = (
      <ReadFailed
        title="Couldn't load this project"
        error={project.error === null ? null : new Error(project.error)}
        retrying={board.fetching}
        onRetry={() => void board.refetch()}
      />
    );
  } else if (onTasks) {
    content = tasks;
  } else {
    content = <Overview project={project} statuses={board.statuses} held={board.held} />;
  }

  return (
    <div data-project-page={key} className="flex min-h-full min-w-0 flex-col">
      {showingTasks ? null : <ProjectTitle name={project?.name ?? 'Project'} />}
      <div className="border-b border-border bg-surface">
        <TopBar
          className="h-auto min-h-16 border-b-0 pt-2 pb-1 sm:min-h-20 sm:px-7 xl:px-10"
          title={
            <div className="flex min-w-0 items-center gap-2.5 sm:gap-3.5">
              {project ? <ProjectIcon project={project} size={32} className="shrink-0 shadow-raise" /> : null}
              <h1 className="m-0 min-w-0 text-[22px]/7 font-semibold tracking-[-0.035em] text-ink [overflow-wrap:anywhere] sm:text-[28px]/9">
                {project?.name ?? 'Project'}
              </h1>
            </div>
          }
        >
          <BarSpacer />
          {!onTasks && project && writable ? (
            <Button
              asChild
              variant="primary"
              aria-label="New task"
              aria-keyshortcuts="C"
              className="shrink-0 max-sm:w-9 max-sm:px-0"
            >
              <Link to={queue} state={{ [COMPOSE_STATE]: true }}>
                <Plus aria-hidden />
                <span className="max-sm:hidden">New task</span>
                <Kbd className="max-sm:hidden">C</Kbd>
              </Link>
            </Button>
          ) : null}
        </TopBar>
        {project ? (
          <nav aria-label="Project views" className="flex gap-5 px-4 sm:gap-6 sm:px-7 xl:px-10">
            <NavLink end to={paths.project(project.key)} className={TAB}>
              <Layers aria-hidden size={15} /> Overview
            </NavLink>
            <NavLink end to={queue} className={TAB}>
              <List aria-hidden size={15} /> Tasks
            </NavLink>
          </nav>
        ) : null}
      </div>
      {showingTasks ? content : <div className={`${WRAP} pt-6 pb-10 sm:pt-8`}>{content}</div>}
    </div>
  );
}

function ProjectTitle({ name }: { name: string }) {
  usePageTitle(name);
  return null;
}

function Overview({
  project,
  statuses,
  held,
}: {
  project: BoardProject;
  statuses: ReadonlyMap<string, string>;
  held: ReadonlySet<string>;
}) {
  const paths = usePaths();
  const now = useNow();
  const hides = useAnswerHides();
  const read = useMemo(() => readEpics(project, statuses, held), [project, statuses, held]);
  const { waiting, blocked, loose } = useMemo(
    () => ({
      waiting: project.waiting.filter((task) => !hides(task.id, project.fetchedAt)),
      blocked: project.tasks.filter((task) => isWork(task) && statusMarkFor(task, statuses, held) === 'blocked'),
      loose: project.tasks.filter(
        (task) =>
          isWork(task) &&
          (task.parent === null || !read.byId.has(task.parent)) &&
          ['open', 'in-progress'].includes(statusMarkFor(task, statuses, held)),
      ),
    }),
    [project, statuses, held, hides, read],
  );
  const queue = paths.projectTasks(project.key);

  return (
    <div
      className="grid min-w-0 items-start gap-x-8 gap-y-8 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]"
      data-project-overview=""
    >
      <section aria-labelledby="project-epics" className="lg:col-start-1 lg:row-start-1">
        <OverviewHeading id="project-epics" title="Open epics" count={read.epics.length} />
        {read.epics.length > 0 ? (
          <ul className="m-0 grid list-none gap-3 p-0">
            {read.epics.map((epic) => (
              <li key={epic.id} className="min-w-0">
                <EpicCard epic={epic} />
              </li>
            ))}
          </ul>
        ) : (
          <div className={PANEL}>
            <EmptyState icon={<Layers />} title="No open epics" />
          </div>
        )}
        {read.closed.length > 0 ? <RecentlyClosed read={read} /> : null}
        {loose.length > 0 ? (
          <section aria-labelledby="project-unfiled" className="mt-6">
            <OverviewHeading id="project-unfiled" title="Work outside epics" count={loose.length} />
            <ul className={`${PANEL} m-0 list-none divide-y divide-border p-0`}>
              {loose.slice(0, TASK_PREVIEW_LIMIT).map((task) => (
                <li key={task.id}>
                  <Link
                    to={paths.task(task.id)}
                    className={`${LINK} group flex min-h-11 items-center gap-2.5 px-3.5 py-2.5 hover:bg-surface`}
                  >
                    <StatusMark status={statusMarkFor(task, statuses, held)} />
                    <span className="min-w-0 flex-1 text-label font-medium [overflow-wrap:anywhere]">{task.title}</span>
                    <span className="nums shrink-0 text-meta text-ink-3">{formatAge(ageMs(now, task.updatedAt))}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {loose.length > TASK_PREVIEW_LIMIT ? (
              <Link
                to={queue}
                className="mt-2 inline-flex items-center gap-1.5 text-label text-accent-text hover:underline"
              >
                Open task queue <ArrowRight aria-hidden size={14} />
              </Link>
            ) : null}
          </section>
        ) : null}
      </section>
      <section aria-labelledby="project-attention" className="row-start-1 lg:col-start-2">
        <OverviewHeading id="project-attention" title="Needs attention" count={waiting.length + blocked.length} />
        {waiting.length > 0 || blocked.length > 0 ? (
          <div className={PANEL}>
            <AttentionGroup
              title="Waiting for you"
              mark="waiting"
              items={waiting}
              project={project}
              more={`${queue}?view=waiting`}
            />
            <AttentionGroup
              title="Blocked"
              mark="blocked"
              items={blocked}
              project={project}
              more={`${queue}?status=blocked`}
            />
          </div>
        ) : (
          <p className={`${PANEL} m-0 p-4 text-label text-ink-2`}>No tasks are waiting for you or blocked.</p>
        )}
      </section>
    </div>
  );
}

function OverviewHeading({ id, title, count }: { id: string; title: string; count: number }) {
  return (
    <div className="mb-3 flex items-baseline gap-2.5">
      <h2 id={id} className="m-0 text-heading font-semibold text-ink">
        {title}
      </h2>
      <span className="nums text-meta text-ink-3">{formatInt(count)}</span>
    </div>
  );
}

function EpicCard({ epic }: { epic: EpicSummary }) {
  const paths = usePaths();
  const { progress, open, doneThisWeek, state } = epic;
  return (
    <Link
      to={paths.task(epic.id)}
      data-project-epic={epic.id}
      className={`${LINK} group block min-w-0 rounded-xl border border-border bg-background p-4 shadow-raise transition-colors hover:border-border-strong hover:bg-surface sm:p-5`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface text-ink-2 inset-ring inset-ring-border">
          <Layers aria-hidden size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[16px]/5 font-semibold tracking-[-0.018em] [overflow-wrap:anywhere]">{epic.title}</h3>
          <span className="nums text-meta text-ink-3">{epic.id}</span>
        </div>
        <ChevronRight aria-hidden size={16} className="shrink-0 text-ink-3 group-hover:text-ink" />
      </div>
      <div className="mt-3.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-meta">
        <span className="nums text-ink-2" data-project-epic-progress="">
          {progress === null ? (
            'Progress unavailable'
          ) : progress.total === 0 ? (
            'No tasks'
          ) : (
            <>
              <strong className="text-[20px]/6 font-semibold tracking-[-0.035em] text-ink">
                {formatInt(progress.done)}
              </strong>{' '}
              of {formatInt(progress.total)} done
            </>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-3">
          {open.waiting > 0 ? <Signal mark="waiting">{formatInt(open.waiting)} waiting for you</Signal> : null}
          {open.blocked > 0 ? <Signal mark="blocked">{formatInt(open.blocked)} blocked</Signal> : null}
          {doneThisWeek > 0 ? <span>+{formatInt(doneThisWeek)} this week</span> : null}
          {state === 'still' ? <span>No recent progress</span> : null}
          {state === 'moving' && doneThisWeek === 0 ? <span>{EPIC_STATE_LABELS[state]}</span> : null}
        </span>
      </div>
      {progress !== null && progress.total > 0 ? (
        <ProgressBar parts={progressParts(epic)} className="mt-2 h-1.75 w-full" />
      ) : null}
    </Link>
  );
}

function Signal({ mark, children }: { mark: 'waiting' | 'blocked'; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${mark === 'waiting' ? 'text-wait-text' : 'text-ink-2'}`}>
      <StatusMark status={mark} label={null} size={13} />
      {children}
    </span>
  );
}

function AttentionGroup({
  title,
  mark,
  items,
  project,
  more,
}: {
  title: string;
  mark: 'waiting' | 'blocked';
  items: readonly BoardTask[];
  project: BoardProject;
  more: string;
}) {
  const paths = usePaths();
  if (items.length === 0) return null;
  return (
    <section aria-label={title} className="border-t border-border first:border-t-0">
      <h3 className={`m-0 px-4 py-2.5 text-label font-semibold ${mark === 'waiting' ? 'bg-wait-soft' : 'bg-surface'}`}>
        <Signal mark={mark}>
          {title} <span className="nums opacity-80">{formatInt(items.length)}</span>
        </Signal>
      </h3>
      <ul className="m-0 list-none divide-y divide-border p-0">
        {items.slice(0, TASK_PREVIEW_LIMIT).map((task) => {
          const parent = task.parent === null ? undefined : project.epicNames.get(task.parent);
          return (
            <li key={task.id}>
              <Link
                to={paths.task(task.id)}
                className={`${LINK} group flex items-start gap-2.5 px-4 py-3 hover:bg-surface`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-label font-medium [overflow-wrap:anywhere]">{task.title}</span>
                  <span className="mt-0.5 block text-meta text-ink-3 [overflow-wrap:anywhere]">
                    {parent ?? task.id}
                  </span>
                </span>
                <ArrowRight aria-hidden size={14} className="mt-0.75 shrink-0 text-ink-3 group-hover:text-ink" />
              </Link>
            </li>
          );
        })}
      </ul>
      {items.length > TASK_PREVIEW_LIMIT ? (
        <Link
          to={more}
          className={`${LINK} block border-t border-border px-4 py-2.5 text-label text-accent-text hover:bg-surface`}
        >
          {mark === 'waiting' ? 'See all waiting tasks' : 'See all blocked tasks'}
        </Link>
      ) : null}
    </section>
  );
}

function RecentlyClosed({ read }: { read: EpicsRead }) {
  const paths = usePaths();
  return (
    <details className={`${PANEL} mt-4`}>
      <summary className="cursor-pointer px-4 py-2.5 text-label font-medium text-ink-2 hover:bg-surface">
        Closed this week <span className="nums ms-1 text-ink-3">{formatInt(read.closed.length)}</span>
      </summary>
      <ul className="m-0 list-none divide-y divide-border border-t border-border p-0">
        {read.closed.map((epic) => (
          <li key={epic.id}>
            <Link to={paths.task(epic.id)} className={`${LINK} flex items-center gap-2 px-4 py-2.5 hover:bg-surface`}>
              <StatusMark status="done" label={null} />
              <span className="min-w-0 flex-1 text-label [overflow-wrap:anywhere]">{epic.title}</span>
              <span className="nums shrink-0 text-meta text-ink-3 max-sm:hidden">{epic.id}</span>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
