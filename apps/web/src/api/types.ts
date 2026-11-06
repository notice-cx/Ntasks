/**
 * What the Tasks API answers, as the app reads it. These are the HTTP shapes
 * of NoticeOS's `/api/tasks` (its `LiveTask`, `LiveTasksPayload` and
 * `LiveTaskDetail`), which the Ntasks API keeps so both apps read one format.
 * Statuses, types and link types stay strings here: a value this build has
 * never seen is drawn as itself instead of breaking the page.
 */
import type { TaskResolution } from '@ntasks/domain';

/** Option keys, in the order options are shown. */
export const TASK_CHOICE_KEYS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
export type TaskChoiceKey = (typeof TASK_CHOICE_KEYS)[number];

export interface TaskChoiceOption {
  readonly key: TaskChoiceKey;
  /** One line: the words on the option's button. */
  readonly label: string;
  readonly detail?: string;
  /** On exactly one option of a set. */
  readonly recommended?: true;
}

/** The options a decision offers a person. */
export interface TaskChoices {
  readonly question: string;
  readonly options: readonly TaskChoiceOption[];
}

/** A person's pick, as the choose operation records it. */
export interface TaskChoice {
  readonly option: TaskChoiceKey;
  /** The option's label when it was chosen. */
  readonly label: string;
  readonly by: string;
  readonly at: string;
  readonly note?: string;
}

/** One link from a task to another task. */
export interface TaskDependency {
  /** The task on the other end. */
  id: string;
  /** `blocks`, `parent-child`, `related`, `discovered-from`, or a type this build does not know. */
  type: string;
  /** Present when the read carried it (a task's own read); null on a list row. */
  title: string | null;
  /** The other task's status, when the read carried it. */
  status: string | null;
}

/** One task, as a board row and a task page read it. */
export interface LiveTask {
  id: string;
  title: string;
  status: string;
  /** 0 is the most urgent, 4 the least. */
  priority: number;
  issueType: string;
  assignee: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  createdAt: string | null;
  /** The epic this task belongs to, or null. */
  parent: string | null;
  deferUntil: string | null;
  choices?: TaskChoices | null;
  choice?: TaskChoice | null;
  /** How a closed task's close ended; null on a task that is not closed. */
  resolution?: TaskResolution | null;
  duplicateOf?: string | null;
  /** Empty when the task carries none. */
  description: string;
  acceptance: string;
  labels: string[];
  /** Someone can start it now, as the server worked it out. */
  ready: boolean;
  dependencies: TaskDependency[];
  /** How many comments the task carries; the bodies come with the task's own read. */
  comments: number;
  /** Fields other systems attach, stored and returned as given. */
  metadata: Record<string, unknown> | null;
  /** When someone claimed it, null while nobody has. */
  startedAt: string | null;
  /** The close's evidence: a commit, a link, or why nothing shipped. */
  closeReason: string | null;
  /** `human` on an approval a person answers; null on every other task. */
  awaitType: string | null;
  /** Who closed the task and the model they named, when the server sends them. */
  closedBy?: string | null;
  closedModel?: string | null;
  /** The model the assignee named when they claimed the task, when the server sends it. */
  assigneeModel?: string | null;
}

/** An epic with its all-time child progress. */
export interface LiveEpic {
  id: string;
  title: string;
  status: string;
  priority: number;
  total: number;
  closed: number;
  /** Open, with every child closed. */
  eligibleForClose: boolean;
}

/** A person the API names, for a task field that holds their id. */
export interface TaskActor {
  readonly principalId: string;
  readonly displayName: string;
}

/** One project's board: its open, in-progress, blocked and parked tasks, and its recent closes. */
export interface LiveTasksPayload {
  actors?: readonly TaskActor[];
  /** The project's key. */
  project: string;
  prefix: string;
  repo: string;
  /** When the server read the tasks. */
  readAt: string;
  /** The earliest close time the closed tasks in `tasks` cover. */
  closedSince?: string;
  tasks: LiveTask[];
  /** Null when the server could not read the epics' progress. */
  epics: LiveEpic[] | null;
}

export interface TaskComment {
  id: string;
  author: string;
  text: string;
  createdAt: string | null;
}

/** One task and its comments: the task page's read. */
export interface LiveTaskDetail {
  actors?: readonly TaskActor[];
  project: string;
  prefix: string;
  repo: string;
  readAt: string;
  task: LiveTask;
  comments: TaskComment[];
}

/** What creating a task answers with. */
export interface TaskCreated {
  id: string;
  project: string;
}

/** What this sign-in may do. */
export interface TasksCapabilities {
  live: boolean;
  writable?: boolean;
  /** Every read and write names its project. */
  projectSelection?: boolean;
  /** The write operations offered; absent means all of them. */
  operations?: readonly string[];
  /** The fields an update may change; absent means all of them. */
  editableFields?: readonly string[];
  reason: string | null;
}

/** One project, as the project list names it. */
export interface TaskProject {
  projectId: string;
  /** The key the app addresses the project by in its addresses and reads. */
  logicalKey: string;
  displayName: string;
  prefix: string;
}

/** A new task. */
export interface NewTask {
  /** The project's key. */
  project: string;
  title: string;
  description?: string;
  type?: string;
  priority?: number;
  labels?: string[];
  parent?: string;
  acceptance?: string;
  metadata?: Record<string, unknown>;
}

/** The fields an edit may change. */
export interface TaskEdit {
  /** Take the task: the sender becomes its assignee and it moves to in progress. */
  claim?: true;
  status?: string;
  priority?: number;
  assignee?: string;
  parent?: string;
  /** A date, `YYYY-MM-DD`; the empty string clears it. */
  defer?: string;
  title?: string;
  description?: string;
  acceptance?: string;
  addLabels?: string[];
  removeLabels?: string[];
}

/** How a close ended when it is not done, and for a duplicate the other task. */
export interface CloseOptions {
  resolution?: TaskResolution;
  duplicateOf?: string;
}
