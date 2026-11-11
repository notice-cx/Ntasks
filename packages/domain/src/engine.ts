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
import type { BurndownRead } from './burndown.ts';
import type {
  CustomField,
  DeliveryStage,
  DependencyType,
  EpicProgress,
  ExternalLink,
  ExternalLinkKind,
  FieldType,
  FieldValue,
  HeldTask,
  Json,
  JsonObject,
  ParentContext,
  Project,
  ProjectIcon,
  StoredProjectIcon,
  Task,
  TaskAcceptance,
  TaskComment,
  TaskEvent,
  TaskResolution,
  TaskStatus,
  TaskStep,
  TaskType,
  TaskWork,
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
  /**
   * The key was derived from the request, not chosen by its caller. Its record
   * answers only while every task the write left stands at the version it was
   * left at, and a record of new tasks also only for a day; after that the
   * same request is a new write, whose record replaces the old one.
   */
  readonly derived?: boolean;
}

export interface CreateProjectInput {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly prefix: string;
}

/** A change to a project: each field it names, and only those. */
export interface ProjectChange {
  readonly name?: string;
  /** Whether its changes go live by a deploy. */
  readonly deploys?: boolean;
  /** Whether it refuses new tasks. */
  readonly disabled?: boolean;
  /** Its website and the icon read from it, which replace the ones it had; null clears both. */
  readonly website?: { readonly url: string; readonly icon: ProjectIcon | null } | null;
}

/** A link a new task starts with. */
export interface NewTaskLink {
  /** `depends-on`: the new task waits on `taskId` (for `blocks`) or links to it.
   * `blocks`: `taskId` waits on the new task. */
  readonly direction: 'depends-on' | 'blocks';
  readonly taskId: string;
  readonly type: DependencyType;
}

/** An approval to open. `reason` is its description: the request a person
 * answers. `title` is its title; left out, the reason's first line that is
 * not blank. */
export interface ApprovalRequest {
  readonly reason: string;
  readonly title?: string;
}

/** A step of a new request that a person do steps: its text, and the command it runs when it runs one. */
export interface NewTaskStep {
  readonly text: string;
  readonly command?: string;
}

/** A request that a person do steps, to open: the gate's title, its context
 * in Markdown as its description, and its steps in order. */
export interface ActionRequest {
  readonly title: string;
  readonly context: string;
  readonly steps: readonly NewTaskStep[];
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
  readonly requestApproval?: ApprovalRequest;
  /** Files the task claimed by the actor: assigned to it and in progress. */
  readonly claim?: true;
  /** Files the task closed as done by the actor, held by nobody,
   * with what proves it, as a close records it. Not with `claim` or `requestApproval`. */
  readonly close?: {
    readonly reason: string;
    readonly commit?: string;
    readonly pullRequest?: string;
    readonly link?: string;
  };
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
  /** The helper agent the assignee works through. */
  readonly assigneeFor?: string;
  /** Work details, each replacing the one the task has. With the helper, they
   * belong to the assignee: a write that releases the task, gives it to
   * someone else or closes it clears them, and one that leaves it held by
   * nobody, or closed, cannot set them. */
  readonly work?: TaskWork;
  readonly parentId?: string | null;
  readonly deferUntil?: string | null;
  readonly dueAt?: string | null;
  readonly choices?: JsonObject | null;
  /** A person's pick of one of the task's choices. */
  readonly choice?: JsonObject | null;
  /** A person's marks on a request's steps, as the whole list. Only a gate
   * that asks for steps has them, and each step keeps its text and command. */
  readonly steps?: readonly TaskStep[];
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
  readonly requestApproval?: ApprovalRequest;
  /** Opens a request that a person do steps: a gate this task waits on until
   * they tick every step. Not with `requestApproval`. The new gate's id is in
   * the result's `created`. */
  readonly requestAction?: ActionRequest;
  /** Closes the task, recording the actor as the closer. Refused on a task
   * that is already closed. A close as done with a commit or a pull request
   * URL starts the task's delivery at built. */
  readonly close?: {
    readonly reason: string;
    readonly resolution: TaskResolution;
    readonly duplicateOf?: string;
    /** 7 to 64 lowercase hexadecimal characters (COMMIT_SHA). */
    readonly commit?: string;
    /** An http or https URL. */
    readonly pullRequest?: string;
    /** With done: an http or https URL that shows the work, such as a document or a dashboard. */
    readonly link?: string;
    /** With done, and with no commit, pull request or link: a person's
     * acceptance of the task as done on their own call. The API layer decides
     * that the sender may record it; only a person's decision does. */
    readonly acceptance?: TaskAcceptance;
  };
  /** Opens a closed task again. Its earlier close stays in its history (rule 6). */
  readonly reopen?: true;
  /** A comment added in the same change, such as the answer behind it. */
  readonly comment?: string;
  /** How `comment` changes the task's pinned comments. Only with `comment`. */
  readonly pins?: CommentPins;
  /** Changes to other tasks of the same project, in the same batch: a decision
   * on an approval that also tells, or hands back, the tasks waiting on it. */
  readonly others?: readonly OtherTaskWrite[];
}

/**
 * How a new comment changes its task's pinned comments: it can be pinned
 * itself, and unpin earlier pinned comments of the same task, such as facts
 * it corrects. Pinning never changes the task's version, as a comment does not.
 */
export interface CommentPins {
  /** Pins the new comment. */
  readonly pin?: true;
  /** Pinned comments of the task to unpin, by id; each must be pinned. At most TASK_LIMITS.unpin. */
  readonly unpin?: readonly string[];
}

/**
 * A change to another task, riding with a write. Each names the version it
 * read, as the write does, and the whole write is refused as
 * `version_conflict` when the task moved since. One that only adds a comment
 * leaves the task's version as it is, as `addComment` does.
 */
export interface OtherTaskWrite extends Omit<TaskWrite, 'requestApproval' | 'requestAction' | 'others' | 'pins'> {
  readonly taskId: string;
}

/** Where a move puts one task: under `parentId`, in the project the move names. */
export interface TaskPlacement {
  readonly taskId: string;
  /** The task's version when the caller read it (rule 2). */
  readonly expectedVersion: number;
  /** The task it goes under: one of the project's, or another task of the same
   * move, named by its id before the move. Null puts it under none. */
  readonly parentId: string | null;
}

/** A task a move gave a new id: its id before the move, and after. */
export interface MovedId {
  readonly from: string;
  readonly to: string;
}

export interface MoveResult {
  /** Each task the move placed, as it stands after it, in the order placed. */
  readonly tasks: readonly Task[];
  /** The tasks whose id the move changed, in the order placed. */
  readonly moved: readonly MovedId[];
  /** The epics the move closed or reopened on its own, deepest first, when it changed any. */
  readonly epics?: readonly Task[];
  /** True when a retry returned the recorded answer and nothing was written. */
  readonly replayed: boolean;
}

/** A former id of a moved task, and the task's id and project now. */
export interface FormerId {
  readonly formerId: string;
  readonly taskId: string;
  readonly projectId: string;
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
  /** Only closed tasks at these stages of delivery, whenever they closed, or
   * with `closedSince` from that time. No open task has a stage, so the
   * statuses are left out of a read by stage. */
  readonly stages?: readonly DeliveryStage[];
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

/** What agent statistics count of one task: who holds or closed it, with the
 * models they named, and when it started and closed. No text of the task. */
export interface WorkItem {
  readonly id: string;
  readonly projectId: string;
  readonly type: TaskType;
  readonly awaitType: 'human' | null;
  readonly status: TaskStatus;
  readonly priority: number;
  readonly assignee: string | null;
  readonly assigneeModel: string | null;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly closedModel: string | null;
}

/** What the wins feed reads of one task (workers/api/src/wins.ts): a change
 * merged or live, a person's answer to its choices, or an epic or an approval
 * closed as done. No description or comments. */
export interface WinItem {
  readonly id: string;
  readonly projectId: string;
  readonly type: TaskType;
  readonly title: string;
  readonly status: TaskStatus;
  readonly resolution: TaskResolution | null;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly closedModel: string | null;
  /** The option a person chose, as the task records it, with `at` and `by`. */
  readonly choice: JsonObject | null;
  readonly pullRequest: string | null;
  readonly commit: string | null;
  readonly mergeCommit: string | null;
  readonly stage: DeliveryStage | null;
  readonly mergedAt: string | null;
  readonly liveAt: string | null;
  /** For an epic closed as done: its direct children closed as done. 0 for any other task. */
  readonly done: number;
}

/** The wins of a time span, and whether any change shipped before it. */
export interface WinsRead {
  readonly items: readonly WinItem[];
  /** Whether a change in these projects reached merged or live before the span began. */
  readonly shippedBefore: boolean;
}

/** A repository's word that pull requests or commits reached a stage. */
export interface DeliverySignal {
  readonly stage: Exclude<DeliveryStage, 'built'>;
  /** Pull request URLs, written as the task's delivery records them. */
  readonly pullRequests: readonly string[];
  /** Commits, each 7 to 64 lowercase hexadecimal characters (COMMIT_SHA). */
  readonly commits: readonly string[];
  /**
   * With live: only tasks recorded as merged at or before this time, as UTC
   * ISO 8601 text. A deploy that started before a task's merge was a preview
   * of it, not the deploy that shipped it.
   */
  readonly mergedBy?: string;
  /**
   * When the change reached the stage, as the sender knows it, such as the
   * time GitHub merged a pull request, in UTC ISO 8601 text. Left out, or
   * later than the signal's arrival, it is the arrival.
   */
  readonly at?: string;
}

/**
 * How a signal treats the projects of the tasks it names. With
 * `turnOnDeploys`, a `live` signal first marks each such project that does
 * not deploy as one that does, unless `except` names it, so its tasks go
 * live: a deploy its repository reported shows the project deploys.
 */
export interface DeliveryOptions {
  readonly turnOnDeploys?: { readonly except: readonly string[] };
}

/** A task a signal moved, and the stage it moved to. */
export interface DeliveryMove {
  readonly taskId: string;
  readonly projectId: string;
  readonly stage: DeliveryStage;
}

export interface WriteResult {
  readonly task: Task;
  /** Tasks the write made as well, such as the gate of a requested approval. */
  readonly created: readonly Task[];
  /** The comment the write added to `task`, when it added one. */
  readonly comment?: TaskComment;
  /** The epics the write closed or reopened on its own, deepest first, when it changed any (STATE-22). */
  readonly epics?: readonly Task[];
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
  /** Renames the project, says whether its changes go live by a deploy and whether it takes new tasks, and sets its website. */
  updateProject(projectId: string, change: ProjectChange): Promise<Project>;
  /** The icon kept for the project, or null when it has none. */
  projectIcon(projectId: string): Promise<StoredProjectIcon | null>;

  /** Null when the project holds no such task. */
  getTask(projectId: string, taskId: string): Promise<Task | null>;
  /** Of these ids, the ones that are a moved task's former id, each with the
   * task's id and project now, in one read through the former ids' key. */
  formerIds(taskIds: readonly string[]): Promise<readonly FormerId[]>;
  /** These tasks of the project, in one read; an id the project does not hold is left out. */
  getTasks(projectId: string, taskIds: readonly string[]): Promise<readonly Task[]>;
  /** Every task under these tasks of the project, at any depth and in any
   * status, at most `limit` (1 to TASK_LIMITS.page), in one read through the
   * parent index: its cost follows the tasks under them, not the project. */
  listUnder(projectId: string, taskIds: readonly string[], limit: number): Promise<readonly Task[]>;
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
  /** What agent statistics count, for the tasks of these projects that are in
   * progress or blocked or that closed at or after `closedSince`, in one
   * statement whatever the number of projects. */
  listWork(projectIds: readonly string[], closedSince: string): Promise<readonly WorkItem[]>;
  /**
   * The wins from `from` until `to` in these projects: changes that reached
   * merged or live, answers a person gave to a task's choices, and epics and
   * approvals closed as done. It reads the tasks not closed and the tasks
   * closed from `closedSince` on through their indexes, so a change merged
   * after its task closed is found while that close is at or after
   * `closedSince`. Its cost follows that window, not the history.
   */
  listWins(projectIds: readonly string[], from: string, to: string, closedSince: string): Promise<WinsRead>;
  /**
   * What a burn-down from `from` counts in these projects (burndown.ts): the
   * tasks not closed and those closed at or after `from`, each through its
   * index, and whether any closed before it. Its cost follows the open tasks
   * and that window, not the history.
   */
  listBurndown(projectIds: readonly string[], from: string): Promise<BurndownRead>;
  /** The open tasks `assignee` holds, in every project, most urgent first, in
   * one statement through the assignee index: its cost follows the tasks held. */
  listHeld(assignee: string): Promise<readonly HeldTask[]>;
  /** The earliest time after `time` at which any task stops being deferred,
   * or null when none will. Ready work can change then without any write,
   * since a deferred parent holds its children back even once it is closed,
   * so a cached read of it stays true until that time. */
  nextDeferralAfter(time: string): Promise<string | null>;
  listComments(projectId: string, taskId: string): Promise<readonly TaskComment[]>;
  /** What the task's parent holds for it (ParentContext), cut to
   * PARENT_CONTEXT_LIMITS; null when the task has no parent or the project
   * holds no such task. Its cost follows the parent's pinned comments and
   * children, not the parent's other comments or the project's size. */
  parentContext(projectId: string, taskId: string): Promise<ParentContext | null>;
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

  /** The answer of an earlier moveTasks with this retry identity, its tasks as
   * they stand now and `replayed: true`, or null when no move in the last
   * seven days used the key; refused as `retry_conflict` as recordedWrite is. */
  recordedMove(projectId: string, retry: Retry): Promise<MoveResult | null>;

  createTask(projectId: string, input: CreateTaskInput, actor: Actor, retry?: Retry): Promise<WriteResult>;
  /** Changes an existing task in one batch (rules 1 to 4). */
  writeTask(projectId: string, taskId: string, write: TaskWrite, actor: Actor, retry?: Retry): Promise<WriteResult>;
  /**
   * Puts tasks of any project of the store into project `projectId`, each
   * under the parent its placement names, in one batch (rules 2 to 4). A task
   * from another project takes a new id with this project's prefix: the next
   * child id of its new parent, or a new key; its old id becomes a former id
   * (formerIds) and everything filed under it follows it. A task from another
   * project moves only with every task under it among the placements, which
   * keep their parents. Other tasks that name a moved task as their parent or
   * the task they duplicate follow it too, each with its own history event.
   * The epics a task leaves or joins close or reopen as a write's do. A
   * placement that leaves a task where it is changes nothing.
   */
  moveTasks(projectId: string, placements: readonly TaskPlacement[], actor: Actor, retry?: Retry): Promise<MoveResult>;
  /** Defines a custom field in the project. A key the project has used,
   * retired or not, is refused as `invalid`. */
  defineField(projectId: string, input: DefineFieldInput, actor: Actor, retry?: Retry): Promise<FieldResult>;
  /** Retires a custom field: it takes no new values from then on. Retiring a
   * retired field changes nothing. */
  retireField(projectId: string, key: string, actor: Actor, retry?: Retry): Promise<FieldResult>;
  /**
   * Moves the closed tasks of these projects that a signal names to its
   * stage: each built or merged task whose pull request, commit or merge
   * commit matches one the signal names. Two commits match when one is a
   * prefix of the other. A project that does not deploy stops its tasks at
   * merged. A task never moves back, so a repeated signal moves nothing. A
   * merged signal that names exactly one commit records it as the merge
   * commit of each task it moves. Each move is a change with its history
   * (rules 2 and 4), all in one batch.
   */
  reportDelivery(
    projectIds: readonly string[],
    signal: DeliverySignal,
    actor: Actor,
    options?: DeliveryOptions,
  ): Promise<readonly DeliveryMove[]>;
  /** Adds a comment, pinning it or unpinning others as `pins` says. It does
   * not change the task's version, so it never conflicts with a write. */
  addComment(
    projectId: string,
    taskId: string,
    text: string,
    actor: Actor,
    retry?: Retry,
    pins?: CommentPins,
  ): Promise<CommentResult>;
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
