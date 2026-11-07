import { CircleAlert, Inbox, ListFilter, Plus, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { TaskComposer } from '@/components/TaskComposer';
import { PageSkeleton, ReadFailed } from '@/components/surface';
import { Badge, Count } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { Tabs } from '@/components/ui/choice';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { Kbd } from '@/components/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { GroupHeader } from '@/components/ui/row';
import { BarSpacer, TopBar } from '@/components/ui/shell';
import { StatusMark } from '@/components/ui/symbols';
import { useBoard, type Board } from '@/hooks/useBoard';
import { useNow } from '@/hooks/useNow';
import { READ_ONLY, useAnswerHides, useCapabilities, writesAvailable } from '@/hooks/useTasks';
import { groupRows, type BoardFilters } from '@/lib/board-read';
import { ageMs, formatAge, formatInt } from '@/lib/format';
import { composeRequested, COMPOSE_STATE, searchRequested } from '@/lib/page-state';
import { PRIORITY_LABELS, STATUS_MARK_LABELS, type StatusMark as StatusMarkKey } from '@/lib/symbols';
import { actorLabel, PRIORITY_BANDS, TASK_STATUSES, type BoardTask } from '@/lib/task-model';
import { WaitingGroup } from './tasks/ask-queue';
import { TaskRow, type RowContext } from './tasks/task-row';

/** Rows a group shows per press: enough to fill a laptop screen. */
const PAGE_ROWS = 25;

/** The board's views. Waiting for you is the sidebar's; the tabs offer the rest. */
const VIEWS = ['all', 'active', 'done', 'waiting'] as const;
type View = (typeof VIEWS)[number];
const TABS: readonly { value: View; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'done', label: 'Done' },
];

/** The groups each view shows, in order; Waiting for you is drawn by its own component. */
const VIEW_GROUPS: Readonly<Record<View, readonly StatusMarkKey[]>> = {
  all: ['waiting', 'in-progress', 'open', 'blocked', 'parked', 'done'],
  active: ['waiting', 'in-progress', 'open', 'blocked'],
  done: ['done'],
  waiting: ['waiting'],
};

/** The filters a person sets in the Filter menu, each a part of the address. */
const FILTER_NAMES = ['project', 'status', 'priority', 'assignee', 'label'] as const;

function viewOf(value: string | null): View {
  return VIEWS.find((view) => view === value) ?? 'all';
}

/**
 * `/tasks`: every project's tasks on one board, grouped by status, with what
 * waits for you first and answered in place. The view, the search and the
 * filters are the address, so a narrowed board is a link; `?new=1` opens the
 * composer.
 */
export function TasksBoard() {
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const capabilities = useCapabilities();
  const writable = writesAvailable(capabilities);
  const filters: BoardFilters = {
    q: params.get('q') ?? '',
    project: params.get('project') ?? 'all',
    status: params.get('status') ?? 'all',
    priority: params.get('priority') ?? 'all',
    label: params.get('label') ?? '',
    assignee: params.get('assignee') ?? 'all',
  };
  const view = viewOf(params.get('view'));
  const composing = params.get('new') === '1' || composeRequested(location.state);
  const board = useBoard(filters);
  const hides = useAnswerHides();
  const search = useRef<HTMLInputElement>(null);
  const [phoneSearch, setPhoneSearch] = useState(false);
  const searchStamp = searchRequested(location.state);

  // `/` or the sidebar's search button asked for the search field.
  useEffect(() => {
    if (searchStamp === null) return;
    setPhoneSearch(true);
    search.current?.focus();
  }, [searchStamp]);

  function setParam(name: string, value: string) {
    const next = new URLSearchParams(params);
    // A default never occupies the address: one view, one link.
    if ((name !== 'q' && value === 'all') || value === '') next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  }

  /** Clears the search and the filters, keeping the view. */
  function clearFilters() {
    setParams(view === 'all' ? {} : { view }, { replace: true });
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
    const query = next.toString();
    void navigate({ pathname: location.pathname, search: query ? `?${query}` : '' }, { replace: true, state: null });
  }

  const searchField = (className: string, ref?: Ref<HTMLInputElement>) => (
    <Input
      ref={ref}
      type="search"
      aria-label="Search tasks"
      aria-keyshortcuts="/"
      placeholder="Search tasks"
      icon={<Search aria-hidden />}
      end={<Kbd className="max-sm:hidden">/</Kbd>}
      boxClassName={className}
      value={filters.q}
      onChange={(event) => setParam('q', event.target.value)}
      data-tasks-search=""
    />
  );

  const bar = (
    <TopBar title="Tasks">
      <Tabs
        label="View"
        items={TABS}
        value={view}
        onChange={(next) => setParam('view', next)}
        className="max-md:hidden"
      />
      <BarSpacer />
      {searchField('w-60 max-lg:w-44 max-sm:hidden', search)}
      <IconButton
        label="Search"
        className="sm:hidden"
        icon={<Search aria-hidden />}
        aria-expanded={phoneSearch}
        onClick={() => setPhoneSearch((open) => !open)}
      />
      <FilterMenu board={board} filters={filters} onPick={setParam} />
      <Button
        variant="primary"
        disabled={!writable}
        onClick={openComposer}
        aria-label="New task"
        aria-keyshortcuts="C"
        className="max-sm:w-9 max-sm:px-0"
        data-new-task=""
      >
        <Plus aria-hidden strokeWidth={2} />
        <span className="max-sm:hidden">New task</span>
        <Kbd className="max-sm:hidden">C</Kbd>
      </Button>
    </TopBar>
  );

  let body: ReactNode;
  if (board.readFailure !== null) {
    body = (
      <div className="p-6 max-sm:p-4">
        <ReadFailed
          title="Couldn't load your projects"
          error={board.readFailure}
          retrying={board.fetching}
          onRetry={() => void board.refetch()}
        />
      </div>
    );
  } else if (board.loading) {
    body = (
      <div className="p-6 max-sm:p-4">
        <PageSkeleton shape="list" />
      </div>
    );
  } else if (board.available.length === 0) {
    body = <EmptyState icon={<Inbox />} title="No projects yet" />;
  } else {
    body = <Groups board={board} view={view} filters={filters} onClear={clearFilters} hides={hides} now={now} />;
  }

  return (
    <div className="flex min-h-full flex-col" data-tasks-board="">
      {bar}
      {phoneSearch || filters.q !== '' ? (
        <div className="border-b border-border px-4 py-2 sm:hidden">{searchField('w-full')}</div>
      ) : null}
      <ActiveFilters filters={filters} board={board} onPick={setParam} onClear={clearFilters} />
      {capabilities.live && !writable ? (
        <p className="m-0 border-b border-border px-5.5 py-2 text-label text-ink-2" data-tasks-readonly="">
          {READ_ONLY}
        </p>
      ) : null}
      {board.readFailure === null && board.broken.length > 0 ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5.5 py-2 text-label text-ink"
          data-projects-unread=""
        >
          <CircleAlert aria-hidden size={15} className="text-ink-2" />
          <span className="font-medium">
            {board.broken.length === 1
              ? '1 project could not be read'
              : `${formatInt(board.broken.length)} projects could not be read`}
            :
          </span>
          <span>{board.broken.map((project) => project.name).join(', ')}</span>
          <Button size="sm" className="ms-auto" onClick={() => void board.refetch()}>
            Retry
          </Button>
        </div>
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

/** The board's groups in the view's order, each folding, each showing 25 rows a press. */
function Groups({
  board,
  view,
  filters,
  onClear,
  hides,
  now,
}: {
  board: Board;
  view: View;
  filters: BoardFilters;
  onClear: () => void;
  hides: (id: string, fetchedAt: number | null) => boolean;
  now: number;
}) {
  const [folded, setFolded] = useState<ReadonlySet<StatusMarkKey>>(() => new Set(['done']));
  const [shown, setShown] = useState<Partial<Record<StatusMarkKey, number>>>({});
  const projects = new Map(board.projects.map((project) => [project.key, project]));
  const fetchedAt = (task: BoardTask) => projects.get(task.project)?.fetchedAt ?? null;
  // An answered decision leaves its group at once, while its Undo window runs and until a later read says what the server holds.
  const inbox = board.inbox.filter((task) => !hides(task.id, fetchedAt(task)));
  const groups = groupRows(
    board.rows.filter((task) => !hides(task.id, fetchedAt(task))),
    board.statuses,
  );
  groups.waiting = [...inbox, ...groups.waiting];
  const capabilities = useCapabilities();
  const writable = writesAvailable(capabilities);
  const contextOf = (task: BoardTask): RowContext => ({
    statuses: board.statuses,
    epicProgress: projects.get(task.project)?.epicProgress ?? new Map(),
    actionable: projects.get(task.project)?.ok === true && writable,
    age: formatAge(ageMs(now, task.updatedAt)),
    nowMs: now,
  });
  const marks = VIEW_GROUPS[view].filter((mark) => groups[mark].length > 0);
  const narrowed =
    filters.q.trim() !== '' ||
    FILTER_NAMES.some((name) => (name === 'label' ? filters.label !== '' : filters[name] !== 'all'));

  if (marks.length === 0) {
    return narrowed ? (
      <EmptyState
        icon={<Search />}
        title="No tasks match these filters"
        action={
          <Button size="sm" onClick={onClear}>
            Clear filters
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<Inbox />}
        title={
          view === 'waiting' ? 'Nothing is waiting for you' : view === 'done' ? 'No tasks done lately' : 'No tasks yet'
        }
      />
    );
  }

  const more = (mark: StatusMarkKey, total: number, limit: number) =>
    total > limit ? (
      <div className="border-b border-border px-5.5 py-1.5 max-sm:px-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShown((current) => ({ ...current, [mark]: limit + PAGE_ROWS }))}
          data-tasks-more=""
        >
          Show {formatInt(Math.min(total - limit, PAGE_ROWS))} more
        </Button>
      </div>
    ) : null;

  return (
    <div className="pb-6" data-task-groups="">
      {marks.map((mark) => {
        const rows = groups[mark];
        const limit = shown[mark] ?? PAGE_ROWS;
        if (mark === 'waiting') {
          return (
            <WaitingGroup
              key={mark}
              asks={rows.slice(0, limit)}
              count={rows.length}
              contextOf={contextOf}
              writable={(task) => projects.get(task.project)?.ok === true}
              more={more(mark, rows.length, limit)}
            />
          );
        }
        // In the Done view the one group stays open.
        const open = view === 'done' || !folded.has(mark);
        return (
          <section key={mark} aria-label={STATUS_MARK_LABELS[mark]} data-group={mark}>
            <GroupHeader
              mark={<StatusMark status={mark} label={null} />}
              label={STATUS_MARK_LABELS[mark]}
              count={rows.length}
              {...(view === 'done'
                ? {}
                : {
                    open,
                    onToggle: () =>
                      setFolded((current) => {
                        const next = new Set(current);
                        if (next.has(mark)) next.delete(mark);
                        else next.add(mark);
                        return next;
                      }),
                  })}
            />
            {open ? (
              <>
                {rows.slice(0, limit).map((task) => (
                  <TaskRow key={task.id} task={task} context={contextOf(task)} />
                ))}
                {more(mark, rows.length, limit)}
              </>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/** The Filter button: a panel of the filters, each with its count. */
function FilterMenu({
  board,
  filters,
  onPick,
}: {
  board: Board;
  filters: BoardFilters;
  onPick: (name: string, value: string) => void;
}) {
  const set = FILTER_NAMES.filter((name) => (name === 'label' ? filters.label !== '' : filters[name] !== 'all')).length;
  const names = new Map(
    board.allTasks.flatMap((task) =>
      task.assignee ? [[task.assignee, actorLabel(task.assignee, task.actors)] as const] : [],
    ),
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button aria-label={set > 0 ? `Filter, ${set} set` : 'Filter'} data-tasks-filters="">
          <ListFilter aria-hidden />
          <span className="max-sm:hidden">Filter</span>
          {set > 0 ? <Count value={set} /> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-64 gap-3 p-3">
        {board.available.length > 1 ? (
          <Field label="Project">
            <Select value={filters.project} onChange={(event) => onPick('project', event.target.value)}>
              <option value="all">Every project</option>
              {board.available.map((project) => (
                <option key={project.key} value={project.key}>
                  {project.name} · {board.projectCounts.get(project.key) ?? 0}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="Status">
          <Select
            value={filters.status}
            onChange={(event) => onPick('status', event.target.value)}
            data-tasks-filter="status"
          >
            <option value="all">Any status</option>
            {TASK_STATUSES.map((status) => (
              <option key={status.key} value={status.key}>
                {status.key === 'closed' ? 'Done' : status.label} · {board.statusCounts.get(status.key) ?? 0}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={filters.priority} onChange={(event) => onPick('priority', event.target.value)}>
            <option value="all">Any priority</option>
            {PRIORITY_BANDS.map((band, index) => (
              <option key={band} value={band}>
                {PRIORITY_LABELS[index]} · {board.priorityCounts.get(band) ?? 0}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Assignee">
          <Select value={filters.assignee} onChange={(event) => onPick('assignee', event.target.value)}>
            <option value="all">Anyone</option>
            {[...board.assigneeCounts.keys()].sort().map((actor) => (
              <option key={actor} value={actor}>
                {names.get(actor) ?? actor} · {board.assigneeCounts.get(actor) ?? 0}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Label">
          <Input value={filters.label} onChange={(event) => onPick('label', event.target.value)} />
        </Field>
      </PopoverContent>
    </Popover>
  );
}

/** The filters in force, under the top bar: each one a badge that clears it, then Clear filters. */
function ActiveFilters({
  filters,
  board,
  onPick,
  onClear,
}: {
  filters: BoardFilters;
  board: Board;
  onPick: (name: string, value: string) => void;
  onClear: () => void;
}) {
  const projectName = board.available.find((project) => project.key === filters.project)?.name ?? filters.project;
  const assignee =
    filters.assignee === 'all'
      ? null
      : actorLabel(filters.assignee, board.allTasks.find((task) => task.assignee === filters.assignee)?.actors);
  const statusLabel =
    filters.status === 'closed'
      ? 'Done'
      : (TASK_STATUSES.find((status) => status.key === filters.status)?.label ?? filters.status);
  const priority = PRIORITY_LABELS[PRIORITY_BANDS.findIndex((band) => band === filters.priority)] ?? filters.priority;
  const set = [
    filters.project !== 'all' ? { name: 'project', text: `Project: ${projectName}` } : null,
    filters.status !== 'all' ? { name: 'status', text: `Status: ${statusLabel}` } : null,
    filters.priority !== 'all' ? { name: 'priority', text: `Priority: ${priority}` } : null,
    assignee !== null ? { name: 'assignee', text: `Assignee: ${assignee}` } : null,
    filters.label !== '' ? { name: 'label', text: `Label: ${filters.label}` } : null,
  ].filter((entry) => entry !== null);
  if (set.length === 0 && filters.q.trim() === '') return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-b border-border px-5.5 py-1.5 max-sm:px-4"
      data-active-filters=""
    >
      {set.map((entry) => (
        <button
          key={entry.name}
          type="button"
          className="rounded-full outline-none focus-visible:outline-2 focus-visible:outline-accent"
          aria-label={`Clear ${entry.text}`}
          onClick={() => onPick(entry.name, '')}
        >
          <Badge icon={<X aria-hidden size={12} className="text-ink-3" />}>{entry.text}</Badge>
        </button>
      ))}
      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}

export default TasksBoard;
