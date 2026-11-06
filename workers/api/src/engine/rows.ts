// The database's rows, and how each becomes a record of the engine contract.
import type {
  DependencyType,
  EpicProgress,
  JsonObject,
  Project,
  Task,
  TaskComment,
  TaskEvent,
  TaskEventKind,
  TaskLink,
  TaskResolution,
  TaskStatus,
  TaskType,
} from '@ntasks/domain';

/** A `tasks` row as the engine's reads select it, with the computed columns. */
export interface TaskRow {
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
  readonly assignee: string | null;
  readonly assignee_model: string | null;
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
  /** 1 when someone can start the task now (READY in reads.ts). */
  readonly ready: number;
  readonly comment_count: number;
}

/** A link row: `task_id` depends on `other_id`, with the other task's title and status. */
export interface LinkRow {
  readonly task_id: string;
  readonly other_id: string;
  readonly type: DependencyType;
  readonly title: string;
  readonly status: TaskStatus;
}

export interface LabelRow {
  readonly task_id: string;
  readonly label: string;
}

export interface ProjectRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly prefix: string;
  readonly created_at: string;
}

export interface CommentRow {
  readonly id: string;
  readonly task_id: string;
  readonly author: string;
  readonly text: string;
  readonly created_at: string;
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
}

export interface EpicRow {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority: number;
  readonly children: number;
  readonly closed_children: number;
}

/** What a task's history and a write need about one task, beyond its row. */
export interface TaskParts {
  readonly labels: readonly string[];
  readonly dependencies: readonly TaskLink[];
  readonly dependents: readonly TaskLink[];
}

function object(text: string | null): JsonObject | null {
  return text === null ? null : (JSON.parse(text) as JsonObject);
}

function link(row: LinkRow): TaskLink {
  return { taskId: row.other_id, type: row.type, title: row.title, status: row.status };
}

export function toTask(row: TaskRow, parts: TaskParts): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    type: row.type,
    awaitType: row.await_type,
    status: row.status,
    priority: row.priority,
    title: row.title,
    description: row.description,
    acceptance: row.acceptance,
    assignee: row.assignee,
    assigneeModel: row.assignee_model,
    labels: parts.labels,
    dependencies: parts.dependencies,
    dependents: parts.dependents,
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
          }
        : null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
  };
}

/** Groups label and link rows by task, in the order the queries returned them. */
export function partsByTask(labels: readonly LabelRow[], dependencies: readonly LinkRow[], dependents: readonly LinkRow[]) {
  const parts = new Map<string, { labels: string[]; dependencies: TaskLink[]; dependents: TaskLink[] }>();
  const entry = (taskId: string) => {
    let found = parts.get(taskId);
    if (found === undefined) {
      found = { labels: [], dependencies: [], dependents: [] };
      parts.set(taskId, found);
    }
    return found;
  };
  for (const row of labels) entry(row.task_id).labels.push(row.label);
  for (const row of dependencies) entry(row.task_id).dependencies.push(link(row));
  for (const row of dependents) entry(row.task_id).dependents.push(link(row));
  return (taskId: string): TaskParts => parts.get(taskId) ?? { labels: [], dependencies: [], dependents: [] };
}

export function toProject(row: ProjectRow): Project {
  return { id: row.id, key: row.key, name: row.name, prefix: row.prefix, createdAt: row.created_at };
}

export function toComment(row: CommentRow): TaskComment {
  return { id: row.id, taskId: row.task_id, author: row.author, text: row.text, createdAt: row.created_at };
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
    at: row.at,
    changes: JSON.parse(row.changes) as JsonObject,
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
