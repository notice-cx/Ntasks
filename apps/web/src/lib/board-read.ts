/**
 * The board as the pages draw it, from every project's read: each project's
 * rows, the decisions waiting on a person, the counts, and the rows the
 * filters keep. A project whose read failed is named as such and counted as
 * missing, never as empty.
 */
import type { LiveTasksPayload, TaskProject } from '@/api/types';
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
import { weekStartMs } from './format';

export interface BoardFilters {
  q: string;
  project: string;
  status: string;
  priority: string;
  label: string;
  assignee: string;
}

export const NO_FILTERS: BoardFilters = { q: '', project: 'all', status: 'all', priority: 'all', label: '', assignee: 'all' };

export interface ProjectRead {
  data?: LiveTasksPayload;
  error: unknown;
}

export interface BoardProject {
  key: string;
  name: string;
  prefix: string;
  /** The read answered. */
  ok: boolean;
  error: string | null;
  readAt: string | null;
  tasks: BoardTask[];
  /** The decisions waiting on a person, most urgent first. */
  waiting: BoardTask[];
  epicNames: Map<string, string>;
}

/** Approvals and epics stay reachable, but are not work a row counts. */
export function isWork(task: Pick<BoardTask, 'issueType' | 'awaitType'>): boolean {
  return task.issueType !== 'epic' && !isGate(task);
}

/** The status a row is filtered and counted by: an open task that waits on another task is Blocked. */
function workStatus(task: BoardTask, statuses: ReadonlyMap<string, string>): string {
  return waitsOnTask(task, statuses) ? 'blocked' : task.status;
}

function readProject(project: TaskProject, read: ProjectRead | undefined): BoardProject {
  const base = { key: project.logicalKey, name: project.displayName, prefix: project.prefix };
  const payload = read?.data;
  if (!payload) {
    const error = read?.error;
    return {
      ...base,
      ok: false,
      error: error === undefined || error === null ? null : error instanceof Error && error.message !== '' ? error.message : 'The task list could not be read.',
      readAt: null,
      tasks: [],
      waiting: [],
      epicNames: new Map(),
    };
  }
  // Only approvals a person answers are drawn; one that resolves itself waits on nobody.
  const tasks = boardRows(project.logicalKey, payload.tasks.filter((task) => task.awaitType === null || task.awaitType === 'human'), payload.actors);
  // An approval is the one question for the task it holds, so that task is not asked again beside it.
  const approvals = new Set(tasks.filter((task) => isGate(task) && inboxAsk(task) !== null).map((task) => task.id));
  const waiting = tasks
    .filter((task) => inboxAsk(task) !== null && !task.dependencies.some((edge) => edge.type === 'blocks' && approvals.has(edge.id)))
    .sort(inboxOrder);
  return {
    ...base,
    ok: true,
    error: null,
    readAt: payload.readAt,
    tasks,
    waiting,
    epicNames: new Map([
      ...(payload.epics ?? []).map((epic) => [epic.id, epic.title] as const),
      ...tasks.filter((task) => task.issueType === 'epic').map((task) => [task.id, task.title] as const),
    ]),
  };
}

function matchesSearch(task: BoardTask, q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = `${task.id} ${task.title}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

export function readBoard(catalog: readonly TaskProject[], reads: ReadonlyMap<string, ProjectRead>, filters: BoardFilters, nowMs: number) {
  const available = catalog.map((project) => readProject(project, reads.get(project.logicalKey)));
  const projects = available.filter((project) => filters.project === 'all' || project.key === filters.project);
  const allTasks = projects.flatMap((project) => project.tasks);
  const statuses = new Map(allTasks.map((task) => [task.id, task.status]));
  const filterStatus = (task: BoardTask) => statusKey(isWork(task) ? workStatus(task, statuses) : task.status);

  const matches = (task: BoardTask) =>
    matchesSearch(task, filters.q)
    && (filters.status === 'all' || filterStatus(task) === filters.status)
    && (filters.priority === 'all' || priorityBand(task.priority) === filters.priority)
    && (filters.label === '' || task.labels.some((label) => label.toLowerCase().includes(filters.label.toLowerCase())))
    && (filters.assignee === 'all' || (task.assignee ?? '') === filters.assignee);

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

  const inbox = projects.flatMap((project) => project.waiting).filter(matches).sort(inboxOrder);
  // A decision is answered in the decisions list, so the table does not list it again.
  const waitingIds = new Set(projects.flatMap((project) => project.waiting.map((task) => task.id)));
  const work = allTasks.filter(isWork);
  const live = work.filter((task) => task.status !== 'closed' && task.status !== PARKED);
  const weekStart = weekStartMs(nowMs);
  const missing = projects.filter((project) => !project.ok);
  const readTimes = projects.flatMap((project) => (project.readAt === null ? [] : [project.readAt])).sort();

  return {
    available,
    projects,
    allTasks,
    inbox,
    rows: work.filter((task) => matches(task) && !waitingIds.has(task.id)).sort(boardOrder),
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
      approvals: projects.reduce((sum, project) => sum + project.waiting.filter(isGate).length, 0),
      open: live.length,
      urgent: live.filter((task) => task.priority <= 1).length,
      blocked: live.filter((task) => workStatus(task, statuses) === 'blocked').length,
      // A close where nothing shipped is not done work.
      doneThisWeek: work.filter((task) => task.status === 'closed' && (task.resolution ?? 'done') === 'done'
        && Date.parse(task.closedAt ?? '') >= weekStart).length,
    },
  };
}

export type BoardRead = ReturnType<typeof readBoard>;
