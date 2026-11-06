/**
 * The task rules the pages share, as plain functions: how a status, a
 * priority and a close are named, which tasks wait on a person and what they
 * ask, and the order every list uses. Carried over from NoticeOS's task board
 * so both apps rank and word the same tasks the same way.
 */
import { TASK_RESOLUTIONS, type TaskResolution } from '@ntasks/domain';
import type { LiveTask, TaskActor, TaskChoiceKey, TaskChoiceOption, TaskChoices } from '@/api/types';

export const IN_PROGRESS = 'in_progress';
/** The stored status the pages call Parked. */
export const PARKED = 'deferred';

/** The five statuses as the pages word them, with the key a filter address uses. */
export const TASK_STATUSES = [
  { key: 'open', label: 'Open', stored: 'open' },
  { key: 'in-progress', label: 'In progress', stored: IN_PROGRESS },
  { key: 'blocked', label: 'Blocked', stored: 'blocked' },
  { key: 'parked', label: 'Parked', stored: PARKED },
  { key: 'closed', label: 'Closed', stored: 'closed' },
] as const;
export type StatusKey = (typeof TASK_STATUSES)[number]['key'];

export function statusKey(stored: string): StatusKey | null {
  return TASK_STATUSES.find((status) => status.stored === stored)?.key ?? null;
}

/** Priority 0 to 4 as the pages word it. */
export const PRIORITY_BANDS = ['top', 'high', 'normal', 'low', 'lowest'] as const;
export type PriorityBand = (typeof PRIORITY_BANDS)[number];

/** A priority outside 0 to 4 still lands in exactly one band. */
export function priorityBand(priority: number): PriorityBand {
  return PRIORITY_BANDS[Math.min(Math.max(Math.trunc(priority), 0), 4)] ?? 'normal';
}

/** Each resolution's words on screen. */
export const RESOLUTION_LABELS: Readonly<Record<TaskResolution, string>> = Object.freeze({
  done: 'Done',
  'wont-do': "Won't do",
  duplicate: 'Duplicate',
  'cant-reproduce': "Can't reproduce",
  'already-handled': 'Already handled',
  'no-longer-needed': 'No longer needed',
});

/** A close where nothing shipped. */
export type NotDone = Exclude<TaskResolution, 'done'>;
export const NOT_DONE: readonly NotDone[] = TASK_RESOLUTIONS.filter(
  (resolution): resolution is NotDone => resolution !== 'done',
);

/** An approval a task waits on, which a person answers. */
export function isGate(task: Pick<LiveTask, 'issueType'> & { awaitType?: string | null }): boolean {
  return task.issueType === 'gate' || (task.awaitType ?? null) !== null;
}

type AskFacts = Pick<LiveTask, 'issueType' | 'status' | 'labels' | 'ready' | 'awaitType'> &
  Pick<Partial<LiveTask>, 'choices' | 'choice'>;

/**
 * Whether a task waits on a person: an open approval a person answers, or a
 * ready task labelled `human` that nobody has answered. A parked or closed
 * task waits on nobody.
 */
export function waitsOnPerson(task: AskFacts): boolean {
  if (task.status === PARKED || task.status === 'closed') return false;
  if (isGate(task)) return (task.awaitType ?? 'human') === 'human';
  return (task.choice ?? null) === null && task.issueType !== 'epic' && task.labels.includes('human') && task.ready;
}

/** What a task waiting on a person asks of them. */
export type InboxAsk = 'approve' | 'answer' | 'choose';

export function askVerb(task: Pick<AskFacts, 'issueType' | 'awaitType' | 'choices' | 'choice'>): InboxAsk {
  if (isGate(task)) return 'approve';
  return (task.choices ?? null) !== null && (task.choice ?? null) === null ? 'choose' : 'answer';
}

export function inboxAsk(task: AskFacts): InboxAsk | null {
  return waitsOnPerson(task) ? askVerb(task) : null;
}

/** Links that keep the waiting task out of ready work. */
export function isBlockingLink(type: string): boolean {
  return type === 'blocks';
}

/** An option as a sentence names it: "(b) Keep the old page". */
export function choiceName(option: TaskChoiceKey, label: string): string {
  return `(${option}) ${label}`;
}

/** The options in the order they are drawn: the recommended one first. */
export function choiceOrder(choices: TaskChoices): readonly TaskChoiceOption[] {
  return [
    ...choices.options.filter((option) => option.recommended),
    ...choices.options.filter((option) => !option.recommended),
  ];
}

/** The reason a close where nothing shipped carries: the person's note, else the resolution's words. */
export function closeAsReason({
  resolution,
  note,
  duplicateOf,
}: {
  resolution: NotDone;
  note?: string;
  duplicateOf?: string;
}): string {
  const words = note?.trim() ?? '';
  if (words !== '') return words;
  const label = RESOLUTION_LABELS[resolution];
  return duplicateOf === undefined ? label : `${label} of ${duplicateOf}`;
}

const DISMISSED = 'Dismissed';

/** What a closed task's reason adds under "Closed as …": the closer's note,
 * or null when the reason only repeats the resolution's words. A done close's
 * reason is its evidence and is always shown. */
export function closeNote(
  reason: string | null | undefined,
  resolution: TaskResolution,
  duplicateOf: string | null,
): string | null {
  const text = reason?.trim() ?? '';
  if (text === '') return null;
  if (resolution === 'done') return text;
  if (text === DISMISSED) return null;
  if (text.startsWith(`${DISMISSED}: `)) return text.slice(DISMISSED.length + 2).trim() || null;
  return text === closeAsReason({ resolution, ...(duplicateOf === null ? {} : { duplicateOf }) }) ? null : text;
}

/** A person's name for an id the API sent with the read; any other name as it is. */
export function actorLabel(actor: string, actors?: readonly TaskActor[]): string {
  const found = actors?.find((person) => person.principalId === actor);
  return found?.displayName.trim() ? found.displayName : actor;
}

/**
 * Who closed a task and the model they named, and the model a claimer named.
 * NoticeOS's API carries these in the task's metadata under these names; the
 * one place they are read is here.
 */
const CLOSED_BY = 'noticeos_closed_by';
const CLOSED_MODEL = 'noticeos_closed_model';
const CLOSED_AT = 'noticeos_closed_at';
const CLAIMED_MODEL = 'noticeos_claimed_model';
/** A recorded close more than a minute from the task's close time belongs to an earlier close. */
const SAME_CLOSE_MS = 60_000;

function metadataText(metadata: Record<string, unknown> | null, name: string): string | null {
  const value = metadata?.[name];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function closeAttribution(
  task: Pick<LiveTask, 'status' | 'closedAt' | 'metadata'>,
): { by: string; model: string | null } | null {
  if (task.status !== 'closed' || task.closedAt === null) return null;
  const by = metadataText(task.metadata, CLOSED_BY);
  const at = Date.parse(metadataText(task.metadata, CLOSED_AT) ?? '');
  if (by === null || !Number.isFinite(at) || Math.abs(at - Date.parse(task.closedAt)) > SAME_CLOSE_MS) return null;
  return { by, model: metadataText(task.metadata, CLOSED_MODEL) };
}

export function claimedModel(task: Pick<LiveTask, 'metadata'>): string | null {
  return metadataText(task.metadata, CLAIMED_MODEL);
}

/** A board row: a task with the project key it was read from. */
export interface BoardTask extends LiveTask {
  project: string;
  actors?: readonly TaskActor[];
  /** What answering this task lets proceed: the open tasks it alone holds back. */
  proceeds?: readonly { id: string; title: string; priority: number }[];
}

function touchedAt(task: Pick<LiveTask, 'updatedAt'>): number {
  const parsed = Date.parse(task.updatedAt ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function restRank(task: Pick<LiveTask, 'status'>): number {
  if (task.status === 'closed') return 2;
  if (task.status === PARKED) return 1;
  return 0;
}

/** The board's one order: live work, then parked, then closed; within each,
 * priority, then whatever has gone longest untouched. */
export function boardOrder(a: BoardTask, b: BoardTask): number {
  const rank = restRank(a) - restRank(b);
  if (rank !== 0) return rank;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return touchedAt(a) - touchedAt(b);
}

/** Decisions: the most urgent work an answer releases first, then the one
 * that releases most, approvals before questions, then the oldest. An
 * approval takes the urgency of the work it holds, not its own. */
export function inboxOrder(a: BoardTask, b: BoardTask): number {
  const urgency = (task: BoardTask) => {
    const released = (task.proceeds ?? []).map((row) => row.priority);
    return Math.min(...(isGate(task) && released.length > 0 ? [] : [task.priority]), ...released);
  };
  const priority = urgency(a) - urgency(b);
  if (priority !== 0) return priority;
  const releases = (b.proceeds?.length ?? 0) - (a.proceeds?.length ?? 0);
  if (releases !== 0) return releases;
  const gate = Number(isGate(b)) - Number(isGate(a));
  if (gate !== 0) return gate;
  return touchedAt(a) - touchedAt(b);
}

/** A board's rows, with each task's project and what answering it lets proceed. */
export function boardRows(project: string, tasks: readonly LiveTask[], actors?: readonly TaskActor[]): BoardTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.map((task) => {
    const proceeds = tasks.filter(
      (other) =>
        other.issueType !== 'epic' &&
        !isGate(other) &&
        other.status !== 'closed' &&
        other.status !== PARKED &&
        other.dependencies.some((edge) => isBlockingLink(edge.type) && edge.id === task.id) &&
        other.dependencies.every(
          (edge) =>
            !isBlockingLink(edge.type) ||
            edge.id === task.id ||
            (byId.get(edge.id)?.status ?? edge.status) === 'closed',
        ),
    );
    return {
      ...task,
      project,
      ...(actors === undefined ? {} : { actors }),
      proceeds: proceeds.map(({ id, title, priority }) => ({ id, title, priority })),
    };
  });
}

/** Whether an open task waits on another task that is not closed. */
export function waitsOnTask(task: BoardTask, statuses: ReadonlyMap<string, string>): boolean {
  return (
    task.status === 'open' &&
    task.dependencies.some((edge) => {
      if (!isBlockingLink(edge.type)) return false;
      const status = statuses.get(edge.id) ?? edge.status;
      return status == null ? !task.ready : status !== 'closed';
    })
  );
}
