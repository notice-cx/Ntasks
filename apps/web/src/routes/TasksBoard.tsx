import { useEffect, useState, type ReactNode } from 'react';
import { LoaderCircle, Plus } from 'lucide-react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { TaskComposer } from '@/components/TaskComposer';
import { EmptyState, FinishLine, PageAnswer, PageSkeleton, ReadFailed, SectionLabel } from '@/components/surface';
import { Button } from '@/components/ui/button';
import { fieldClass, inlineLinkClass, pillControlClass } from '@/components/ui/chrome';
import { useBoard } from '@/hooks/useBoard';
import { useNow } from '@/hooks/useNow';
import {
  fieldAvailable,
  operationAvailable,
  READ_ONLY,
  useAnswerHides,
  useCapabilities,
  useClaimTask,
  useCloseTask,
  useUpdateTask,
  writesAvailable,
} from '@/hooks/useTasks';
import { type BoardFilters, type BoardProject } from '@/lib/board-read';
import { ageMs, countLabel, formatAge, formatInt } from '@/lib/format';
import { actorLabel, PARKED, PRIORITY_BANDS, priorityBand, TASK_STATUSES, type BoardTask } from '@/lib/task-model';
import { taskPath } from '@/lib/task-path';
import { cn } from '@/lib/utils';
import { AskQueue } from './tasks/ask-queue';
import { closeOperation, declinedOnClose, useCloseAs } from './tasks/close-actions';
import { PriorityMark, RestingMark, TaskStatusMark } from './tasks/task-face';

/** Rows per press: enough to fill a laptop screen. */
const PAGE_ROWS = 25;
/** Location state that opens the composer without changing the address. */
export const COMPOSE_STATE = 'newTask';

function composeRequested(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as Record<string, unknown>)[COMPOSE_STATE] === true;
}

/**
 * `/tasks`: every project's tasks on one board. It opens on what waits on you,
 * then the full list. The filters are the address, so a narrowed board is a
 * link; `?new=1` opens the composer.
 */
export function TasksBoard() {
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const capabilities = useCapabilities();
  const writable = writesAvailable(capabilities);
  const [shown, setShown] = useState(PAGE_ROWS);
  const filters: BoardFilters = {
    q: params.get('q') ?? '',
    project: params.get('project') ?? 'all',
    status: params.get('status') ?? 'all',
    priority: params.get('priority') ?? 'all',
    label: params.get('label') ?? '',
    assignee: params.get('assignee') ?? 'all',
  };
  const composing = params.get('new') === '1' || composeRequested(location.state);
  const board = useBoard(filters, now);
  const hides = useAnswerHides();

  // Narrowing the board starts it again at the first page.
  const filterKey = JSON.stringify(filters);
  useEffect(() => setShown(PAGE_ROWS), [filterKey]);

  function setParam(name: string, value: string) {
    const next = new URLSearchParams(params);
    // A default never occupies the address: one view, one link.
    if ((name !== 'q' && value === 'all') || value === '') next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  }

  function openComposer() {
    void navigate(
      { pathname: location.pathname, search: location.search },
      { replace: true, state: { [COMPOSE_STATE]: true } },
    );
  }

  function closeComposer() {
    const next = new URLSearchParams(params);
    next.delete('new');
    const search = next.toString();
    void navigate({ pathname: location.pathname, search: search ? `?${search}` : '' }, { replace: true, state: null });
  }

  const fetchedAt = (task: BoardTask) =>
    board.projects.find((project) => project.key === task.project)?.fetchedAt ?? null;
  // An answered decision leaves the list at once, while its Undo window runs and until a later read says what the server holds.
  const inbox = board.inbox.filter((task) => !hides(task.id, fetchedAt(task)));
  const rows = board.rows.filter((task) => !hides(task.id, fetchedAt(task)));
  const answered = board.inbox.length - inbox.length;
  const waiting = Math.max(0, board.totals.waiting - answered);
  const narrowed =
    filters.project !== 'all' ||
    filters.status !== 'all' ||
    filters.priority !== 'all' ||
    filters.label !== '' ||
    filters.assignee !== 'all' ||
    filters.q.trim() !== '';
  const partial = !board.complete;
  const projectNames = new Map(board.available.map((project) => [project.key, project.name]));
  const readable = new Set(board.projects.filter((project) => project.ok).map((project) => project.key));

  const newTask = (
    <Button type="button" disabled={!writable} onClick={openComposer} data-new-task="">
      <Plus aria-hidden />
      New task
    </Button>
  );

  let body: ReactNode;
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
  } else if (board.available.length === 0) {
    body = <EmptyState title="No projects yet" hint="A project appears here once it is created through the API." />;
  } else {
    const nothingWaits = waiting === 0 && board.complete;
    const detail = [
      board.totals.approvals > 0
        ? `${formatInt(board.totals.approvals)} ${board.totals.approvals === 1 ? 'needs' : 'need'} your approval`
        : null,
      `${countLabel(board.totals.open, partial)} open ${board.totals.open === 1 ? 'task' : 'tasks'}`,
    ]
      .filter(Boolean)
      .join(' · ');
    body = (
      <>
        <div className="flex flex-col gap-5" data-surface-hero="">
          <PageAnswer
            answer={
              nothingWaits
                ? 'No decisions for you'
                : `${countLabel(waiting, partial)} ${waiting === 1 && !partial ? 'decision' : 'decisions'} for you`
            }
            detail={detail}
            figures={[
              { label: 'Urgent', value: countLabel(board.totals.urgent, partial), mark: 'tasks-urgent' },
              { label: 'Blocked', value: countLabel(board.totals.blocked, partial), mark: 'tasks-blocked' },
              { label: 'Done this week', value: countLabel(board.totals.doneThisWeek, partial), mark: 'tasks-done' },
            ]}
            marks={{ 'data-tasks-answer': nothingWaits ? 'clear' : 'waiting' }}
          />
          <WorkingNow tasks={board.allTasks} />
          {nothingWaits && inbox.length === 0 ? null : (
            <div className="flex flex-col gap-3" data-waiting-list="">
              <AskQueue
                asks={inbox}
                projectNames={projectNames}
                nowMs={now}
                showProject={board.available.length > 1}
                writable={(task) => readable.has(task.project)}
              />
              {inbox.length > 0 && board.complete ? (
                <FinishLine
                  line="That's every decision for you."
                  age={board.readAt ? `read ${formatAge(ageMs(now, board.readAt))} ago` : null}
                />
              ) : null}
            </div>
          )}
        </div>

        {board.broken.length > 0 ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-warn/30 bg-warn-soft px-4 py-2.5 text-sm"
            data-projects-unread=""
          >
            <span className="text-foreground">
              <span className="font-medium">
                {board.broken.length === 1
                  ? '1 project could not be read'
                  : `${formatInt(board.broken.length)} projects could not be read`}
                :{' '}
              </span>
              {board.broken.map((project) => project.name).join(', ')}. Its counts above are lower bounds.
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => void board.refetch()}>
              Retry
            </Button>
          </div>
        ) : null}

        <Filters
          board={board}
          value={filters}
          narrowed={narrowed}
          onPick={setParam}
          aside={
            board.pending.length > 0 ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" role="status">
                <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden />
                Loading
              </span>
            ) : board.readAt ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                read {formatAge(ageMs(now, board.readAt))} ago
              </span>
            ) : null
          }
        />

        <AllTasks
          rows={rows}
          shown={shown}
          onMore={() => setShown((count) => count + PAGE_ROWS)}
          total={board.allTasks.filter((task) => task.issueType !== 'epic' && task.issueType !== 'gate').length}
          narrowed={narrowed}
          partial={partial}
          projects={new Map(board.projects.map((project) => [project.key, project]))}
          nowMs={now}
          showProject={board.available.length > 1}
        />
      </>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 md:p-6" data-tasks-board="">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel
          title="Tasks"
          caption={
            board.available.length > 0
              ? `${formatInt(board.available.length)} ${board.available.length === 1 ? 'project' : 'projects'}`
              : undefined
          }
        />
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <Link to="/tasks/focus" state={{ returnTo: `${location.pathname}${location.search}` }} data-focus-link="">
              Focus
            </Link>
          </Button>
          {newTask}
        </div>
      </div>
      {capabilities.live && !writable ? (
        <p
          className="m-0 rounded-[10px] border border-border bg-muted/50 px-4 py-2.5 text-sm text-muted-foreground"
          data-tasks-readonly=""
        >
          {READ_ONLY}
        </p>
      ) : null}
      {composing ? (
        <TaskComposer
          open
          onClose={closeComposer}
          projects={board.catalog.data ?? []}
          loading={board.catalog.isPending}
          prefill={filters.project === 'all' ? null : { project: filters.project }}
        />
      ) : null}
      {body}
    </div>
  );
}

/** Who holds work right now, busiest first. */
function WorkingNow({ tasks }: { tasks: readonly BoardTask[] }) {
  const counts = new Map<string, { name: string; n: number }>();
  for (const task of tasks) {
    if (task.status !== 'in_progress' || !task.assignee) continue;
    const entry = counts.get(task.assignee) ?? { name: actorLabel(task.assignee, task.actors), n: 0 };
    counts.set(task.assignee, { ...entry, n: entry.n + 1 });
  }
  const working = [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  if (working.length === 0) return null;
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm" data-tasks-working="">
      <span className="text-muted-foreground">Working now</span>
      {working.map((entry) => (
        <span key={entry.name}>
          <span className="font-medium text-foreground">{entry.name}</span>{' '}
          <span className="tabular-nums text-muted-foreground">{formatInt(entry.n)}</span>
        </span>
      ))}
    </p>
  );
}

/** Six controls in one row, each one a part of the address. Each option carries its count. */
function Filters({
  board,
  value,
  narrowed,
  onPick,
  aside,
}: {
  board: ReturnType<typeof useBoard>;
  value: BoardFilters;
  narrowed: boolean;
  onPick: (name: string, value: string) => void;
  aside: ReactNode;
}) {
  const assignees = [...board.assigneeCounts.keys()].sort();
  const names = new Map(
    board.allTasks.flatMap((task) =>
      task.assignee ? [[task.assignee, actorLabel(task.assignee, task.actors)] as const] : [],
    ),
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-tasks-filters="">
      <label className="sr-only" htmlFor="tasks-search">
        Search task titles and ids
      </label>
      <input
        id="tasks-search"
        type="search"
        className={cn(fieldClass, 'w-56 max-w-full')}
        placeholder="Title or id…"
        value={value.q}
        onChange={(event) => onPick('q', event.target.value)}
      />
      {board.available.length < 2 && value.project === 'all' ? null : (
        <>
          <label className="sr-only" htmlFor="tasks-project">
            Project
          </label>
          <select
            id="tasks-project"
            className={fieldClass}
            value={value.project}
            onChange={(event) => onPick('project', event.target.value)}
          >
            <option value="all">Every project</option>
            {board.available.map((project) => (
              <option key={project.key} value={project.key}>
                {project.name} · {board.projectCounts.get(project.key) ?? 0}
              </option>
            ))}
          </select>
        </>
      )}
      <label className="sr-only" htmlFor="tasks-status">
        Status
      </label>
      <select
        id="tasks-status"
        className={fieldClass}
        value={value.status}
        onChange={(event) => onPick('status', event.target.value)}
        data-tasks-filter="status"
      >
        <option value="all">Any status</option>
        {TASK_STATUSES.map((status) => (
          <option key={status.key} value={status.key}>
            {status.key === 'closed' ? 'Closed, last 7 days' : status.label} · {board.statusCounts.get(status.key) ?? 0}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="tasks-priority">
        Priority
      </label>
      <select
        id="tasks-priority"
        className={fieldClass}
        value={value.priority}
        onChange={(event) => onPick('priority', event.target.value)}
      >
        <option value="all">Any priority</option>
        {PRIORITY_BANDS.map((band) => (
          <option key={band} value={band}>
            {band} · {board.priorityCounts.get(band) ?? 0}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="tasks-assignee">
        Assignee
      </label>
      <select
        id="tasks-assignee"
        className={fieldClass}
        value={value.assignee}
        onChange={(event) => onPick('assignee', event.target.value)}
      >
        <option value="all">Anyone</option>
        {assignees.map((name) => (
          <option key={name} value={name}>
            {names.get(name) ?? name} · {board.assigneeCounts.get(name) ?? 0}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="tasks-label">
        Label
      </label>
      <input
        id="tasks-label"
        type="search"
        className={cn(fieldClass, 'w-40')}
        placeholder="Label…"
        value={value.label}
        onChange={(event) => onPick('label', event.target.value)}
      />
      {narrowed ? (
        <Link
          to={{ search: '' }}
          replace
          className={cn(inlineLinkClass, 'text-xs font-medium max-sm:inline-flex max-sm:items-center max-sm:px-2')}
        >
          Clear filters
        </Link>
      ) : null}
      {aside ? <span className="ms-auto inline-flex items-center gap-2">{aside}</span> : null}
    </div>
  );
}

/** Every task, one line each, 25 at a time. A row opens in place for its verbs; its id is the link to its page. */
function AllTasks({
  rows,
  shown,
  onMore,
  total,
  narrowed,
  partial,
  projects,
  nowMs,
  showProject,
}: {
  rows: BoardTask[];
  shown: number;
  onMore: () => void;
  total: number;
  narrowed: boolean;
  partial: boolean;
  projects: ReadonlyMap<string, BoardProject>;
  nowMs: number;
  showProject: boolean;
}) {
  const page = rows.slice(0, shown);
  const remaining = rows.length - page.length;
  return (
    <section
      className="flex flex-col rounded-[10px] border border-border bg-card"
      aria-labelledby="all-tasks-title"
      data-tasks-table=""
    >
      <SectionLabel
        id="all-tasks-title"
        title="All tasks"
        caption={
          <span data-tasks-summary="">
            {countLabel(rows.length, partial)}
            {narrowed ? ` of ${countLabel(total, partial)}` : ''}
          </span>
        }
        className="px-4 pb-2 pt-3"
      />
      {rows.length === 0 ? (
        <p className="m-0 px-4 pb-4 text-xs text-muted-foreground">
          {total === 0
            ? 'Nothing is queued.'
            : narrowed
              ? 'No task matches these filters.'
              : 'Every other task is in your decisions above.'}
        </p>
      ) : (
        <div className="px-2 pb-1">
          <table className="w-full border-collapse text-start">
            <thead className="max-sm:sr-only">
              <tr className="text-start">
                <th scope="col" className="px-2 py-1.5 text-start text-xs font-medium text-muted-foreground">
                  Task
                </th>
                <th
                  scope="col"
                  className="whitespace-nowrap px-2 py-1.5 text-start text-xs font-medium text-muted-foreground"
                >
                  Id
                </th>
                {showProject ? (
                  <th
                    scope="col"
                    className="whitespace-nowrap px-2 py-1.5 text-start text-xs font-medium text-muted-foreground"
                  >
                    Project
                  </th>
                ) : null}
                <th
                  scope="col"
                  className="whitespace-nowrap px-2 py-1.5 text-start text-xs font-medium text-muted-foreground"
                >
                  Who
                </th>
                <th
                  scope="col"
                  className="whitespace-nowrap px-2 py-1.5 text-end text-xs font-medium text-muted-foreground"
                >
                  Age
                </th>
                <th
                  scope="col"
                  className="whitespace-nowrap px-2 py-1.5 text-start text-xs font-medium text-muted-foreground"
                >
                  State
                </th>
                <th scope="col">
                  <span className="sr-only">Close</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {page.map((task) => (
                <BoardRow
                  key={task.id}
                  task={task}
                  project={projects.get(task.project) ?? null}
                  nowMs={nowMs}
                  showProject={showProject}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {remaining > 0 ? (
        <div className="border-t border-border/60 p-2">
          <Button type="button" variant="ghost" className="w-full" onClick={onMore} data-tasks-more="">
            Load {formatInt(Math.min(remaining, PAGE_ROWS))} more · {formatInt(remaining)} left
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** A finished or parked row wears its status glyph; live work its priority mark. */
function RowMark({ task }: { task: BoardTask }) {
  return task.status === 'closed' || task.status === PARKED ? (
    <RestingMark status={task.status} />
  ) : (
    <PriorityMark priority={task.priority} />
  );
}

function BoardRow({
  task,
  project,
  nowMs,
  showProject,
}: {
  task: BoardTask;
  project: BoardProject | null;
  nowMs: number;
  showProject: boolean;
}) {
  const [open, setOpen] = useState(false);
  const capabilities = useCapabilities();
  const actionable = project?.ok === true && writesAvailable(capabilities);
  const closable = task.status !== 'closed' && actionable && operationAvailable(capabilities, closeOperation(task));
  const closeAs = useCloseAs({
    id: task.id,
    title: task.title,
    project: task.project,
    ...(declinedOnClose(task) ? { via: 'dismiss' as const } : {}),
  });
  const holder = task.assignee ? actorLabel(task.assignee, task.actors) : null;
  const age = formatAge(ageMs(nowMs, task.updatedAt));
  const columns = showProject ? 7 : 6;
  return (
    <>
      <tr className="group/task border-t border-border/50 align-top" data-task-row={task.id}>
        <td className="w-full max-w-0 py-1 ps-1 max-sm:max-w-none">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className={cn(
              'flex w-full items-start gap-2.5 rounded-md p-1 text-start hover:bg-muted/40',
              pillControlClass,
            )}
          >
            <RowMark task={task} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="min-w-0 text-[13px] text-foreground [overflow-wrap:anywhere]">{task.title}</span>
              <span className="text-[11px] text-muted-foreground sm:hidden">
                <span className="font-mono">{task.id}</span> · {statusWord(task)} · {holder ?? 'nobody'} · {age}
              </span>
            </span>
          </button>
        </td>
        <td className="whitespace-nowrap px-2 py-1.5 max-sm:hidden">
          <Link
            to={taskPath(task.id)}
            className="font-mono text-[11px] tabular-nums text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {task.id}
          </Link>
        </td>
        {showProject ? (
          <td className="min-w-28 max-w-[10rem] px-2 py-1.5 text-xs text-muted-foreground max-sm:hidden">
            {project?.name ?? task.project}
          </td>
        ) : null}
        <td
          className="min-w-24 max-w-[9rem] whitespace-nowrap px-2 py-1.5 text-xs max-sm:hidden"
          data-task-holder={task.assignee ?? ''}
        >
          {holder ? (
            <span className="font-medium text-foreground">{holder}</span>
          ) : (
            <span className="text-muted-foreground">nobody</span>
          )}
        </td>
        <td className="whitespace-nowrap px-2 py-1.5 text-end text-xs tabular-nums text-muted-foreground max-sm:hidden">
          {age}
        </td>
        <td className="whitespace-nowrap px-2 py-1.5 max-sm:hidden">
          <TaskStatusMark status={task.status} />
        </td>
        <td className="whitespace-nowrap py-0.5 pe-1 text-end max-sm:hidden">
          {closable ? (
            <span className="inline-flex opacity-50 transition-opacity group-hover/task:opacity-100 group-focus-within/task:opacity-100 has-[[aria-expanded=true]]:opacity-100">
              {closeAs.menu}
            </span>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr data-task-detail={task.id}>
          <td colSpan={columns} className="px-3 pb-2.5 max-sm:px-2">
            <RowDetail
              task={task}
              epic={task.parent ? (project?.epicNames.get(task.parent) ?? null) : null}
              actionable={actionable}
              closeMenu={closable ? closeAs.menu : null}
            />
          </td>
        </tr>
      ) : null}
      {closeAs.box ? (
        <tr>
          <td colSpan={columns} className="px-3 pb-2.5 max-sm:px-2">
            <div className="rounded-md bg-muted/40 p-2.5">{closeAs.box}</div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function statusWord(task: BoardTask): string {
  return TASK_STATUSES.find((status) => status.stored === task.status)?.label ?? task.status;
}

/** What an open row shows: the facts a one-line row could not carry, then its verbs, inline. A close's reason is required: it is the evidence. */
function RowDetail({
  task,
  epic,
  actionable,
  closeMenu,
}: {
  task: BoardTask;
  epic: string | null;
  actionable: boolean;
  closeMenu: ReactNode;
}) {
  const capabilities = useCapabilities();
  const [mode, setMode] = useState<null | 'close' | 'defer'>(null);
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const claim = useClaimTask();
  const close = useCloseTask();
  const update = useUpdateTask();
  const busy = claim.isPending || close.isPending || update.isPending;
  const done = task.status === 'closed';
  const band = priorityBand(task.priority);

  async function act(what: 'claim' | 'close' | 'defer') {
    if (!actionable) return;
    try {
      if (what === 'claim') await claim.mutateAsync({ id: task.id, project: task.project });
      else if (what === 'close') await close.mutateAsync({ id: task.id, project: task.project, reason: reason.trim() });
      else await update.mutateAsync({ id: task.id, project: task.project, edit: { defer: until } });
    } catch (error) {
      toast.error(error instanceof Error && error.message !== '' ? error.message : `Could not ${what} ${task.id}`);
      return;
    }
    toast.success(
      what === 'claim'
        ? `Claimed ${task.id}`
        : what === 'close'
          ? `Closed ${task.id}`
          : `Parked ${task.id} until ${until}`,
    );
    setReason('');
    setUntil('');
    setMode(null);
  }

  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {epic && task.parent ? (
          <span>
            Part of{' '}
            <Link to={taskPath(task.parent)} className={inlineLinkClass}>
              {epic}
            </Link>
          </span>
        ) : null}
        <span>Priority {band}</span>
        {task.assignee ? <span>Claimed by {actorLabel(task.assignee, task.actors)}</span> : null}
        {task.deferUntil ? <span>Parked until {task.deferUntil.slice(0, 10)}</span> : null}
        {task.labels.length > 0 ? <span className="font-mono">{task.labels.join(' ')}</span> : null}
      </div>
      {mode === null ? (
        <div className="flex flex-wrap items-center gap-2">
          {done ? null : (
            <>
              <Button
                type="button"
                size="sm"
                disabled={!actionable || busy || !fieldAvailable(capabilities, 'claim') || task.assignee !== null}
                onClick={() => void act('claim')}
                data-task-action="claim"
              >
                Claim
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!actionable || busy || !operationAvailable(capabilities, 'close')}
                onClick={() => setMode('close')}
                data-task-action="close"
              >
                Close…
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!actionable || busy || !fieldAvailable(capabilities, 'defer')}
                onClick={() => setMode('defer')}
                data-task-action="defer"
              >
                Park…
              </Button>
              <span className="sm:hidden">{closeMenu}</span>
            </>
          )}
          <Link to={taskPath(task.id)} className={cn(inlineLinkClass, 'font-medium')}>
            Open task →
          </Link>
        </div>
      ) : null}
      {mode === 'close' ? (
        <form
          className="flex flex-col gap-2"
          data-task-form="close"
          onSubmit={(event) => {
            event.preventDefault();
            void act('close');
          }}
        >
          <input
            type="text"
            autoFocus
            className={cn(fieldClass, 'w-full')}
            aria-label={`Why ${task.id} is closed`}
            placeholder="Evidence: a commit, a link, what proves it"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={busy || reason.trim() === ''} data-task-confirm="close">
              Close task
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {mode === 'defer' ? (
        <form
          className="flex flex-col gap-2"
          data-task-form="defer"
          onSubmit={(event) => {
            event.preventDefault();
            void act('defer');
          }}
        >
          <input
            type="date"
            autoFocus
            className={cn(fieldClass, 'w-full')}
            aria-label={`Park ${task.id} until`}
            value={until}
            onChange={(event) => setUntil(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={busy || until === ''} data-task-confirm="defer">
              Park it
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

export default TasksBoard;
