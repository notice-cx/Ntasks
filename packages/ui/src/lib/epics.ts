/**
 * A project's epics as the Epics tab and the Live page draw them: each open
 * epic's tasks by status, rolled up through its sub-epics, how far it has
 * come, what closed this week, and the group it falls in. The group is worked
 * out here from the board's read and never written to the epic, as Live's
 * Stalled is not.
 */
import type { BoardProject } from './board-read';
import { statusMarkFor, type StatusMark } from './symbols';
import type { BoardTask } from './task-model';

export type EpicState = 'waiting' | 'moving' | 'still' | 'finished' | 'empty';

/** The Epics tab's groups, in the order it shows them. */
export const EPIC_STATES: readonly EpicState[] = ['waiting', 'moving', 'still', 'finished', 'empty'];

export const EPIC_STATE_LABELS: Readonly<Record<EpicState, string>> = Object.freeze({
  waiting: 'Waiting for you',
  moving: 'Moving',
  still: 'Not moving',
  finished: 'Every task done',
  empty: 'No tasks',
});

/** The tasks of an epic that are not closed, by the mark each shows on the board. */
export interface OpenTally {
  waiting: number;
  inProgress: number;
  open: number;
  blocked: number;
  parked: number;
}

export interface EpicSummary {
  id: string;
  title: string;
  priority: number;
  createdAt: string | null;
  /** The open epic it sits in, or null for an epic at the top of its project. */
  parent: string | null;
  /** Its tasks and its sub-epics' tasks that are not closed. */
  open: OpenTally;
  /** Its tasks and its sub-epics' tasks, closed and in all, ever; null when the server sent no counts. */
  progress: { done: number; total: number } | null;
  /** Its tasks and its sub-epics' tasks closed since the board's `since`. */
  doneThisWeek: number;
  /** The latest change to it, its tasks or its sub-epics, as far as the board's read shows. */
  lastChangedAt: string | null;
  /** Its open sub-epics, in the order the tab lists them. */
  subEpics: EpicSummary[];
  state: EpicState;
  /** The epic's own status, independent of the progress of its children. */
  mark: StatusMark;
}

/** The project's open epics, the epics closed this week, and the work in no open epic. */
export interface EpicsRead {
  /** The epics at the top of the project, in the order the tab lists them. */
  epics: EpicSummary[];
  /** Every open epic, sub-epics included, by id. */
  byId: ReadonlyMap<string, EpicSummary>;
  /** Epics closed since `since`, the latest first. */
  closed: BoardTask[];
  /** Tasks in no open epic: those not closed, and those closed since `since`. */
  loose: { open: OpenTally; doneThisWeek: number };
  /** The earliest close the board's read holds: "this week" starts here. Null when the read named none. */
  since: string | null;
}

const NO_TALLY: OpenTally = Object.freeze({ waiting: 0, inProgress: 0, open: 0, blocked: 0, parked: 0 });

export function openCount(tally: OpenTally): number {
  return tally.waiting + tally.inProgress + tally.open + tally.blocked + tally.parked;
}

function addTally(a: OpenTally, b: OpenTally): OpenTally {
  return {
    waiting: a.waiting + b.waiting,
    inProgress: a.inProgress + b.inProgress,
    open: a.open + b.open,
    blocked: a.blocked + b.blocked,
    parked: a.parked + b.parked,
  };
}

function tallyOf(
  tasks: readonly BoardTask[],
  statuses: ReadonlyMap<string, string>,
  held: ReadonlySet<string>,
): OpenTally {
  const tally = { ...NO_TALLY };
  for (const task of tasks) {
    const mark = statusMarkFor(task, statuses, held);
    if (mark === 'waiting') tally.waiting += 1;
    else if (mark === 'in-progress') tally.inProgress += 1;
    else if (mark === 'blocked') tally.blocked += 1;
    else if (mark === 'parked') tally.parked += 1;
    else if (mark === 'open') tally.open += 1;
  }
  return tally;
}

const later = (a: string | null, b: string | null | undefined) => (b && (a === null || b > a) ? b : a);

/**
 * The group an epic falls in, testing these in order: No tasks, Every task
 * done, Waiting for you (a task in it waits on a person), Moving (a task in
 * it closed this week or is in progress), and Not moving.
 */
export function epicState(summary: Pick<EpicSummary, 'open' | 'progress' | 'doneThisWeek'>): EpicState {
  const open = openCount(summary.open);
  const total = summary.progress?.total ?? open + summary.doneThisWeek;
  if (total === 0) return 'empty';
  if (open === 0) return 'finished';
  if (summary.open.waiting > 0) return 'waiting';
  if (summary.doneThisWeek > 0 || summary.open.inProgress > 0) return 'moving';
  return 'still';
}

/** The tab's order within a group: priority, then the latest change first. */
export function epicOrder(a: EpicSummary, b: EpicSummary): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return (b.lastChangedAt ?? '').localeCompare(a.lastChangedAt ?? '') || a.id.localeCompare(b.id);
}

/**
 * One project's epics from its board read. An epic counts the tasks directly
 * in it and, through each open sub-epic, the sub-epic's tasks; the server's
 * counts are each epic's direct children, where an open sub-epic is one
 * child, so the sub-epic stands in for its own tasks here. A closed sub-epic
 * stays one done task.
 */
export function readEpics(
  project: Pick<BoardProject, 'tasks' | 'epicProgress' | 'closedSince'>,
  statuses: ReadonlyMap<string, string>,
  held: ReadonlySet<string>,
): EpicsRead {
  const openEpics = project.tasks.filter((task) => task.issueType === 'epic' && task.status !== 'closed');
  const epicIds = new Set(openEpics.map((epic) => epic.id));
  const children = new Map<string, BoardTask[]>();
  for (const task of project.tasks) {
    if (task.parent === null || !epicIds.has(task.parent)) continue;
    const list = children.get(task.parent) ?? [];
    list.push(task);
    children.set(task.parent, list);
  }
  const since = project.closedSince;

  const summaries = new Map<string, EpicSummary>();
  // A parent chain that loops would otherwise never end; each epic is summed once.
  const visiting = new Set<string>();
  function summarize(epic: BoardTask): EpicSummary {
    const done = summaries.get(epic.id);
    if (done) return done;
    visiting.add(epic.id);
    const own = children.get(epic.id) ?? [];
    const tasks = own.filter((task) => task.issueType !== 'epic' || task.status === 'closed');
    const subs = own
      .filter((task) => task.issueType === 'epic' && task.status !== 'closed' && !visiting.has(task.id))
      .map(summarize)
      .sort(epicOrder);
    const counted = project.epicProgress.get(epic.id);
    let progress: EpicSummary['progress'] = null;
    if (counted && subs.every((sub) => sub.progress !== null)) {
      // An open sub-epic is one of the epic's children in the server's count; its own tasks take its place.
      const openSubs = own.filter((task) => task.issueType === 'epic' && task.status !== 'closed').length;
      progress = {
        done: counted.closed + subs.reduce((sum, sub) => sum + (sub.progress?.done ?? 0), 0),
        total: counted.total - openSubs + subs.reduce((sum, sub) => sum + (sub.progress?.total ?? 0), 0),
      };
    }
    const open = subs.reduce(
      (sum, sub) => addTally(sum, sub.open),
      tallyOf(
        tasks.filter((task) => task.status !== 'closed'),
        statuses,
        held,
      ),
    );
    const doneThisWeek =
      tasks.filter((task) => task.status === 'closed').length + subs.reduce((sum, sub) => sum + sub.doneThisWeek, 0);
    let lastChangedAt = later(null, epic.updatedAt);
    for (const task of own) lastChangedAt = later(lastChangedAt, task.updatedAt);
    for (const sub of subs) lastChangedAt = later(lastChangedAt, sub.lastChangedAt);
    const parent = epic.parent !== null && epicIds.has(epic.parent) ? epic.parent : null;
    const partial = { open, progress, doneThisWeek };
    const summary: EpicSummary = {
      id: epic.id,
      title: epic.title,
      priority: epic.priority,
      createdAt: epic.createdAt,
      parent,
      ...partial,
      lastChangedAt,
      subEpics: subs,
      state: epicState(partial),
      mark: statusMarkFor(epic, statuses, held),
    };
    summaries.set(epic.id, summary);
    visiting.delete(epic.id);
    return summary;
  }
  for (const epic of openEpics) summarize(epic);

  const all = [...summaries.values()];
  // An epic whose parent chain loops back to it has no top; it stands at the top so it is not lost.
  const shownUnder = new Set(all.flatMap((summary) => summary.subEpics.map((sub) => sub.id)));
  const epics = all.filter((summary) => !shownUnder.has(summary.id)).sort(epicOrder);

  const loose = project.tasks.filter(
    (task) => task.issueType !== 'epic' && (task.parent === null || !epicIds.has(task.parent)),
  );
  return {
    epics,
    byId: summaries,
    closed: project.tasks
      .filter((task) => task.issueType === 'epic' && task.status === 'closed')
      .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '')),
    loose: {
      open: tallyOf(
        loose.filter((task) => task.status !== 'closed'),
        statuses,
        held,
      ),
      doneThisWeek: loose.filter((task) => task.status === 'closed').length,
    },
    since,
  };
}

/**
 * Tasks under their epics, for the Live page: one section per epic in the
 * order its first task comes, then the tasks in no epic. Each section keeps
 * its tasks' order.
 */
export function byEpic<T>(
  tasks: readonly T[],
  epicOf: (task: T) => EpicSummary | null,
): { epic: EpicSummary | null; tasks: T[] }[] {
  const sections = new Map<string, { epic: EpicSummary; tasks: T[] }>();
  const loose: T[] = [];
  for (const task of tasks) {
    const epic = epicOf(task);
    if (epic === null) {
      loose.push(task);
      continue;
    }
    const section = sections.get(epic.id) ?? { epic, tasks: [] };
    section.tasks.push(task);
    sections.set(epic.id, section);
  }
  return [...sections.values(), ...(loose.length > 0 ? [{ epic: null, tasks: loose }] : [])];
}
