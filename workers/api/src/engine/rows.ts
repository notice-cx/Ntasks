// The database's rows, and how each becomes a record of the engine contract.
import type {
  ClosedSibling,
  CustomField,
  DeliveryStage,
  DependencyType,
  DroppedLink,
  EpicProgress,
  ExternalLink,
  FieldType,
  FieldValue,
  HeldTask,
  JsonObject,
  Project,
  ProjectIconType,
  StoredProjectIcon,
  Task,
  TaskAcceptance,
  TaskTestResult,
  TaskComment,
  TaskDelivery,
  TaskEvent,
  TaskEventKind,
  TaskLink,
  TaskResolution,
  TaskStatus,
  TaskStep,
  TaskType,
  TaskWork,
  WinItem,
  WorkItem,
} from '@ntasks/domain';

/** A `tasks` row as the table stores it. */
export interface StoredTaskRow {
  readonly id: string;
  readonly project_id: string;
  readonly parent_id: string | null;
  readonly type: TaskType;
  readonly await_type: 'human' | null;
  readonly status: TaskStatus;
  readonly priority: number;
  readonly title: string;
  readonly description: string;
  readonly acceptance: string;
  readonly notes: string;
  readonly design: string;
  readonly estimate_minutes: number | null;
  /** The task's custom field values, as a JSON object by field key. */
  readonly field_values: string;
  readonly assignee: string | null;
  readonly assignee_model: string | null;
  readonly assignee_for: string | null;
  /** The holder's work details, as a JSON object by detail name. */
  readonly work: string;
  readonly defer_until: string | null;
  readonly due_at: string | null;
  readonly choices: string | null;
  readonly choice: string | null;
  readonly metadata: string;
  readonly filed_by: string | null;
  readonly filed_model: string | null;
  readonly close_reason: string | null;
  readonly resolution: TaskResolution | null;
  readonly duplicate_of: string | null;
  readonly closed_by: string | null;
  readonly closed_model: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly closed_at: string | null;
  readonly delivery_stage: DeliveryStage | null;
  readonly delivery_commit: string | null;
  readonly delivery_pull_request: string | null;
  readonly delivery_merge_commit: string | null;
  readonly built_at: string | null;
  readonly merged_at: string | null;
  readonly live_at: string | null;
  readonly close_link: string | null;
  /** A request's steps, as a JSON array, on a gate that asks a person to do steps. */
  readonly steps: string | null;
  /** A person's acceptance of the task as done on their own call, as a JSON object. */
  readonly close_acceptance: string | null;
  /** The test run its close reported, as a JSON object. */
  readonly close_test: string | null;
}

/** A `tasks` row as the engine's reads select it, with the columns they compute. */
export interface TaskRow extends StoredTaskRow {
  /** 1 when someone can start the task now (READY in reads.ts). */
  readonly ready: number;
  /** When its assignee last wrote to it (LAST_ACTIVITY in reads.ts). */
  readonly last_activity_at: string | null;
  readonly comment_count: number;
  /** The task's labels, as a JSON array of text. */
  readonly labels_json: string;
  /** Its links onto other tasks and theirs onto it, as JSON arrays of LinkJson. */
  readonly dependencies_json: string;
  readonly dependents_json: string;
  /** Its links to pages outside Ntasks, as a JSON array of ExternalLink. */
  readonly external_links_json: string;
}

export interface FieldRow {
  readonly project_id: string;
  readonly key: string;
  readonly name: string;
  readonly type: FieldType;
  readonly options: string | null;
  readonly created_at: string;
  readonly created_by: string | null;
  readonly retired_at: string | null;
  readonly retired_by: string | null;
}

/** One link in a TaskRow's JSON: the other task, the link's type, and the other task's title and status. */
interface LinkJson {
  readonly id: string;
  readonly type: DependencyType;
  readonly title: string;
  readonly status: TaskStatus;
  readonly resolution: TaskResolution | null;
  readonly closedAt: string | null;
}

export interface ProjectRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly prefix: string;
  readonly created_at: string;
  readonly deploys: number;
  readonly disabled_at: string | null;
  readonly website_url: string | null;
  /** From project_icons, joined in: when its light and its dark icon were read. */
  readonly icon_at: string | null;
  readonly dark_icon_at: string | null;
}

export interface ProjectIconRow {
  readonly source_url: string;
  readonly content_type: string;
  readonly bytes: ArrayBuffer;
  readonly read_at: string;
}

export interface CommentRow {
  readonly id: string;
  readonly task_id: string;
  readonly author: string;
  readonly text: string;
  readonly created_at: string;
  readonly pinned: number;
  /** The test run it reported, as a JSON object. */
  readonly test: string | null;
}

/** A closed child of a task's parent, as parentContext reads it. */
export interface ClosedSiblingRow {
  readonly id: string;
  readonly title: string;
  readonly resolution: TaskResolution;
  readonly closed_at: string;
  readonly closed_by: string | null;
  readonly close_reason: string | null;
  readonly delivery_commit: string | null;
  readonly delivery_pull_request: string | null;
  readonly close_link: string | null;
}

export interface EventRow {
  readonly seq: number;
  readonly task_id: string;
  readonly project_id: string;
  readonly version: number;
  readonly kind: TaskEventKind;
  readonly actor: string;
  readonly model: string | null;
  readonly at: string;
  readonly changes: string;
  readonly actor_for: string | null;
  readonly session: string | null;
}

export interface EpicRow {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority: number;
  readonly children: number;
  readonly closed_children: number;
}

function object(text: string | null): JsonObject | null {
  return text === null ? null : (JSON.parse(text) as JsonObject);
}

const byId = <T extends { readonly taskId: string }>(a: T, b: T) =>
  a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;

/** A row's links, ordered by the other task's id, so every read lists them alike. */
function links(entries: readonly LinkJson[]): TaskLink[] {
  return entries
    .map((entry) => ({ taskId: entry.id, type: entry.type, title: entry.title, status: entry.status }))
    .sort(byId);
}

const DROPPED: readonly TaskResolution[] = ['wont-do', 'no-longer-needed'];

/** The links another task holds onto this one that this one relies on: that
 * task waits on it, or is about the same subject. */
const RELIED_ON_BY: readonly DependencyType[] = ['blocks', 'related'];

/**
 * The tasks a task that is not closed relies on, dropped after it last
 * changed: those it links to, apart from one it replaces, whose close is
 * expected, and those that wait on it or relate to it.
 */
function droppedSince(row: TaskRow, dependencies: readonly LinkJson[], dependents: readonly LinkJson[]): DroppedLink[] {
  if (row.status === 'closed') return [];
  const dropped = new Map<string, DroppedLink>();
  for (const entry of [
    ...dependencies.filter((link) => link.type !== 'supersedes'),
    ...dependents.filter((link) => RELIED_ON_BY.includes(link.type)),
  ]) {
    const { resolution, closedAt } = entry;
    if (resolution !== null && DROPPED.includes(resolution) && closedAt !== null && closedAt > row.updated_at)
      dropped.set(entry.id, { taskId: entry.id, title: entry.title, resolution });
  }
  return [...dropped.values()].sort(byId);
}

/** External links from their JSON array, ordered by URL, so every read lists them alike. */
export function externalLinks(text: string): ExternalLink[] {
  return (JSON.parse(text) as ExternalLink[]).sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

/** A row's delivery; the schema keeps every delivery column null when its stage is. */
export function deliveryOf(row: StoredTaskRow): TaskDelivery | null {
  if (row.delivery_stage === null || row.built_at === null) return null;
  return {
    stage: row.delivery_stage,
    commit: row.delivery_commit,
    pullRequest: row.delivery_pull_request,
    mergeCommit: row.delivery_merge_commit,
    builtAt: row.built_at,
    mergedAt: row.merged_at,
    liveAt: row.live_at,
  };
}

export function toTask(row: TaskRow): Task {
  const dependencies = JSON.parse(row.dependencies_json) as LinkJson[];
  const dependents = JSON.parse(row.dependents_json) as LinkJson[];
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    type: row.type,
    awaitType: row.await_type,
    steps: row.steps === null ? null : (JSON.parse(row.steps) as TaskStep[]),
    status: row.status,
    priority: row.priority,
    title: row.title,
    description: row.description,
    acceptance: row.acceptance,
    notes: row.notes,
    design: row.design,
    estimateMinutes: row.estimate_minutes,
    assignee: row.assignee,
    assigneeModel: row.assignee_model,
    assigneeFor: row.assignee_for,
    work: JSON.parse(row.work) as TaskWork,
    lastActivityAt: row.last_activity_at,
    labels: (JSON.parse(row.labels_json) as string[]).sort(),
    dependencies: links(dependencies),
    dependents: links(dependents),
    reliesOnDropped: droppedSince(row, dependencies, dependents),
    externalLinks: externalLinks(row.external_links_json),
    fields: JSON.parse(row.field_values) as Record<string, FieldValue>,
    ready: row.ready === 1,
    deferUntil: row.defer_until,
    dueAt: row.due_at,
    choices: object(row.choices),
    choice: object(row.choice),
    metadata: object(row.metadata) ?? {},
    commentCount: row.comment_count,
    filedBy: row.filed_by,
    filedModel: row.filed_model,
    close:
      row.status === 'closed' && row.closed_at !== null && row.resolution !== null
        ? {
            at: row.closed_at,
            reason: row.close_reason,
            resolution: row.resolution,
            duplicateOf: row.duplicate_of,
            by: row.closed_by,
            model: row.closed_model,
            link: row.close_link,
            acceptance: row.close_acceptance === null ? null : (JSON.parse(row.close_acceptance) as TaskAcceptance),
            test: row.close_test === null ? null : (JSON.parse(row.close_test) as TaskTestResult),
          }
        : null,
    delivery: deliveryOf(row),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
  };
}

export function toField(row: FieldRow): CustomField {
  return {
    projectId: row.project_id,
    key: row.key,
    name: row.name,
    type: row.type,
    options: row.options === null ? null : (JSON.parse(row.options) as string[]),
    createdAt: row.created_at,
    createdBy: row.created_by,
    retiredAt: row.retired_at,
    retiredBy: row.retired_by,
  };
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    prefix: row.prefix,
    deploys: row.deploys === 1,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
    websiteUrl: row.website_url,
    iconAt: row.icon_at,
    darkIconAt: row.dark_icon_at,
  };
}

export function toProjectIcon(row: ProjectIconRow): StoredProjectIcon {
  return {
    sourceUrl: row.source_url,
    contentType: row.content_type as ProjectIconType,
    bytes: row.bytes,
    readAt: row.read_at,
  };
}

export function toComment(row: CommentRow): TaskComment {
  return {
    id: row.id,
    taskId: row.task_id,
    author: row.author,
    text: row.text,
    createdAt: row.created_at,
    pinned: row.pinned === 1,
    test: row.test === null ? null : (JSON.parse(row.test) as TaskTestResult),
  };
}

export function toClosedSibling(row: ClosedSiblingRow): ClosedSibling {
  return {
    id: row.id,
    title: row.title,
    resolution: row.resolution,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    reason: row.close_reason,
    commit: row.delivery_commit,
    pullRequest: row.delivery_pull_request,
    link: row.close_link,
  };
}

export function toEvent(row: EventRow): TaskEvent {
  return {
    seq: row.seq,
    taskId: row.task_id,
    projectId: row.project_id,
    version: row.version,
    kind: row.kind,
    actor: row.actor,
    model: row.model,
    actorFor: row.actor_for,
    session: row.session,
    at: row.at,
    changes: JSON.parse(row.changes) as JsonObject,
  };
}

/** The columns of a `tasks` row that agent statistics count. */
export type WorkRow = Pick<
  StoredTaskRow,
  | 'id'
  | 'project_id'
  | 'type'
  | 'await_type'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'assignee_model'
  | 'started_at'
  | 'updated_at'
  | 'closed_at'
  | 'closed_by'
  | 'closed_model'
  | 'delivery_pull_request'
  | 'delivery_commit'
  | 'delivery_merge_commit'
  | 'delivery_stage'
  | 'merged_at'
  | 'live_at'
>;

export function toWork(row: WorkRow): WorkItem {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    awaitType: row.await_type,
    status: row.status,
    priority: row.priority,
    assignee: row.assignee,
    assigneeModel: row.assignee_model,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    closedModel: row.closed_model,
    pullRequest: row.delivery_pull_request,
    commit: row.delivery_commit,
    mergeCommit: row.delivery_merge_commit,
    stage: row.delivery_stage,
    mergedAt: row.merged_at,
    liveAt: row.live_at,
  };
}

/** The columns of a `tasks` row the wins feed reads. */
export type WinRow = Pick<
  StoredTaskRow,
  | 'id'
  | 'project_id'
  | 'type'
  | 'title'
  | 'status'
  | 'resolution'
  | 'closed_at'
  | 'closed_by'
  | 'closed_model'
  | 'choice'
  | 'delivery_pull_request'
  | 'delivery_commit'
  | 'delivery_merge_commit'
  | 'delivery_stage'
  | 'merged_at'
  | 'live_at'
>;

export function toWin(row: WinRow, done: number): WinItem {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    title: row.title,
    status: row.status,
    resolution: row.resolution,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    closedModel: row.closed_model,
    choice: row.choice === null ? null : (JSON.parse(row.choice) as JsonObject),
    pullRequest: row.delivery_pull_request,
    commit: row.delivery_commit,
    mergeCommit: row.delivery_merge_commit,
    stage: row.delivery_stage,
    mergedAt: row.merged_at,
    liveAt: row.live_at,
    done,
  };
}

/** The columns of a `tasks` row a holder's list shows, with its last activity. */
export type HeldRow = Pick<StoredTaskRow, 'id' | 'project_id' | 'title' | 'priority' | 'assignee_for' | 'work'> & {
  readonly last_activity_at: string | null;
};

export function toHeld(row: HeldRow): HeldTask {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    priority: row.priority,
    assigneeFor: row.assignee_for,
    work: JSON.parse(row.work) as TaskWork,
    lastActivityAt: row.last_activity_at,
  };
}

export function toEpic(row: EpicRow): EpicProgress {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    children: row.children,
    closedChildren: row.closed_children,
    eligibleForClose: row.status !== 'closed' && row.children > 0 && row.closed_children === row.children,
  };
}
