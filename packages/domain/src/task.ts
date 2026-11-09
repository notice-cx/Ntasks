/**
 * The task model's vocabulary and record shapes. docs/concepts.md introduces
 * each term. The lists below are also CHECK constraints in
 * workers/api/src/store/migrations/0001_task_store.sql; the Worker's schema tests fail
 * when the two disagree.
 */

/** A task's state. `closed` is reached only by closing the task, never by setting it. */
export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'deferred', 'closed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** `gate` is a request to a person that a task waits on: an approval, or, with
 * steps, a request that they do those steps. People see it as that request,
 * not as a task type. */
export const TASK_TYPES = ['task', 'bug', 'feature', 'epic', 'chore', 'decision', 'gate'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * `blocks` keeps the dependent task out of ready work; the others only record
 * a link. A link reads from the task that has it to the other one: web-2
 * `duplicates` web-1, the same work filed again; web-3 `supersedes` web-1,
 * the work that replaces it.
 */
export const DEPENDENCY_TYPES = ['blocks', 'related', 'discovered-from', 'duplicates', 'supersedes'] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

/** What a page outside Ntasks that a task links to is. */
export const EXTERNAL_LINK_KINDS = ['pull-request', 'document', 'other'] as const;
export type ExternalLinkKind = (typeof EXTERNAL_LINK_KINDS)[number];

/**
 * What a project's custom field holds. Its values are, by type: text; a
 * finite number; a date as YYYY-MM-DD; one of the field's options; a list of
 * its options, in the field's order; an http or https URL; true or false.
 */
export const FIELD_TYPES = ['text', 'number', 'date', 'single-choice', 'multiple-choice', 'url', 'yes-no'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
/** The field types that take options. */
export const CHOICE_FIELD_TYPES = ['single-choice', 'multiple-choice'] as const satisfies readonly FieldType[];

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

/**
 * Where a closed task's change is. A task closed as done with a commit or a
 * pull request is built; a signal from the repository moves it to merged, and
 * to live once a deploy ships it. A project whose changes do not go live by a
 * deploy stops at merged. A task only moves forward.
 */
export const DELIVERY_STAGES = ['built', 'merged', 'live'] as const;
export type DeliveryStage = (typeof DELIVERY_STAGES)[number];

/** A commit as a delivery records it: 7 to 64 lowercase hexadecimal characters. */
export const COMMIT_SHA = /^[0-9a-f]{7,64}$/u;

/** What a history event records. A comment is `commented`; every other write is one of the rest. */
export const TASK_EVENT_KINDS = ['created', 'updated', 'closed', 'reopened', 'commented'] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

/**
 * What a task's holder records about the work in hand: a link or id of the
 * agent session doing it, its worktree, its branch, its pull request's URL,
 * the commit last tested and the next step. A newer value of each replaces
 * the older one. They are cleared when the task closes or its holder changes.
 */
export const WORK_DETAILS = ['session', 'worktree', 'branch', 'pr', 'commit', 'next'] as const;
export type WorkDetail = (typeof WORK_DETAILS)[number];
/** A task's work details: only those its holder recorded. */
export type TaskWork = Readonly<Partial<Record<WorkDetail, string>>>;
/** The most characters a new write takes in each work detail, each one line. `pr` is an http or https URL. */
export const WORK_LIMITS: Readonly<Record<WorkDetail, number>> = Object.freeze({
  session: 512,
  worktree: 512,
  branch: 255,
  pr: 2048,
  commit: 128,
  next: 512,
});

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
  externalLinks: 32,
  externalLinkUrl: 2048,
  externalLinkTitle: 512,
  /** Custom fields a project defines, retired ones included. */
  fields: 64,
  fieldKey: 64,
  fieldName: 128,
  /** Options of one choice field, and the characters of each. */
  fieldOptions: 64,
  fieldOption: 128,
  /** A text field's value. */
  fieldText: 1024,
  actor: 128,
  /** The name of the helper agent a holder works through: claude for page-rebuild-2. */
  helper: 64,
  /** A retry principal: the sender's stable identity that idempotency keys are kept under. */
  retryPrincipal: 128,
  /** The most tasks one list request returns. */
  page: 200,
  /** The most other tasks one write changes beside its own: the open tasks
   * waiting on one approval, which a decision on it tells or hands back. */
  others: 500,
  /** The steps of one request that a person do steps, and the characters of
   * each one's text, its command, and a person's note or reason on it. */
  steps: 20,
  stepText: 1024,
  stepCommand: 4096,
  stepNote: 1024,
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
  /** Its changes go live by a deploy; when false, merged is the last stage of a task's delivery. */
  readonly deploys: boolean;
  readonly createdAt: string;
}

/** Another task this one links to, with enough of it to show the link. */
export interface TaskLink {
  readonly taskId: string;
  readonly type: DependencyType;
  readonly title: string;
  readonly status: TaskStatus;
}

/** A page outside Ntasks that a task links to, such as a pull request. */
export interface ExternalLink {
  /** An http or https URL, as the URL standard writes it; a task links to a URL once. */
  readonly url: string;
  readonly title: string;
  readonly kind: ExternalLinkKind | null;
}

/** A custom field's value, as its type takes it (FIELD_TYPES). */
export type FieldValue = string | number | boolean | readonly string[];

/** A field a project defines, which its tasks carry values of. */
export interface CustomField {
  readonly projectId: string;
  /** Names the field in a task's `fields` and in filters: a lowercase letter,
   * then lowercase letters, digits, underscores or hyphens. */
  readonly key: string;
  readonly name: string;
  readonly type: FieldType;
  /** A choice field's options, in order; null for any other type. */
  readonly options: readonly string[] | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
  /** When it was retired. A retired field takes no new values; the values
   * tasks carry stay, and so does their history. */
  readonly retiredAt: string | null;
  readonly retiredBy: string | null;
}

/** Who recorded something on a step, and when. */
export interface StepMark {
  readonly by: string;
  /** The client id of the connected app the person marked it through; absent in their own session. */
  readonly app?: string;
  readonly at: string;
}

/**
 * One step of a request that a person do steps: what to do, the command to
 * run when there is one, and what the person recorded on it. Only a person
 * records the marks; the text and the command stay as the request was filed.
 */
export interface TaskStep {
  /** Markdown, one paragraph. */
  readonly text: string;
  /** The exact command or query to run, shown as a block to copy; null when the step has none. */
  readonly command: string | null;
  /** Who ticked it and when; null while it is not done. */
  readonly done: StepMark | null;
  /** A value or remark the person left on it, such as one the agent asked for. */
  readonly note: (StepMark & { readonly text: string }) | null;
  /** Where the person stopped, and why; null unless they are stuck on it. A tick clears it. */
  readonly stuck: (StepMark & { readonly reason: string }) | null;
}

/** One of a task's "done when" criteria as a person accepted the task: its text, and whether they found it met. */
export interface AcceptedCriterion {
  readonly text: string;
  /** False when the person waived it: they accepted the task as done without it. */
  readonly met: boolean;
}

/**
 * A person's acceptance of a task as done on their own call: they judged it
 * done, waiving any of its criteria they found unmet or no longer relevant.
 * Only a person accepts a task; an agent passing on their acceptance is
 * recorded in `relayed`, and the person can dispute it.
 */
export interface TaskAcceptance {
  /** The person who accepted it. */
  readonly by: string;
  /** The client id of the connected app they accepted it through; absent in their own session and when relayed. */
  readonly app?: string;
  /** Who passed the acceptance on for the person, where they gave it, and their words; absent when they accepted it themselves. */
  readonly relayed?: { readonly by: string; readonly source: string; readonly quote: string };
  /** The task's criteria when it was accepted (criteriaOf), in order: none when its acceptance was empty. */
  readonly criteria: readonly AcceptedCriterion[];
}

/** The reason a person's acceptance closes a task with when they give none of their own. */
export const ACCEPTED_REASON = 'Accepted as done';

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
  /** A close as done may name a URL that shows the work, for work that left no commit or pull request. */
  readonly link: string | null;
  /** A close as done on a person's own call; null on every other close. */
  readonly acceptance: TaskAcceptance | null;
}

/** Where a closed task's change is, and when it got to each stage. */
export interface TaskDelivery {
  readonly stage: DeliveryStage;
  /** The commit the task closed with. */
  readonly commit: string | null;
  /** The pull request the task closed with, as a URL. */
  readonly pullRequest: string | null;
  /** The commit that merged it, when the merge's signal named one. */
  readonly mergeCommit: string | null;
  readonly builtAt: string;
  /** Null until a signal said it merged; a task can go live without one. */
  readonly mergedAt: string | null;
  readonly liveAt: string | null;
}

export interface Task {
  readonly id: string;
  readonly projectId: string;
  readonly parentId: string | null;
  readonly type: TaskType;
  /** For a gate: who answers it. */
  readonly awaitType: 'human' | null;
  /** For a gate that asks a person to do steps: the steps, in order. Null on an approval and on any other task. */
  readonly steps: readonly TaskStep[] | null;
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
  /** The helper agent the assignee works through, which the assignee named; null when it named none. */
  readonly assigneeFor: string | null;
  /** What the assignee recorded about the work in hand. Empty while nobody holds the task, and once it closes. */
  readonly work: TaskWork;
  /** When the assignee last changed or commented on the task: its latest event in the task's history. Null
   * while nobody holds it, or before the assignee has written to it. It is shown, and never releases a claim. */
  readonly lastActivityAt: string | null;
  readonly labels: readonly string[];
  /** The tasks this one depends on. */
  readonly dependencies: readonly TaskLink[];
  /** The tasks that depend on this one. */
  readonly dependents: readonly TaskLink[];
  /** Pages outside Ntasks, ordered by URL. */
  readonly externalLinks: readonly ExternalLink[];
  /** The values of its project's custom fields that it carries, by field key. */
  readonly fields: Readonly<Record<string, FieldValue>>;
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
  /** Where its change is: only on a task closed as done with a commit or a pull request. */
  readonly delivery: TaskDelivery | null;
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

/** The types whose close as done shows what proves it: a commit, a pull
 * request, a link or a person's acceptance. A decision, a gate and an epic
 * close without one. */
export const PROVED_TYPES = ['task', 'bug', 'feature', 'chore'] as const satisfies readonly TaskType[];

/** A task of a type that shows proof, closed as done with no commit, pull request, link or person's acceptance. */
export function lacksProof(task: Pick<Task, 'type' | 'close' | 'delivery'>): boolean {
  return (
    task.close?.resolution === 'done' &&
    (PROVED_TYPES as readonly TaskType[]).includes(task.type) &&
    task.delivery === null &&
    task.close.link === null &&
    task.close.acceptance === null
  );
}

/** How long a held task in progress goes without its holder's activity before it is stalled. */
export const STALLED_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a task is stalled at `now` (an ISO time): in progress and held, and
 * its holder has done nothing on it for STALLED_AFTER_MS, or never recorded
 * anything on it. It is shown only: time alone never frees a claim.
 */
export function isStalled(task: Pick<Task, 'status' | 'assignee' | 'lastActivityAt'>, now: string): boolean {
  if (task.status !== 'in_progress' || task.assignee === null) return false;
  if (task.lastActivityAt === null) return true;
  return Date.parse(now) - Date.parse(task.lastActivityAt) >= STALLED_AFTER_MS;
}

/** A task one holder holds, with what the holder recorded about the work in hand. */
export interface HeldTask {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly priority: number;
  readonly assigneeFor: string | null;
  readonly work: TaskWork;
  readonly lastActivityAt: string | null;
}

function isOneOf<T extends string>(values: readonly T[]) {
  return (value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value);
}

export const isTaskStatus = isOneOf(TASK_STATUSES);
export const isTaskType = isOneOf(TASK_TYPES);
export const isDependencyType = isOneOf(DEPENDENCY_TYPES);
export const isExternalLinkKind = isOneOf(EXTERNAL_LINK_KINDS);
export const isFieldType = isOneOf(FIELD_TYPES);
export const isTaskResolution = isOneOf(TASK_RESOLUTIONS);
export const isDeliveryStage = isOneOf(DELIVERY_STAGES);
