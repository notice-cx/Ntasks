/**
 * The task engine's contract: the one interface through which the API, the
 * MCP tools and imports read and change tasks. workers/api implements it in
 * the task store, a Durable Object with its own SQLite database.
 * docs/task-store.md maps each operation NoticeOS used to send to Beads onto
 * these methods.
 *
 * The engine checks the task model's rules; it does not check who may act.
 * The API layer signs the sender in, decides what they may do, and passes the
 * engine an `Actor` it has already authenticated.
 *
 * Every write is one batch, which commits whole or not at all: the change,
 * its history event and its retry record land together. The rules in
 * docs/architecture.md ("Rules every change keeps") are the engine's
 * guarantees, and each method's comment names the ones it relies on.
 */
import type {
  CustomField,
  DependencyType,
  EpicProgress,
  ExternalLink,
  ExternalLinkKind,
  FieldType,
  FieldValue,
  Json,
  JsonObject,
  Project,
  Task,
  TaskComment,
  TaskEvent,
  TaskResolution,
  TaskStatus,
  TaskType,
} from './task.ts';

/** The sender of a write, as the API layer authenticated it. */
export interface Actor {
  /** Recorded as the filer, assignee, closer or author. */
  readonly name: string;
  /** The AI model the sender named, if it is an agent. */
  readonly model?: string;
}

/** An idempotency key: 8 to 128 letters, digits, dots, underscores, colons or hyphens, starting with a letter or digit. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

/**
 * Makes a write safe to retry. The engine records which tasks or comment the
 * write produced under (`principal`, `operation`, `key`), in the same batch as
 * the write. The same key with the same `requestHash` returns those again,
 * as they stand now, with `replayed: true` and without writing; with a
 * different `requestHash` it is refused as `retry_conflict`. A record is kept
 * for seven days.
 */
export interface Retry {
  /** The authenticated sender's stable identity, not a display name. */
  readonly principal: string;
  /** The operation's name, such as `create_task`. */
  readonly operation: string;
  /** The caller's idempotency key, 8 to 128 characters. */
  readonly key: string;
  /** SHA-256 of the canonical request, as 64 lowercase hexadecimal characters. */
  readonly requestHash: string;
}

export interface CreateProjectInput {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly prefix: string;
}

/** A link a new task starts with. */
export interface NewTaskLink {
  /** `depends-on`: the new task waits on `taskId` (for `blocks`) or links to it.
   * `blocks`: `taskId` waits on the new task. */
  readonly direction: 'depends-on' | 'blocks';
  readonly taskId: string;
  readonly type: DependencyType;
}

/** A link to a page outside Ntasks, as a write gives it. */
export interface NewExternalLink {
  /** An http or https URL; the engine keeps it as the URL standard writes it. */
  readonly url: string;
  readonly title: string;
  readonly kind?: ExternalLinkKind | null;
}

export interface CreateTaskInput {
  readonly title: string;
  readonly description?: string;
  readonly acceptance?: string;
  readonly notes?: string;
  readonly design?: string;
  readonly estimateMinutes?: number;
  /** `task` when left out. A gate is made with `requestApproval`, never as a type. */
  readonly type?: Exclude<TaskType, 'gate'>;
  readonly priority?: number;
  /** The new task's id becomes the parent's id with the next child number. */
  readonly parentId?: string;
  readonly labels?: readonly string[];
  readonly links?: readonly NewTaskLink[];
  readonly externalLinks?: readonly NewExternalLink[];
  /** Values of the project's custom fields, by key, each checked against its field. */
  readonly fields?: Readonly<Record<string, FieldValue>>;
  readonly deferUntil?: string;
  readonly dueAt?: string;
  readonly choices?: JsonObject;
  readonly metadata?: JsonObject;
  /** Opens an approval with the new task, in the same batch: a gate the new
   * task waits on until a person answers it. The gate is in the result's `created`. */
  readonly requestApproval?: { readonly reason: string };
}

/** Field changes. A key left out is unchanged; `null` clears the field. */
export interface TaskFieldChanges {
  readonly title?: string;
  readonly description?: string;
  readonly acceptance?: string;
  readonly notes?: string;
  readonly design?: string;
  readonly estimateMinutes?: number | null;
  readonly type?: Exclude<TaskType, 'gate'>;
  readonly priority?: number;
  /** Any status but `closed`; a write closes a task with `close`. */
  readonly status?: Exclude<TaskStatus, 'closed'>;
  /** Setting yourself as assignee is a claim: it records your model, and with
   * status `in_progress` the start time. A claim on a task someone else holds
   * is refused as `held` (rule 1); giving it to them directly, or releasing it,
   * is not a claim. */
  readonly assignee?: string | null;
  readonly parentId?: string | null;
  readonly deferUntil?: string | null;
  readonly dueAt?: string | null;
  readonly choices?: JsonObject | null;
  /** A person's pick of one of the task's choices. */
  readonly choice?: JsonObject | null;
}

/**
 * One change to an existing task, written as one batch. Every part named here
 * lands together or not at all, so an operation that NoticeOS ran as several
 * Beads commands, such as recording a person's choice, commenting and
 * closing, is one write.
 */
export interface TaskWrite {
  /** The task's version when the caller read it. If the task has changed
   * since, the write is refused as `version_conflict` (rules 1 and 2). */
  readonly expectedVersion: number;
  readonly set?: TaskFieldChanges;
  readonly addLabels?: readonly string[];
  readonly removeLabels?: readonly string[];
  /** Merged into the task's metadata; a key set to `null` is removed. */
  readonly metadata?: Readonly<Record<string, Json | null>>;
  /** Links from this task to others. A `blocks` link that would close a loop
   * of tasks waiting on each other is refused as `cycle`. */
  readonly addLinks?: readonly { readonly taskId: string; readonly type: DependencyType }[];
  readonly removeLinks?: readonly string[];
  /** Links to pages outside Ntasks. One to a URL the task already links to
   * replaces its title and kind. A URL may not be both added and removed. */
  readonly addExternalLinks?: readonly NewExternalLink[];
  /** The URLs of external links to take off. */
  readonly removeExternalLinks?: readonly string[];
  /** Values of the project's custom fields, by key; null takes a value off.
   * A retired field takes no new value, though its value can be taken off. */
  readonly setFields?: Readonly<Record<string, FieldValue | null>>;
  /** Opens an approval: a gate task that this task waits on until a person
   * answers it. The new gate's id is in the result's `created`. */
  readonly requestApproval?: { readonly reason: string };
  /** Closes the task, recording the actor as the closer. Refused on a task
   * that is already closed. */
  readonly close?: { readonly reason: string; readonly resolution: TaskResolution; readonly duplicateOf?: string };
  /** Opens a closed task again. Its earlier close stays in its history (rule 6). */
  readonly reopen?: true;
  /** A comment added in the same change, such as the answer behind it. */
  readonly comment?: string;
}

/** The filters every list of tasks takes. */
export interface TaskFilters {
  /** Only tasks someone can start now. */
  readonly ready?: boolean;
  readonly parentId?: string;
  readonly assignee?: string;
  /** Only tasks carrying every one of these labels. */
  readonly labels?: readonly string[];
  /** Only tasks whose id, title, description, acceptance or labels hold every
   * one of these words, ignoring case. */
  readonly words?: readonly string[];
  /** Only tasks of these types. */
  readonly types?: readonly TaskType[];
  /** Only tasks created at or after, or before, these times. */
  readonly createdAfter?: string;
  readonly createdBefore?: string;
  /** Only tasks last changed at or after, or before, these times. */
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  /** Only tasks whose custom fields hold these values, by key. A
   * multiple-choice field matches a task whose options include the one named. */
  readonly fields?: Readonly<Record<string, string | number | boolean>>;
}

export interface TaskQuery extends TaskFilters {
  readonly statuses?: readonly TaskStatus[];
  /** Only tasks closed at or after this time. */
  readonly closedSince?: string;
  /** Only tasks closed before this time. */
  readonly closedBefore?: string;
  /** At most this many, up to TASK_LIMITS.page. */
  readonly limit: number;
  /** The `nextCursor` of the previous page. */
  readonly cursor?: string;
}

/** What a board shows: the tasks in the statuses named, and those closed from a time. */
export interface BoardQuery extends TaskFilters {
  /** Every task in these statuses. */
  readonly statuses: readonly Exclude<TaskStatus, 'closed'>[];
  /** With it, also every task closed at or after this time. A ready-only
   * board leaves closed tasks out, as no closed task is ready. */
  readonly closedSince?: string;
  /** Leaves the tasks' external links unread, so each task's `externalLinks`
   * is empty. For a caller that shows a page of the board: it reads the
   * page's links with `listExternalLinks`, and no other task's. */
  readonly withoutExternalLinks?: true;
}

/** One task's links to pages outside Ntasks, ordered by URL. */
export interface TaskExternalLinks {
  readonly taskId: string;
  readonly externalLinks: readonly ExternalLink[];
}

export interface TaskPage {
  readonly tasks: readonly Task[];
  /** Null on the last page. */
  readonly nextCursor: string | null;
}

/** One project's tasks carrying a label, by id, a page at a time. */
export interface LabelQuery {
  readonly label: string;
  /** 1 to TASK_LIMITS.page. */
  readonly limit: number;
  /** Only tasks whose id sorts after this one: the previous page's `next`. */
  readonly after?: string;
}

export interface LabelPage {
  readonly tasks: readonly Task[];
  /** The last task's id when more remain; null on the last page. */
  readonly next: string | null;
}

export interface ChangePage {
  /** Events after the requested sequence number, oldest first. */
  readonly events: readonly TaskEvent[];
  /** The sequence number to ask after next; unchanged when there were none. */
  readonly lastSeq: number;
}

export interface WriteResult {
  readonly task: Task;
  /** Tasks the write made as well, such as the gate of a requested approval. */
  readonly created: readonly Task[];
  /** True when a retry returned the recorded answer and nothing was written. */
  readonly replayed: boolean;
}

/** A new custom field. */
export interface DefineFieldInput {
  readonly key: string;
  readonly name: string;
  readonly type: FieldType;
  /** For a choice field, its options in order; for any other type, left out. */
  readonly options?: readonly string[];
}

export interface FieldResult {
  readonly field: CustomField;
  /** True when a retry returned the recorded answer and nothing was written. */
  readonly replayed: boolean;
}

export interface CommentResult {
  readonly comment: TaskComment;
  readonly replayed: boolean;
}

export interface TaskEngine {
  listProjects(): Promise<readonly Project[]>;
  createProject(input: CreateProjectInput): Promise<Project>;

  /** Null when the project holds no such task. */
  getTask(projectId: string, taskId: string): Promise<Task | null>;
  /** Which of these ids the project holds, closed or not. */
  findTasks(projectId: string, taskIds: readonly string[]): Promise<readonly string[]>;
  /** Most urgent first: priority, then oldest. Ready work is worked out on the server (rule 5). */
  listTasks(projectId: string, query: TaskQuery): Promise<TaskPage>;
  /** A board, in one project or, with `projectId` null, in every project:
   * every task it matches, most urgent first, in one round trip and not paged. */
  listBoard(projectId: string | null, query: BoardQuery): Promise<readonly Task[]>;
  listEpics(projectId: string): Promise<readonly EpicProgress[]>;
  /** Every task of the project carrying the label, in every status and closed
   * of any age, by id. Its cost follows the tasks carrying the label, not the
   * project's size. */
  listLabelled(projectId: string, query: LabelQuery): Promise<LabelPage>;
  /** The external links of these tasks, reading theirs and no other task's.
   * A task with none, or that does not exist, is left out. */
  listExternalLinks(taskIds: readonly string[]): Promise<readonly TaskExternalLinks[]>;
  /** The project's custom fields, retired ones included, in the order they were defined. */
  listFields(projectId: string): Promise<readonly CustomField[]>;
  /** The earliest time after `time` at which any task stops being deferred,
   * or null when none will. Ready work can change then without any write,
   * since a deferred parent holds its children back even once it is closed,
   * so a cached read of it stays true until that time. */
  nextDeferralAfter(time: string): Promise<string | null>;
  listComments(projectId: string, taskId: string): Promise<readonly TaskComment[]>;
  /** The task's changes, newest first. */
  listHistory(
    projectId: string,
    taskId: string,
    options: { readonly limit: number; readonly beforeSeq?: number },
  ): Promise<readonly TaskEvent[]>;
  /** The sequence number of the latest change, or 0 before the first: where
   * a client that has just read a board starts reading changes. */
  latestChange(): Promise<number>;
  /** Every change after `after`, across projects or in one, for clients that keep a copy. */
  listChanges(query: {
    readonly after: number;
    readonly limit: number;
    readonly projectId?: string;
  }): Promise<ChangePage>;
  /** For each of these tasks that lacks a section its type expects, the
   * missing headings (`missingSections` in lint.ts). A task lacking none, or
   * not in the project, is left out. */
  lint(projectId: string, taskIds: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>>;

  /** The answer of an earlier createTask or writeTask with this retry
   * identity, its tasks as they stand now and `replayed: true`, or null when no
   * write in the last seven days used the key. A key used for a different
   * request or project is refused as `retry_conflict`. The API reads it before
   * checking a rule that the write's own effect would break, such as a close's
   * rule that the task is open, so a retried close answers instead of being
   * refused. */
  recordedWrite(projectId: string, retry: Retry): Promise<WriteResult | null>;
  /** Records a retry identity for a write that changed nothing, with the task
   * as its answer, so a retry of it replays and the same key with another
   * request is refused as `retry_conflict`. It writes only the retry record:
   * the task's version and history stay as they were. Refused as
   * `version_conflict`, recording nothing, when the task is no longer at
   * `expectedVersion`, so the caller reads the task again and decides again. */
  recordUnchanged(projectId: string, taskId: string, expectedVersion: number, retry: Retry): Promise<WriteResult>;

  createTask(projectId: string, input: CreateTaskInput, actor: Actor, retry?: Retry): Promise<WriteResult>;
  /** Changes an existing task in one batch (rules 1 to 4). */
  writeTask(projectId: string, taskId: string, write: TaskWrite, actor: Actor, retry?: Retry): Promise<WriteResult>;
  /** Defines a custom field in the project. A key the project has used,
   * retired or not, is refused as `invalid`. */
  defineField(projectId: string, input: DefineFieldInput, actor: Actor, retry?: Retry): Promise<FieldResult>;
  /** Retires a custom field: it takes no new values from then on. Retiring a
   * retired field changes nothing. */
  retireField(projectId: string, key: string, actor: Actor, retry?: Retry): Promise<FieldResult>;
  /** Adds a comment. It does not change the task's version, so it never conflicts with a write. */
  addComment(projectId: string, taskId: string, text: string, actor: Actor, retry?: Retry): Promise<CommentResult>;
}

/**
 * Why the engine refused a write. The first three can come from the database's
 * write guard (workers/api/src/store/migrations/0001_task_store.sql), which reports them
 * as "ntasks refused: <refusal>".
 */
export const TASK_REFUSALS = ['not_found', 'version_conflict', 'cycle', 'held', 'retry_conflict', 'invalid'] as const;
export type TaskRefusal = (typeof TASK_REFUSALS)[number];

/** The refusals the database's write guard can report. */
export const GUARD_REFUSALS = ['not_found', 'version_conflict', 'cycle'] as const satisfies readonly TaskRefusal[];

export class TaskRefused extends Error {
  override name = 'TaskRefused';
  readonly refusal: TaskRefusal;
  constructor(refusal: TaskRefusal, message: string) {
    super(message);
    this.refusal = refusal;
  }
}

const GUARD_MESSAGE = /ntasks refused: ([a-z_]+)/u;

/** The guard refusal named in a database error message, or null when the error came from elsewhere. */
export function guardRefusalOf(message: string): (typeof GUARD_REFUSALS)[number] | null {
  const name = GUARD_MESSAGE.exec(message)?.[1];
  return (GUARD_REFUSALS as readonly string[]).includes(name ?? '') ? (name as (typeof GUARD_REFUSALS)[number]) : null;
}
