/**
 * The board as the pages draw it, from every project's read: each project's
 * rows, the decisions waiting on a person, the counts, and the rows the
 * filters keep. A project whose read failed is named as such and counted as
 * missing, never as empty.
 */
import type { LiveTasksPayload, TaskProject } from '@/api/types';
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
}

export const NO_FILTERS: BoardFilters = {
  q: '',
  project: 'all',
  status: 'all',
  priority: 'all',
  label: '',
  assignee: 'all',
};

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
  const base = { key: project.logicalKey, name: project.displayName, prefix: project.prefix };
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
  };
}

function matchesSearch(task: BoardTask, q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = `${task.id} ${task.title}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

export function readBoard(
  catalog: readonly TaskProject[],
  reads: ReadonlyMap<string, ProjectRead>,
  filters: BoardFilters,
) {
  const available = catalog.map((project) => readProject(project, reads.get(project.logicalKey)));
  const projects = available.filter((project) => filters.project === 'all' || project.key === filters.project);
  const allTasks = projects.flatMap((project) => project.tasks);
  const statuses = new Map(allTasks.map((task) => [task.id, task.status]));
  const filterStatus = (task: BoardTask) => statusKey(isWork(task) ? workStatus(task, statuses) : task.status);

  const matches = (task: BoardTask) =>
    matchesSearch(task, filters.q) &&
    (filters.status === 'all' || filterStatus(task) === filters.status) &&
    (filters.priority === 'all' || priorityBand(task.priority) === filters.priority) &&
    (filters.label === '' || task.labels.some((label) => label.toLowerCase().includes(filters.label.toLowerCase()))) &&
    (filters.assignee === 'all' || (task.assignee ?? '') === filters.assignee);

  const statusCounts = new Map<string, number>();
  const priorityCounts = new Map<string, number>();
  const assigneeCounts = new Map<string, number>();
  for (const task of allTasks) {
    if (task.assignee) assigneeCounts.set(task.assignee, (assigneeCounts.get(task.assignee) ?? 0) + 1);
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
    /** Every task the filters keep, epics included, except the decisions in `inbox`; approvals are only ever decisions. */
    rows: allTasks.filter((task) => !isGate(task) && matches(task) && !waitingIds.has(task.id)).sort(boardOrder),
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
