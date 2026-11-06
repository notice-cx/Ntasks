// Every query the engine reads with. Statements number their parameters:
// ?1 is always the project and ?2 the current time; others follow.
import {
  isTaskStatus,
  TASK_LIMITS,
  TaskRefused,
  type ChangePage,
  type EpicProgress,
  type Project,
  type Task,
  type TaskComment,
  type TaskEvent,
  type TaskPage,
  type TaskQuery,
} from '@ntasks/domain';
import {
  partsByTask,
  toComment,
  toEpic,
  toEvent,
  toProject,
  toTask,
  type CommentRow,
  type EpicRow,
  type EventRow,
  type LabelRow,
  type LinkRow,
  type ProjectRow,
  type TaskRow,
} from './rows.ts';
import { instant } from './validate.ts';

/**
 * The tasks of project ?1 that are blocked, as Beads derives it: a task that
 * is not closed is blocked when it has a `blocks` link onto a task that is not
 * closed, or when its parent is blocked, down any depth of children.
 */
const BLOCKED = `blocked(id) AS (
  SELECT e.task_id FROM task_edges e
    JOIN tasks waiting ON waiting.id = e.task_id
    JOIN tasks blocker ON blocker.id = e.depends_on_id
  WHERE e.type = 'blocks' AND blocker.status <> 'closed' AND waiting.status <> 'closed' AND waiting.project_id = ?1
  UNION
  SELECT child.id FROM tasks child JOIN blocked ON child.parent_id = blocked.id WHERE child.status <> 'closed'
)`;

/**
 * Whether task `t`, whose parent is `p`, can be started at time ?2: it is
 * open, not a gate, not blocked, and neither it nor its parent is deferred
 * past ?2. This is Beads' ready work; both the ready filter and every task's
 * `ready` flag use this one expression.
 */
const READY = `(t.status = 'open' AND t.type <> 'gate'
  AND (t.defer_until IS NULL OR t.defer_until <= ?2)
  AND (p.defer_until IS NULL OR p.defer_until <= ?2)
  AND t.id NOT IN (SELECT id FROM blocked))`;

const TASKS = `WITH RECURSIVE ${BLOCKED}
SELECT t.*, ${READY} AS ready,
  (SELECT count(*) FROM task_comments m WHERE m.task_id = t.id) AS comment_count
FROM tasks t LEFT JOIN tasks p ON p.id = t.parent_id
WHERE t.project_id = ?1`;

const ORDER = 'ORDER BY t.priority, t.created_at, t.id';

function invalid(message: string): never {
  throw new TaskRefused('invalid', message);
}

function encodeCursor(row: TaskRow): string {
  return btoa(JSON.stringify([row.priority, row.created_at, row.id]));
}

function decodeCursor(cursor: string): [number, string, string] {
  try {
    const value: unknown = JSON.parse(atob(cursor));
    if (Array.isArray(value) && value.length === 3 && typeof value[0] === 'number' && typeof value[1] === 'string' && typeof value[2] === 'string') {
      return [value[0], value[1], value[2]];
    }
  } catch {
    // Falls through to the refusal below.
  }
  invalid('cursor is not one this engine returned');
}

export class Reads {
  readonly #db: D1Database;
  readonly #now: () => string;

  constructor(db: D1Database, now: () => string) {
    this.#db = db;
    this.#now = now;
  }

  /** Adds labels and links to task rows, in two to three queries for any number of rows. */
  async hydrate(rows: readonly TaskRow[]): Promise<Task[]> {
    if (rows.length === 0) return [];
    const ids = JSON.stringify(rows.map((row) => row.id));
    const [labels, dependencies, dependents] = await this.#db.batch([
      this.#db.prepare('SELECT task_id, label FROM task_labels WHERE task_id IN (SELECT value FROM json_each(?1)) ORDER BY task_id, label').bind(ids),
      this.#db
        .prepare(
          `SELECT e.task_id, e.depends_on_id AS other_id, e.type, o.title, o.status FROM task_edges e
           JOIN tasks o ON o.id = e.depends_on_id
           WHERE e.task_id IN (SELECT value FROM json_each(?1)) ORDER BY e.task_id, e.depends_on_id`,
        )
        .bind(ids),
      this.#db
        .prepare(
          `SELECT e.depends_on_id AS task_id, e.task_id AS other_id, e.type, o.title, o.status FROM task_edges e
           JOIN tasks o ON o.id = e.task_id
           WHERE e.depends_on_id IN (SELECT value FROM json_each(?1)) ORDER BY e.depends_on_id, e.task_id`,
        )
        .bind(ids),
    ]);
    const parts = partsByTask(
      (labels?.results ?? []) as LabelRow[],
      (dependencies?.results ?? []) as LinkRow[],
      (dependents?.results ?? []) as LinkRow[],
    );
    return rows.map((row) => toTask(row, parts(row.id)));
  }

  async taskRows(projectId: string, taskIds: readonly string[]): Promise<TaskRow[]> {
    const { results } = await this.#db
      .prepare(`${TASKS} AND t.id IN (SELECT value FROM json_each(?3)) ${ORDER}`)
      .bind(projectId, this.#now(), JSON.stringify(taskIds))
      .all<TaskRow>();
    return results;
  }

  async getTask(projectId: string, taskId: string): Promise<Task | null> {
    const [task] = await this.hydrate(await this.taskRows(projectId, [taskId]));
    return task ?? null;
  }

  async findTasks(projectId: string, taskIds: readonly string[]): Promise<string[]> {
    const { results } = await this.#db
      .prepare('SELECT id FROM tasks WHERE project_id = ?1 AND id IN (SELECT value FROM json_each(?2)) ORDER BY id')
      .bind(projectId, JSON.stringify(taskIds))
      .all<{ id: string }>();
    return results.map((row) => row.id);
  }

  async listTasks(projectId: string, query: TaskQuery): Promise<TaskPage> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > TASK_LIMITS.page) {
      invalid(`limit must be a whole number from 1 to ${TASK_LIMITS.page}`);
    }
    const args: unknown[] = [projectId, this.#now()];
    const param = (value: unknown): string => {
      args.push(value);
      return `?${args.length}`;
    };
    const where: string[] = [];
    if (query.statuses !== undefined) {
      if (!query.statuses.every(isTaskStatus)) invalid('statuses must be task statuses');
      where.push(`t.status IN (SELECT value FROM json_each(${param(JSON.stringify(query.statuses))}))`);
    }
    if (query.ready === true) where.push(READY);
    if (query.ready === false) where.push(`NOT ${READY}`);
    if (query.parentId !== undefined) where.push(`t.parent_id = ${param(query.parentId)}`);
    if (query.assignee !== undefined) where.push(`t.assignee = ${param(query.assignee)}`);
    for (const label of query.labels ?? []) {
      where.push(`EXISTS (SELECT 1 FROM task_labels l WHERE l.task_id = t.id AND l.label = ${param(label)})`);
    }
    if (query.closedSince !== undefined) where.push(`t.closed_at >= ${param(instant(query.closedSince, 'closedSince'))}`);
    if (query.closedBefore !== undefined) where.push(`t.closed_at < ${param(instant(query.closedBefore, 'closedBefore'))}`);
    if (query.cursor !== undefined) {
      const [priority, createdAt, id] = decodeCursor(query.cursor);
      where.push(`(t.priority, t.created_at, t.id) > (${param(priority)}, ${param(createdAt)}, ${param(id)})`);
    }
    const sql = `${TASKS}${where.map((clause) => ` AND ${clause}`).join('')} ${ORDER} LIMIT ${param(query.limit + 1)}`;
    const { results } = await this.#db.prepare(sql).bind(...args).all<TaskRow>();
    const page = results.slice(0, query.limit);
    const last = page.at(-1);
    return {
      tasks: await this.hydrate(page),
      nextCursor: results.length > query.limit && last !== undefined ? encodeCursor(last) : null,
    };
  }

  async listEpics(projectId: string): Promise<EpicProgress[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT t.id, t.title, t.status, t.priority, count(c.id) AS children,
           coalesce(sum(c.status = 'closed'), 0) AS closed_children
         FROM tasks t LEFT JOIN tasks c ON c.parent_id = t.id
         WHERE t.project_id = ?1 AND t.type = 'epic' AND t.status <> 'closed'
         GROUP BY t.id ORDER BY t.priority, t.created_at, t.id`,
      )
      .bind(projectId)
      .all<EpicRow>();
    return results.map(toEpic);
  }

  async listComments(projectId: string, taskId: string): Promise<TaskComment[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT m.* FROM task_comments m JOIN tasks t ON t.id = m.task_id
         WHERE t.project_id = ?1 AND m.task_id = ?2 ORDER BY m.created_at, m.id`,
      )
      .bind(projectId, taskId)
      .all<CommentRow>();
    return results.map(toComment);
  }

  async listHistory(projectId: string, taskId: string, limit: number, beforeSeq?: number): Promise<TaskEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > TASK_LIMITS.page) invalid(`limit must be a whole number from 1 to ${TASK_LIMITS.page}`);
    const { results } = await this.#db
      .prepare('SELECT * FROM task_events WHERE project_id = ?1 AND task_id = ?2 AND seq < ?3 ORDER BY seq DESC LIMIT ?4')
      .bind(projectId, taskId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit)
      .all<EventRow>();
    return results.map(toEvent);
  }

  async listChanges(after: number, limit: number, projectId?: string): Promise<ChangePage> {
    if (!Number.isInteger(after) || after < 0) invalid('after must be a whole number of 0 or more');
    if (!Number.isInteger(limit) || limit < 1 || limit > TASK_LIMITS.page) invalid(`limit must be a whole number from 1 to ${TASK_LIMITS.page}`);
    const statement =
      projectId === undefined
        ? this.#db.prepare('SELECT * FROM task_events WHERE seq > ?1 ORDER BY seq LIMIT ?2').bind(after, limit)
        : this.#db.prepare('SELECT * FROM task_events WHERE seq > ?1 AND project_id = ?3 ORDER BY seq LIMIT ?2').bind(after, limit, projectId);
    const { results } = await statement.all<EventRow>();
    const events = results.map(toEvent);
    return { events, lastSeq: events.at(-1)?.seq ?? after };
  }

  async listProjects(): Promise<Project[]> {
    const { results } = await this.#db.prepare('SELECT * FROM projects ORDER BY key').all<ProjectRow>();
    return results.map(toProject);
  }

  async project(projectId: string): Promise<Project | null> {
    const row = await this.#db.prepare('SELECT * FROM projects WHERE id = ?1').bind(projectId).first<ProjectRow>();
    return row === null ? null : toProject(row);
  }
}
