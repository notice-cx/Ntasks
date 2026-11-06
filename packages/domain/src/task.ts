/**
 * The task model's vocabulary and record shapes. docs/concepts.md introduces
 * each term. The lists below are also CHECK constraints in
 * workers/api/src/store/migrations/0001_task_store.sql; the Worker's schema tests fail
 * when the two disagree.
 */

/** A task's state. `closed` is reached only by closing the task, never by setting it. */
export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'deferred', 'closed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** `gate` is an approval a task waits on; people see it as an approval, not as a task type. */
export const TASK_TYPES = ['task', 'bug', 'feature', 'epic', 'chore', 'decision', 'gate'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** `blocks` keeps the dependent task out of ready work; the others only record a link. */
export const DEPENDENCY_TYPES = ['blocks', 'related', 'discovered-from'] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

/** How a close ended. */
export const TASK_RESOLUTIONS = [
  'done',
  'wont-do',
  'duplicate',
  'cant-reproduce',
  'already-handled',
  'no-longer-needed',
] as const;
export type TaskResolution = (typeof TASK_RESOLUTIONS)[number];

/** What a history event records. A comment is `commented`; every other write is one of the rest. */
export const TASK_EVENT_KINDS = ['created', 'updated', 'closed', 'reopened', 'commented'] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

/** The highest and lowest priority; 0 is the most urgent. */
export const TASK_PRIORITY = Object.freeze({ highest: 0, lowest: 4, default: 2 });

/**
 * The largest values the API accepts in a new write. The database accepts at
 * least these, and as much as Beads' own columns hold, so that a task imported
 * from Beads fits (workers/api/src/store/migrations/0001_task_store.sql).
 */
export const TASK_LIMITS = Object.freeze({
  title: 512,
  description: 8192,
  acceptance: 8192,
  notes: 8192,
  design: 8192,
  /** A year of minutes. */
  estimateMinutes: 525_600,
  comment: 4096,
  reason: 2048,
  labels: 32,
  label: 128,
  links: 32,
  actor: 128,
  /** A retry principal: the sender's stable identity that idempotency keys are kept under. */
  retryPrincipal: 128,
  /** The most tasks one list request returns. */
  page: 200,
});

/** A JSON value, as stored in a task's metadata, choices and history. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };

export interface Project {
  readonly id: string;
  /** The name people know the project by, such as a domain or a repository. */
  readonly key: string;
  readonly name: string;
  /** Starts every task id in the project. */
  readonly prefix: string;
  readonly createdAt: string;
}

/** Another task this one links to, with enough of it to show the link. */
export interface TaskLink {
  readonly taskId: string;
  readonly type: DependencyType;
  readonly title: string;
  readonly status: TaskStatus;
}

/** How the task's current close ended. Earlier closes are in its history. */
export interface TaskClose {
  readonly at: string;
  readonly reason: string | null;
  readonly resolution: TaskResolution;
  /** The other task, for a close as a duplicate. */
  readonly duplicateOf: string | null;
  /** Null on a task imported without a recorded closer. */
  readonly by: string | null;
  readonly model: string | null;
}

export interface Task {
  readonly id: string;
  readonly projectId: string;
  readonly parentId: string | null;
  readonly type: TaskType;
  /** For a gate: who answers it. */
  readonly awaitType: 'human' | null;
  readonly status: TaskStatus;
  readonly priority: number;
  readonly title: string;
  readonly description: string;
  readonly acceptance: string;
  /** Markdown, as description is: what those working on it record as it moves, such as progress and findings. */
  readonly notes: string;
  /** Markdown, as description is: how the work is to be built. */
  readonly design: string;
  /** How long the work should take, in whole minutes; null when nobody estimated it. */
  readonly estimateMinutes: number | null;
  readonly assignee: string | null;
  readonly assigneeModel: string | null;
  readonly labels: readonly string[];
  /** The tasks this one depends on. */
  readonly dependencies: readonly TaskLink[];
  /** The tasks that depend on this one. */
  readonly dependents: readonly TaskLink[];
  /** Whether someone can start the task now, as the engine worked it out. */
  readonly ready: boolean;
  readonly deferUntil: string | null;
  readonly dueAt: string | null;
  /** A decision's options, and the option a person chose. */
  readonly choices: JsonObject | null;
  readonly choice: JsonObject | null;
  /** Fields that other systems attach, stored and returned as given. */
  readonly metadata: JsonObject;
  readonly commentCount: number;
  /** Null on a task imported without a recorded filer. */
  readonly filedBy: string | null;
  readonly filedModel: string | null;
  readonly close: TaskClose | null;
  /** Raised by one with every change; a write names the version it read. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
}

export interface TaskComment {
  readonly id: string;
  readonly taskId: string;
  readonly author: string;
  readonly text: string;
  readonly createdAt: string;
}

/** One change to a task, as its history records it. */
export interface TaskEvent {
  /** Orders every change in the installation; never reused. */
  readonly seq: number;
  readonly taskId: string;
  readonly projectId: string;
  /** The task's version after this change. */
  readonly version: number;
  readonly kind: TaskEventKind;
  readonly actor: string;
  readonly model: string | null;
  readonly at: string;
  /** The fields this change set, with their new values. A created event holds every field. */
  readonly changes: JsonObject;
}

/** An epic and how far its children have got. */
export interface EpicProgress {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority: number;
  readonly children: number;
  readonly closedChildren: number;
  /** Open, with every child closed. */
  readonly eligibleForClose: boolean;
}

function isOneOf<T extends string>(values: readonly T[]) {
  return (value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value);
}

export const isTaskStatus = isOneOf(TASK_STATUSES);
export const isTaskType = isOneOf(TASK_TYPES);
export const isDependencyType = isOneOf(DEPENDENCY_TYPES);
export const isTaskResolution = isOneOf(TASK_RESOLUTIONS);
