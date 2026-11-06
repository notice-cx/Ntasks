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
}

/** A `tasks` row as the engine's reads select it, with the columns they compute. */
export interface TaskRow extends StoredTaskRow {
  /** 1 when someone can start the task now (READY in reads.ts). */
  readonly ready: number;
  readonly comment_count: number;
  /** The task's labels, as a JSON array of text. */
  readonly labels_json: string;
  /** Its links onto other tasks and theirs onto it, as JSON arrays of LinkJson. */
  readonly dependencies_json: string;
  readonly dependents_json: string;
}

/** One link in a TaskRow's JSON: the other task, the link's type, and the other task's title and status. */
interface LinkJson {
  readonly id: string;
  readonly type: DependencyType;
  readonly title: string;
  readonly status: TaskStatus;
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

function object(text: string | null): JsonObject | null {
  return text === null ? null : (JSON.parse(text) as JsonObject);
}

/** A row's links, ordered by the other task's id, so every read lists them alike. */
function links(text: string): TaskLink[] {
  return (JSON.parse(text) as LinkJson[])
    .map((entry) => ({ taskId: entry.id, type: entry.type, title: entry.title, status: entry.status }))
    .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
}

export function toTask(row: TaskRow): Task {
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
    labels: (JSON.parse(row.labels_json) as string[]).sort(),
    dependencies: links(row.dependencies_json),
    dependents: links(row.dependents_json),
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
