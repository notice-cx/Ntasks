/**
 * The board as the pages draw it, from every project's read: each project's
 * rows, the decisions waiting on a person, the counts, and the rows the
 * filters keep. A project whose read failed is named as such and counted as
 * missing, never as empty.
 */
import { actorKey } from '@ntasks/domain';
import type { FieldFilters, FoundTask, LiveTasksPayload, TaskProject } from '../api/types';
import { STATUS_MARKS, statusMarkFor, type StatusMark } from './symbols';
import {
  boardOrder,
  boardRows,
  inboxAsk,
  inboxOrder,
  isGate,
  PARKED,
  priorityBand,
  statusKey,
  waitsOnTask,
  type BoardTask,
} from './task-model';

export interface BoardFilters {
  q: string;
  project: string;
  status: string;
  priority: string;
  label: string;
  assignee: string;
  /** Values of the custom fields of the one project in view, by field key; the server keeps only the tasks holding them. */
  fields: FieldFilters;
}

export const NO_FILTERS: BoardFilters = {
  q: '',
  project: 'all',
  status: 'all',
  priority: 'all',
  label: '',
  assignee: 'all',
  fields: {},
};

/** The address's prefix for a filter by custom field, as the API names it: `field.area=Email`. */
export const FIELD_FILTER_PREFIX = 'field.';

/** The filters by custom field an address names, by field key. */
export function fieldFiltersOf(params: URLSearchParams): FieldFilters {
  return Object.fromEntries(
    [...params.entries()]
      .filter(
        ([name, value]) =>
          name.startsWith(FIELD_FILTER_PREFIX) && name.length > FIELD_FILTER_PREFIX.length && value !== '',
      )
      .map(([name, value]) => [name.slice(FIELD_FILTER_PREFIX.length), value]),
  );
}

/**
 * The project whose custom fields the board filters by: the one the Project
 * filter names, or the only project there is. Each project defines its own
 * fields, so with several projects in view there is none.
 */
export function fieldsProject(filters: Pick<BoardFilters, 'project'>, catalog: readonly TaskProject[]): string | null {
  if (filters.project !== 'all') return filters.project;
  return catalog.length === 1 ? (catalog[0]?.logicalKey ?? null) : null;
}

export interface ProjectRead {
  data?: LiveTasksPayload;
  error: unknown;
  /** When this browser received `data`, by its own clock; null before any read. */
  fetchedAt?: number | null;
}

export interface BoardProject {
  key: string;
  name: string;
  prefix: string;
  /** The addresses of the icons read from its website, light and dark; null when it has none. */
  icon: string | null;
  darkIcon: string | null;
  /** The read answered. */
  ok: boolean;
  error: string | null;
  /** When the server read the tasks, for the page to say how old they are. */
  readAt: string | null;
  /** When this browser received the read, by its own clock. */
  fetchedAt: number | null;
  tasks: BoardTask[];
  /** The decisions waiting on a person, most urgent first. */
  waiting: BoardTask[];
  /** Tasks that would wait on a person but a pending approval holds: the approval is asked instead. */
  held: Set<string>;
  epicNames: Map<string, string>;
  /** Each epic's children, closed and in all, when the server could read them. */
  epicProgress: Map<string, { closed: number; total: number }>;
  /** The earliest close `tasks` holds; null when the read named none. */
  closedSince: string | null;
}

/** Approvals and epics stay reachable, but are not work a row counts. */
export function isWork(task: Pick<BoardTask, 'issueType' | 'awaitType'>): boolean {
  return task.issueType !== 'epic' && !isGate(task);
}

/** The status a row is filtered and counted by: an open task that waits on another task is Blocked. */
function workStatus(task: BoardTask, statuses: ReadonlyMap<string, string>): string {
  return waitsOnTask(task, statuses) ? 'blocked' : task.status;
}

/**
 * One project's rows. A project whose latest read failed counts as not read,
 * even with an earlier read still in hand: its rows would be counted as
 * current when nothing says they still are.
 */
function readProject(project: TaskProject, read: ProjectRead | undefined): BoardProject {
  const base = {
    key: project.logicalKey,
    name: project.displayName,
    prefix: project.prefix,
    icon: project.icon ?? null,
    darkIcon: project.darkIcon ?? null,
  };
  const error = read?.error;
  const payload = error === undefined || error === null ? read?.data : undefined;
  if (!payload) {
    return {
      ...base,
      ok: false,
      error:
        error === undefined || error === null
          ? null
          : error instanceof Error && error.message !== ''
            ? error.message
            : 'The task list could not be read.',
      readAt: null,
      fetchedAt: null,
      tasks: [],
      waiting: [],
      held: new Set(),
      epicNames: new Map(),
      epicProgress: new Map(),
      closedSince: null,
    };
  }
  // Only approvals a person answers are drawn; one that resolves itself waits on nobody.
  const tasks = boardRows(
    project.logicalKey,
    payload.tasks.filter((task) => task.awaitType === null || task.awaitType === 'human'),
    payload.actors,
  );
  // An approval is the one question for the task it holds, so that task is not asked again beside it.
  const approvals = new Set(tasks.filter((task) => isGate(task) && inboxAsk(task) !== null).map((task) => task.id));
  const asks = tasks.filter((task) => inboxAsk(task) !== null);
  const held = new Set(
    asks
      .filter((task) => task.dependencies.some((edge) => edge.type === 'blocks' && approvals.has(edge.id)))
      .map((task) => task.id),
  );
  const waiting = asks.filter((task) => !held.has(task.id)).sort(inboxOrder);
  return {
    ...base,
    ok: true,
    error: null,
    readAt: payload.readAt,
    fetchedAt: read?.fetchedAt ?? null,
    tasks,
    waiting,
    held,
    epicNames: new Map([
      ...(payload.epics ?? []).map((epic) => [epic.id, epic.title] as const),
      ...tasks.filter((task) => task.issueType === 'epic').map((task) => [task.id, task.title] as const),
    ]),
    epicProgress: new Map((payload.epics ?? []).map((epic) => [epic.id, { closed: epic.closed, total: epic.total }])),
    closedSince: payload.closedSince ?? null,
  };
}

function matchesSearch(task: BoardTask, q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = `${task.id} ${task.title}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

const NONE: ReadonlySet<string> = new Set();

/** Whether a task holds the search and every filter but the project, filtered by the status key `status`.
 * A task the server's search found, named in `found`, holds the search. */
export function keptByFilters(
  task: BoardTask,
  filters: BoardFilters,
  status: string | null,
  found: ReadonlySet<string> = NONE,
): boolean {
  return (
    (found.has(task.id) || matchesSearch(task, filters.q)) &&
    (filters.status === 'all' || status === filters.status) &&
    (filters.priority === 'all' || priorityBand(task.priority) === filters.priority) &&
    (filters.label === '' || task.labels.some((label) => label.toLowerCase().includes(filters.label.toLowerCase()))) &&
    (filters.assignee === 'all' || (task.assignee !== null && actorKey(task.assignee) === actorKey(filters.assignee)))
  );
}

/**
 * The board from every project's read, with the filters applied. `found` is
 * what the server's search of every project found for `filters.q`: each such
 * task holds the search, and one no board in view holds (closed before the
 * board's week, or in a project whose board has not arrived) is a row too,
 * though no count includes it.
 */
export function readBoard(
  catalog: readonly TaskProject[],
  reads: ReadonlyMap<string, ProjectRead>,
  filters: BoardFilters,
  found: readonly FoundTask[] = [],
) {
  const available = catalog.map((project) => readProject(project, reads.get(project.logicalKey)));
  const projects = available.filter((project) => filters.project === 'all' || project.key === filters.project);
  const allTasks = projects.flatMap((project) => project.tasks);
  const onBoards = new Set(allTasks.map((task) => task.id));
  const inView = new Set(projects.map((project) => project.key));
  // As a board draws them: only approvals a person answers.
  const beyond = found
    .filter((task) => inView.has(task.project) && !onBoards.has(task.id))
    .filter((task) => task.awaitType === null || task.awaitType === 'human')
    .flatMap((task) => boardRows(task.project, [task]));
  const beyondIds = new Set(beyond.map((task) => task.id));
  const statuses = new Map([...allTasks, ...beyond].map((task) => [task.id, task.status]));
  const filterStatus = (task: BoardTask) => statusKey(isWork(task) ? workStatus(task, statuses) : task.status);

  const hits = new Set(found.map((task) => task.id));
  const matches = (task: BoardTask) => keptByFilters(task, filters, filterStatus(task), hits);

  const statusCounts = new Map<string, number>();
  const priorityCounts = new Map<string, number>();
  const assigneeCounts = new Map<string, number>();
  for (const task of allTasks) {
    if (task.assignee) {
      const key = actorKey(task.assignee);
      assigneeCounts.set(key, (assigneeCounts.get(key) ?? 0) + 1);
    }
    if (!isWork(task)) continue;
    const status = filterStatus(task);
    if (status !== null) statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    const band = priorityBand(task.priority);
    priorityCounts.set(band, (priorityCounts.get(band) ?? 0) + 1);
  }

  const inbox = projects
    .flatMap((project) => project.waiting)
    .filter(matches)
    .sort(inboxOrder);
  // A decision is answered in the Waiting for you group, so no other group lists it again.
  const waitingIds = new Set(projects.flatMap((project) => project.waiting.map((task) => task.id)));
  const work = allTasks.filter(isWork);
  const live = work.filter((task) => task.status !== 'closed' && task.status !== PARKED);
  const missing = projects.filter((project) => !project.ok);
  const readTimes = projects.flatMap((project) => (project.readAt === null ? [] : [project.readAt])).sort();

  return {
    available,
    projects,
    allTasks,
    inbox,
    /** Every task the filters keep, epics included, except the decisions in `inbox`. An approval on a board is
     * only ever a decision; one the search found beyond the boards is a row. */
    rows: [...allTasks, ...beyond]
      .filter((task) => (!isGate(task) || beyondIds.has(task.id)) && matches(task) && !waitingIds.has(task.id))
      .sort(boardOrder),
    /** Every task's status by id, for `statusMarkFor` and `groupRows`. */
    statuses,
    /** The tasks a pending approval holds, for `statusMarkFor` and `groupRows`. */
    held: new Set(projects.flatMap((project) => [...project.held])) as ReadonlySet<string>,
    statusCounts,
    priorityCounts,
    assigneeCounts,
    projectCounts: new Map(available.map((project) => [project.key, project.tasks.filter(isWork).length])),
    /** Every project in view answered, so a count is the whole count, not a lower bound. */
    complete: projects.length > 0 && missing.length === 0,
    broken: missing.filter((project) => project.error !== null),
    pending: missing.filter((project) => project.error === null),
    /** The oldest read the board shows. */
    readAt: readTimes[0] ?? null,
    totals: {
      waiting: projects.reduce((sum, project) => sum + project.waiting.length, 0),
      blocked: live.filter((task) => workStatus(task, statuses) === 'blocked').length,
    },
  };
}

/** Rows sorted into the groups a list shows, in `STATUS_MARKS` order, by each row's status mark. */
export function groupRows(
  rows: readonly BoardTask[],
  statuses: ReadonlyMap<string, string>,
  held: ReadonlySet<string> = new Set(),
): Record<StatusMark, BoardTask[]> {
  const groups = Object.fromEntries(STATUS_MARKS.map((mark) => [mark, [] as BoardTask[]])) as Record<
    StatusMark,
    BoardTask[]
  >;
  for (const task of rows) groups[statusMarkFor(task, statuses, held)].push(task);
  return groups;
}

export type BoardRead = ReturnType<typeof readBoard>;
