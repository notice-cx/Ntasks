import { CircleAlert, Inbox, ListFilter, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { TaskComposer } from '../components/TaskComposer';
import { PageSkeleton, ReadFailed } from '../components/surface';
import { Badge, Count } from '../components/ui/badge';
import { Button, IconButton } from '../components/ui/button';
import { Tabs } from '../components/ui/choice';
import { EmptyState } from '../components/ui/empty-state';
import { Field, Input, Select } from '../components/ui/field';
import { Kbd } from '../components/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { GroupHeader } from '../components/ui/row';
import { BarSpacer, TopBar } from '../components/ui/shell';
import { StatusMark } from '../components/ui/symbols';
import type { FieldFilters, LiveTask, TaskField } from '../api/types';
import { useBoard, type Board } from '../hooks/useBoard';
import { useMedia } from '../hooks/useMedia';
import { useNow } from '../hooks/useNow';
import { READ_ONLY, useAnswerHides, useCapabilities, useProjectFields, writesAvailable } from '../hooks/useTasks';
import {
  FIELD_FILTER_PREFIX,
  fieldFiltersOf,
  groupRows,
  isWork,
  NO_FILTERS,
  type BoardFilters,
} from '../lib/board-read';
import { readEpics } from '../lib/epics';
import { fieldMatches, filterValueText, isKnownFieldType } from '../lib/custom-fields';
import { ageMs, fieldKeyName, formatAge, formatInt } from '../lib/format';
import { composeRequested, COMPOSE_STATE, searchRequested } from '../lib/page-state';
import { PRIORITY_LABELS, STATUS_MARK_LABELS, type StatusMark as StatusMarkKey } from '../lib/symbols';
import { actorLabel, PRIORITY_BANDS, TASK_STATUSES, type BoardTask } from '../lib/task-model';
import { WaitingGroup } from './tasks/ask-queue';
import { DELIVERY_GROUPS, DeliveryGroup, useDeliveryWaits } from './tasks/delivery-groups';
import { EpicsSummary, EpicsView } from './tasks/epics-view';
import { SortMenu } from './tasks/sort-menu';
import { sorted, sortOf, sortParams, type PageSort } from '../lib/task-sort';
import { TaskRow, type RowContext } from './tasks/task-row';

/** Tailwind's `max-sm`: below it the top bar has no room for the search field. */
const PHONE = '(width < 40rem)';

/** Tailwind's `max-md`: below it the top bar has no room for the views. */
const NARROW = '(width < 48rem)';

/** Rows a group shows per press: enough to fill a laptop screen. */
const PAGE_ROWS = 25;

/** The board's views. Waiting for you is the sidebar's; the tabs offer the rest, and Epics while one project is in view. */
const VIEWS = ['all', 'active', 'done', 'waiting', 'epics'] as const;
type View = (typeof VIEWS)[number];
type TaskView = Exclude<View, 'epics'>;
const TABS: readonly { value: View; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'done', label: 'Done' },
];
const EPICS_TAB: { value: View; label: string } = { value: 'epics', label: 'Epics' };

/** The groups each view of tasks shows, in order; Waiting for you is drawn by its own component. */
const VIEW_GROUPS: Readonly<Record<TaskView, readonly StatusMarkKey[]>> = {
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
 * The board, at the base path itself: every project's tasks on one board,
 * grouped by status, with what waits for you first and answered in place.
 * The view, the search and the filters are the address, so a narrowed board
 * is a link; `?new=1` opens the composer.
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
    fields: fieldFiltersOf(params),
  };
  const asked = viewOf(params.get('view'));
  const sort = sortOf(params);
  const composing = params.get('new') === '1' || composeRequested(location.state);
  // A filter by custom field narrows the server's read to the tasks holding the value, which would shrink every
  // epic's counts; the Epics view reads the whole project and keeps those filters in the address for the task views.
  const board = useBoard(asked === 'epics' ? { ...filters, fields: {} } : filters);
  // Epics are one project's: the tab is offered, and its address honoured, only while one project is in view.
  const epicsProject = board.projects.length === 1 && board.fieldProject !== null ? (board.projects[0] ?? null) : null;
  const epicsView = asked === 'epics' && epicsProject !== null;
  const view: TaskView = asked === 'epics' ? 'all' : asked;
  const tabs = epicsProject === null ? TABS : [...TABS, EPICS_TAB];
  const tabValue: View = epicsView ? 'epics' : view;
  // One set of views: in the top bar, or below 768 px on a row of its own under it.
  const narrow = useMedia(NARROW);
  const views = <Tabs label="View" items={tabs} value={tabValue} onChange={(next) => setParam('view', next)} />;
  const epics = useMemo(
    () =>
      epicsView && epicsProject !== null && epicsProject.ok
        ? readEpics(epicsProject, board.statuses, board.held)
        : null,
    [epicsView, epicsProject, board.statuses, board.held],
  );
  const fieldDefinitions = useProjectFields(board.fieldProject).data?.fields ?? [];
  // A filter by custom field holds only while its project is the one in view.
  const fieldFilters = board.fieldProject === null ? {} : filters.fields;
  const hides = useAnswerHides();
  const search = useRef<HTMLInputElement>(null);
  const phoneField = useRef<HTMLInputElement>(null);
  const [phoneSearch, setPhoneSearch] = useState(false);
  // A request to focus the phone's field, kept until the field has mounted.
  const [focusPhone, setFocusPhone] = useState<number | null>(null);
  const searchStamp = searchRequested(location.state);

  // `/` or the sidebar's search button asked for the search field: the top
  // bar's, or on a phone, where the top bar has no room for it, the field under it.
  useEffect(() => {
    if (searchStamp === null) return;
    if (window.matchMedia(PHONE).matches) {
      setPhoneSearch(true);
      setFocusPhone(searchStamp);
    } else search.current?.focus();
  }, [searchStamp]);
  useEffect(() => {
    if (focusPhone !== null) phoneField.current?.focus();
  }, [focusPhone]);

  function setParam(name: string, value: string) {
    const next = new URLSearchParams(params);
    const field = name.startsWith(FIELD_FILTER_PREFIX);
    // A default never occupies the address: one view, one link. A field's value is never a default.
    if ((name !== 'q' && !field && value === 'all') || value === '') next.delete(name);
    else next.set(name, value);
    // Each project defines its own fields, so another project drops the filters by them.
    if (name === 'project') {
      for (const key of [...next.keys()]) if (key.startsWith(FIELD_FILTER_PREFIX)) next.delete(key);
    }
    setParams(next, { replace: true });
  }

  /** Clears the search and the filters, keeping the view of tasks and the sort; Epics, being one project's, goes with the project. */
  function clearFilters() {
    const kept = new URLSearchParams(asked === 'all' || asked === 'epics' ? {} : { view: asked });
    for (const name of ['sort', 'dir']) {
      const value = params.get(name);
      if (value !== null) kept.set(name, value);
    }
    setParams(kept, { replace: true });
  }

  /** Puts the sort chosen in the address; each list's own order takes none. */
  function pickSort(next: PageSort | null) {
    const query = new URLSearchParams(params);
    for (const [name, value] of Object.entries(sortParams(next))) {
      if (value === '') query.delete(name);
      else query.set(name, value);
    }
    setParams(query, { replace: true });
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
      {narrow ? null : views}
      {epics !== null ? <EpicsSummary read={epics} /> : null}
      <BarSpacer />
      {searchField('w-60 max-lg:w-44 max-sm:hidden', search)}
      <IconButton
        label="Search"
        className="sm:hidden"
        icon={<Search aria-hidden />}
        aria-expanded={phoneSearch}
        onClick={() => {
          if (!phoneSearch) setFocusPhone(Date.now());
          setPhoneSearch(!phoneSearch);
        }}
      />
      <SortMenu sort={sort} onPick={pickSort} />
      {epicsView ? null : (
        <FilterMenu
          board={board}
          filters={filters}
          fieldFilters={fieldFilters}
          fields={fieldDefinitions}
          onPick={setParam}
        />
      )}
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
  } else if (epicsView) {
    body =
      epics === null ? (
        <EmptyState icon={<CircleAlert />} title="This project's tasks could not be read" />
      ) : (
        <EpicsView read={epics} q={filters.q} sort={sort} nowMs={now} onClearSearch={() => setParam('q', '')} />
      );
  } else {
    body = (
      <Groups
        board={board}
        view={view}
        filters={filters}
        narrowedByFields={Object.keys(fieldFilters).length > 0}
        onClear={clearFilters}
        hides={hides}
        now={now}
        sort={sort}
      />
    );
  }

  return (
    <div className="flex min-h-full flex-col" data-tasks-board="">
      {bar}
      {narrow ? (
        <div className="border-b border-border px-4 py-1.5" data-narrow-views="">
          {views}
        </div>
      ) : null}
      {phoneSearch || filters.q !== '' ? (
        <div className="border-b border-border px-4 py-2 sm:hidden" data-phone-search="">
          {searchField('w-full', phoneField)}
        </div>
      ) : null}
      <ActiveFilters
        // The filters other than the project and the search narrow tasks, so the Epics view sets them aside.
        filters={epicsView ? { ...NO_FILTERS, project: filters.project, q: filters.q } : filters}
        fieldFilters={epicsView ? {} : fieldFilters}
        fields={fieldDefinitions}
        board={board}
        onPick={setParam}
        onClear={clearFilters}
      />
      {capabilities.live && !writable ? (
        <p className="m-0 border-b border-border px-5.5 py-2 text-label text-ink-2" data-tasks-readonly="">
          {READ_ONLY}
        </p>
      ) : null}
      {board.readFailure === null && board.broken.length > 0 ? (
        <ReadBanner
          title={`${
            board.broken.length === 1
              ? '1 project could not be read'
              : `${formatInt(board.broken.length)} projects could not be read`
          }:`}
          onRetry={() => void board.refetch()}
          data-projects-unread=""
        >
          {board.broken.map((project) => project.name).join(', ')}
        </ReadBanner>
      ) : null}
      {board.searchFailure !== null ? (
        <ReadBanner title="Couldn't search every project" onRetry={() => void board.refetch()} data-search-failed="" />
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

/** A line across the board saying what could not be read, with a way to read it again. */
function ReadBanner({
  title,
  children,
  onRetry,
  ...data
}: {
  title: string;
  children?: ReactNode;
  onRetry: () => void;
} & Record<`data-${string}`, string>) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5.5 py-2 text-label text-ink"
      {...data}
    >
      <CircleAlert aria-hidden size={15} className="text-ink-2" />
      <span className="font-medium">{title}</span>
      {children === undefined ? null : <span>{children}</span>}
      <Button size="sm" className="ms-auto" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** The board's groups in the view's order, each folding, each showing 25 rows a press. */
function Groups({
  board,
  view,
  filters,
  narrowedByFields,
  onClear,
  hides,
  now,
  sort,
}: {
  board: Board;
  view: TaskView;
  filters: BoardFilters;
  /** A filter by custom field holds, which the server applied. */
  narrowedByFields: boolean;
  onClear: () => void;
  hides: (id: string, fetchedAt: number | null) => boolean;
  now: number;
  /** The order chosen in the Sort menu; null keeps each group's own. */
  sort: PageSort | null;
}) {
  // A search opens Done too, since a pasted id is often a closed task's; each keeps its own folds.
  const searched = filters.q.trim() !== '';
  const [boardFolds, setBoardFolds] = useState<ReadonlySet<StatusMarkKey>>(() => new Set(['done']));
  const [searchFolds, setSearchFolds] = useState<ReadonlySet<StatusMarkKey>>(() => new Set());
  const [folded, setFolded] = searched ? [searchFolds, setSearchFolds] : [boardFolds, setBoardFolds];
  const [shown, setShown] = useState<Partial<Record<string, number>>>({});
  // The Waiting for you view also lists the work waiting for a merge or a deploy.
  const delivery = useDeliveryWaits(board, filters, view === 'waiting');
  const deliveryGroups = DELIVERY_GROUPS.filter((group) => delivery[group.wait].length > 0);
  const projects = new Map(board.projects.map((project) => [project.key, project]));
  const fetchedAt = (task: BoardTask) => projects.get(task.project)?.fetchedAt ?? null;
  // An answered decision leaves its group at once, while its Undo window runs and until a later read says what the server holds.
  const inbox = board.inbox.filter((task) => !hides(task.id, fetchedAt(task)));
  const groups = groupRows(
    board.rows.filter((task) => !hides(task.id, fetchedAt(task))),
    board.statuses,
    board.held,
  );
  groups.waiting = [...inbox, ...groups.waiting];
  if (sort !== null)
    for (const mark of Object.keys(groups) as StatusMarkKey[]) groups[mark] = sorted(groups[mark], sort);
  const capabilities = useCapabilities();
  const writable = writesAvailable(capabilities);
  const contextOf = (task: BoardTask): RowContext => ({
    statuses: board.statuses,
    held: board.held,
    epicProgress: projects.get(task.project)?.epicProgress ?? new Map(),
    actionable: projects.get(task.project)?.ok === true && writable,
    age: formatAge(ageMs(now, task.updatedAt)),
    nowMs: now,
  });
  // What waits on a person shows how long it has waited: an edit by an agent moves its last change, not its creation.
  const waitingContextOf = (task: BoardTask): RowContext => {
    const since = ageMs(now, task.createdAt);
    const age = formatAge(since);
    // A task with no creation time recorded shows `unknown` and no tip.
    return { ...contextOf(task), age, ...(since === null ? {} : { ageTitle: `Created ${age} ago` }) };
  };
  const marks = VIEW_GROUPS[view].filter((mark) => groups[mark].length > 0);
  const narrowed =
    narrowedByFields ||
    filters.q.trim() !== '' ||
    FILTER_NAMES.some((name) => (name === 'label' ? filters.label !== '' : filters[name] !== 'all'));

  if (marks.length === 0 && deliveryGroups.length === 0) {
    if (board.searching) return <EmptyState icon={<Search />} title="Searching…" />;
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

  const more = (mark: string, total: number, limit: number) =>
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
              contextOf={waitingContextOf}
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
      {deliveryGroups.map(({ wait }) => {
        const rows = sorted(delivery[wait], sort);
        const limit = shown[wait] ?? PAGE_ROWS;
        return (
          <DeliveryGroup
            key={wait}
            wait={wait}
            rows={rows.slice(0, limit)}
            count={rows.length}
            contextOf={wait === 'merge' ? waitingContextOf : contextOf}
            more={more(wait, rows.length, limit)}
          />
        );
      })}
    </div>
  );
}

/** The Filter button: a panel of the filters, each with its count, then the custom fields of the one project in view. */
function FilterMenu({
  board,
  filters,
  fieldFilters,
  fields,
  onPick,
}: {
  board: Board;
  filters: BoardFilters;
  fieldFilters: FieldFilters;
  /** The custom fields of the project in view; none with several projects in view. */
  fields: readonly TaskField[];
  onPick: (name: string, value: string) => void;
}) {
  const set =
    FILTER_NAMES.filter((name) => (name === 'label' ? filters.label !== '' : filters[name] !== 'all')).length +
    Object.keys(fieldFilters).length;
  const names = new Map(
    board.allTasks.flatMap((task) =>
      task.assignee ? [[task.assignee, actorLabel(task.assignee, task.actors)] as const] : [],
    ),
  );
  // A retired field is offered while a filter by it holds, so its filter can be changed as well as cleared.
  const offered = fields.filter(
    (field) => isKnownFieldType(field.type) && (field.retiredAt === null || fieldFilters[field.key] !== undefined),
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
      <PopoverContent align="end" className="grid max-h-[min(80vh,640px)] w-64 gap-3 overflow-y-auto p-3">
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
        {offered.length > 0 ? <div role="separator" className="-mx-3 h-px bg-border" /> : null}
        {offered.map((field) => (
          <Field key={field.key} label={field.name}>
            <FieldFilterControl
              field={field}
              value={fieldFilters[field.key] ?? ''}
              tasks={board.fieldTasks}
              onPick={(value) => onPick(`${FIELD_FILTER_PREFIX}${field.key}`, value)}
            />
          </Field>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * One custom field's filter, by its type: a choice of its options or of yes
 * and no, each with how many tasks hold it; a date; or a value typed out,
 * which applies on Enter or when the field loses focus, since each value is a
 * read of the server.
 */
function FieldFilterControl({
  field,
  value,
  tasks,
  onPick,
}: {
  field: TaskField;
  value: string;
  /** The project's tasks before any filter by custom field. */
  tasks: readonly LiveTask[];
  onPick: (value: string) => void;
}) {
  const count = (wanted: string) =>
    tasks.filter((task) => isWork(task) && fieldMatches(field, task.fields?.[field.key], wanted)).length;
  const choices =
    field.type === 'yes-no'
      ? [
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' },
        ]
      : field.type === 'single-choice' || field.type === 'multiple-choice'
        ? (field.options ?? []).map((option) => ({ value: option, label: option }))
        : null;
  if (choices !== null) {
    return (
      <Select
        value={value}
        onChange={(event) => onPick(event.target.value)}
        data-tasks-filter={`${FIELD_FILTER_PREFIX}${field.key}`}
      >
        <option value="">Any</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label} · {count(choice.value)}
          </option>
        ))}
      </Select>
    );
  }
  if (field.type === 'date') {
    return (
      <Input
        type="date"
        value={value}
        onChange={(event) => onPick(event.target.value)}
        data-tasks-filter={`${FIELD_FILTER_PREFIX}${field.key}`}
      />
    );
  }
  return <TypedFilter key={value} type={field.type} value={value} fieldKey={field.key} onPick={onPick} />;
}

/** A filter value typed out: it applies on Enter or when the field loses focus. */
function TypedFilter({
  type,
  value,
  fieldKey,
  onPick,
}: {
  type: string;
  value: string;
  fieldKey: string;
  onPick: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const apply = () => {
    if (draft.trim() !== value) onPick(draft.trim());
  };
  return (
    <Input
      type={type === 'url' ? 'url' : 'text'}
      inputMode={type === 'number' ? 'decimal' : undefined}
      value={draft}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={apply}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        apply();
      }}
      data-tasks-filter={`${FIELD_FILTER_PREFIX}${fieldKey}`}
    />
  );
}

/** The filters in force, under the top bar: each one a badge that clears it, then Clear filters. */
function ActiveFilters({
  filters,
  fieldFilters,
  fields,
  board,
  onPick,
  onClear,
}: {
  filters: BoardFilters;
  fieldFilters: FieldFilters;
  fields: readonly TaskField[];
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
    ...Object.entries(fieldFilters).map(([key, value]) => {
      const field = fields.find((candidate) => candidate.key === key);
      return {
        name: `${FIELD_FILTER_PREFIX}${key}`,
        text: `${field?.name ?? fieldKeyName(key)}: ${filterValueText(field, value)}`,
      };
    }),
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
