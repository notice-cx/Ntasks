// Every query the engine reads with. Statements number their parameters:
// ?1 is always the project and ?2 the current time; others follow.
//
// Cloudflare bills, and its free plan limits, the rows a statement reads. So
// every read reaches its rows through an index, never by scanning a project's
// history, and returns a task with its labels and links in the same
// statement. test/api/read-cost.test.ts holds each read to a budget.
import {
  isDeliveryStage,
  isTaskStatus,
  isTaskType,
  TASK_LIMITS,
  TaskRefused,
  type BoardQuery,
  type ChangePage,
  type CustomField,
  type EpicProgress,
  type LabelPage,
  type LabelQuery,
  type Project,
  type Task,
  type TaskComment,
  type TaskExternalLinks,
  type TaskEvent,
  type TaskFilters,
  type TaskPage,
  type TaskQuery,
  type WorkItem,
} from '@ntasks/domain';
import {
  externalLinks,
  toComment,
  toField,
  toEpic,
  toEvent,
  toProject,
  toTask,
  toWork,
  type CommentRow,
  type EpicRow,
  type EventRow,
  type FieldRow,
  type ProjectRow,
  type TaskRow,
  type WorkRow,
} from './rows.ts';
import type { Bindable, Database, Statement } from './database.ts';
import { instant } from './validate.ts';

/** The statuses of a task that is not closed, which the (project_id, status) index reaches. */
const NOT_CLOSED = `('open', 'in_progress', 'blocked', 'deferred')`;

/** The projects a statement reads: project ?1, or every project. Either way
 * the (project_id, …) indexes reach the rows. */
type Scope = 'project' | 'every';

function inScope(column: string, scope: Scope): string {
  return scope === 'project' ? `${column} = ?1` : `${column} IN (SELECT id FROM projects)`;
}

/**
 * The tasks that are blocked, as Beads derives it: a task that is not closed
 * is blocked when it has a `blocks` link onto a task that is not closed, or
 * when its parent is blocked, down any depth of children. Lists use this
 * form: one pass answers for every task in scope. It starts from the tasks
 * that are not closed, so its cost follows the open work, not the history.
 */
function blockedIn(scope: Scope): string {
  return `blocked(id) AS (
  SELECT waiting.id FROM tasks waiting
    CROSS JOIN task_edges e ON e.task_id = waiting.id
    JOIN tasks blocker ON blocker.id = e.depends_on_id
  WHERE ${inScope('waiting.project_id', scope)} AND waiting.status IN ${NOT_CLOSED}
    AND e.type = 'blocks' AND blocker.status <> 'closed'
  UNION
  SELECT child.id FROM tasks child JOIN blocked ON child.parent_id = blocked.id WHERE child.status <> 'closed'
)`;
}

/** The task ids in a JSON array parameter, each once. */
function among(param: string): string {
  return `(SELECT DISTINCT value AS id FROM json_each(${param})) wanted`;
}

/**
 * The same predicate for only the tasks in ?3, worked upwards: such a task is
 * blocked when it, or an ancestor reached through parents that are not
 * closed, has a `blocks` link onto a task that is not closed. A read of a few
 * tasks then reads their ancestors and links and nothing else.
 * test/engine/ready.test.ts checks that both forms give every task the same
 * answer.
 */
const BLOCKED_AMONG = `chain(task_id, ancestor_id) AS (
  SELECT t.id, t.id FROM ${among('?3')} CROSS JOIN tasks t ON t.id = wanted.id WHERE t.project_id = ?1 AND t.status <> 'closed'
  UNION
  SELECT chain.task_id, parent.id FROM chain
    JOIN tasks child ON child.id = chain.ancestor_id
    JOIN tasks parent ON parent.id = child.parent_id
  WHERE parent.status <> 'closed'
),
blocked(id) AS (
  SELECT DISTINCT chain.task_id FROM chain
  WHERE EXISTS (
    SELECT 1 FROM task_edges e JOIN tasks blocker ON blocker.id = e.depends_on_id
    WHERE e.task_id = chain.ancestor_id AND e.type = 'blocks' AND blocker.status <> 'closed'
  )
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

/** When task t's assignee last wrote to it: their latest event in its
 * history, which task_events_by_actor answers from one entry. */
const LAST_ACTIVITY = `CASE WHEN t.assignee IS NOT NULL THEN
  (SELECT max(e.at) FROM task_events e INDEXED BY task_events_by_actor WHERE e.task_id = t.id AND e.actor = t.assignee)
  END`;

/** The JSON array of task t's external links. */
const EXTERNAL_LINKS = `(SELECT json_group_array(json_object('url', x.url, 'title', x.title, 'kind', x.kind))
     FROM task_external_links x WHERE x.task_id = t.id)`;

/** A task's columns with what the engine computes for it (TaskRow), its
 * external links left out. Each subquery reaches its rows through the task's
 * own index entries. */
const COLUMNS_WITHOUT_LINKS = `t.*, ${READY} AS ready, ${LAST_ACTIVITY} AS last_activity_at,
  (SELECT count(*) FROM task_comments m WHERE m.task_id = t.id) AS comment_count,
  (SELECT json_group_array(l.label) FROM task_labels l WHERE l.task_id = t.id) AS labels_json,
  (SELECT json_group_array(json_object('id', e.depends_on_id, 'type', e.type, 'title', o.title, 'status', o.status))
     FROM task_edges e JOIN tasks o ON o.id = e.depends_on_id WHERE e.task_id = t.id) AS dependencies_json,
  (SELECT json_group_array(json_object('id', e.task_id, 'type', e.type, 'title', o.title, 'status', o.status))
     FROM task_edges e JOIN tasks o ON o.id = e.task_id WHERE e.depends_on_id = t.id) AS dependents_json`;

const TASK_COLUMNS = `${COLUMNS_WITHOUT_LINKS},
  ${EXTERNAL_LINKS} AS external_links_json`;

/** The index a read of closed tasks reaches them through: by close date, or by stage of delivery. */
type ClosedIndex = 'tasks_by_project_closed' | 'tasks_by_project_stage';

/** Tasks in scope, for lists. A read of closed tasks from a date, or at a
 * stage, reaches them through that index, not through every closed task.
 * Without links, each task's external links are an empty list, unread. */
function tasksIn(scope: Scope, index: ClosedIndex | null, links = true): string {
  return `WITH RECURSIVE ${blockedIn(scope)}
SELECT ${links ? TASK_COLUMNS : `${COLUMNS_WITHOUT_LINKS}, '[]' AS external_links_json`}
FROM tasks t${index === null ? '' : ` INDEXED BY ${index}`} LEFT JOIN tasks p ON p.id = t.parent_id
WHERE ${inScope('t.project_id', scope)}`;
}

/** The tasks of project ?1 whose ids are in the JSON array ?3, each by its primary key. */
const TASKS_AMONG = `WITH RECURSIVE ${BLOCKED_AMONG}
SELECT ${TASK_COLUMNS}
FROM ${among('?3')} CROSS JOIN tasks t ON t.id = wanted.id LEFT JOIN tasks p ON p.id = t.parent_id
WHERE t.project_id = ?1`;

const ORDER = 'ORDER BY t.priority, t.created_at, t.id';

/**
 * The tasks of project ?1 carrying label ?3, after id ?4, at most ?5 of them,
 * with BLOCKED_AMONG's upward test for those tasks only. Every task id starts
 * with its project's prefix and a hyphen, and a prefix has no hyphen, so the
 * project's ids lie strictly between `prefix-` and `prefix.` ('.' follows '-'):
 * the label index (label, task_id) is read over that range and nothing else.
 */
const LABELLED = `WITH RECURSIVE bounds(low, high) AS (
  SELECT max(?4, p.prefix || '-'), p.prefix || '.' FROM projects p WHERE p.id = ?1
),
wanted(id) AS (
  SELECT l.task_id FROM bounds CROSS JOIN task_labels l INDEXED BY task_labels_by_label
  WHERE l.label = ?3 AND l.task_id > bounds.low AND l.task_id < bounds.high
  ORDER BY l.task_id LIMIT ?5
),
chain(task_id, ancestor_id) AS (
  SELECT t.id, t.id FROM wanted CROSS JOIN tasks t ON t.id = wanted.id WHERE t.project_id = ?1 AND t.status <> 'closed'
  UNION
  SELECT chain.task_id, parent.id FROM chain
    JOIN tasks child ON child.id = chain.ancestor_id
    JOIN tasks parent ON parent.id = child.parent_id
  WHERE parent.status <> 'closed'
),
blocked(id) AS (
  SELECT DISTINCT chain.task_id FROM chain
  WHERE EXISTS (
    SELECT 1 FROM task_edges e JOIN tasks blocker ON blocker.id = e.depends_on_id
    WHERE e.task_id = chain.ancestor_id AND e.type = 'blocks' AND blocker.status <> 'closed'
  )
)
SELECT ${TASK_COLUMNS}
FROM wanted CROSS JOIN tasks t ON t.id = wanted.id LEFT JOIN tasks p ON p.id = t.parent_id
WHERE t.project_id = ?1
ORDER BY t.id`;

/** Most urgent first, then oldest, then by id: ORDER, for tasks already read. */
export function byUrgency(a: Task, b: Task): number {
  return (
    a.priority - b.priority ||
    (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The text a word search looks in: id, title, description, acceptance and
 * labels, in lower case. SQLite's lower() folds ASCII letters only. */
const SEARCHED_TEXT = `lower(t.id || char(10) || t.title || char(10) || t.description || char(10) || t.acceptance || char(10)
  || coalesce((SELECT group_concat(l.label, char(10)) FROM task_labels l WHERE l.task_id = t.id), ''))`;

function invalid(message: string): never {
  throw new TaskRefused('invalid', message);
}

function encodeCursor(row: TaskRow): string {
  return btoa(JSON.stringify([row.priority, row.created_at, row.id]));
}

function decodeCursor(cursor: string): [number, string, string] {
  try {
    const value: unknown = JSON.parse(atob(cursor));
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      typeof value[0] === 'number' &&
      typeof value[1] === 'string' &&
      typeof value[2] === 'string'
    ) {
      return [value[0], value[1], value[2]];
    }
  } catch {
    // Falls through to the refusal below.
  }
  invalid('cursor is not one this engine returned');
}

/** A statuses list, written into the statement. Each is checked against the
 * task statuses first, so the text is one of five fixed words. */
function statusList(statuses: readonly string[]): string {
  if (!statuses.every(isTaskStatus)) invalid('statuses must be task statuses');
  return `(${statuses.map((status) => `'${status}'`).join(', ')})`;
}

/** Stages of delivery, written into the statement as statusList writes statuses. */
function stageList(stages: unknown): string {
  if (!Array.isArray(stages) || stages.length === 0 || !stages.every(isDeliveryStage))
    invalid('stages must be stages of delivery: built, merged or live');
  return `(${stages.map((stage) => `'${stage}'`).join(', ')})`;
}

/** A query under construction: its WHERE clauses and its values, numbered after ?1 and ?2. */
class Query {
  readonly args: Bindable[];
  readonly where: string[] = [];
  constructor(projectId: string | null, now: string) {
    this.args = [projectId, now];
  }
  param(value: Bindable): string {
    this.args.push(value);
    return `?${this.args.length}`;
  }
}

/** The clauses for the filters lists share. */
function filter(statement: Query, query: TaskFilters): void {
  const { where } = statement;
  if (query.ready === true) where.push(READY);
  if (query.ready === false) where.push(`NOT ${READY}`);
  if (query.parentId !== undefined) where.push(`t.parent_id = ${statement.param(query.parentId)}`);
  if (query.assignee !== undefined) where.push(`t.assignee = ${statement.param(query.assignee)}`);
  // Labels and words each travel as one JSON array, because a statement binds
  // at most 100 values; a task must carry every label and hold every word.
  if (query.labels !== undefined && query.labels.length > 0) {
    if (!query.labels.every((label) => typeof label === 'string')) invalid('labels must be text');
    where.push(`NOT EXISTS (SELECT 1 FROM json_each(${statement.param(JSON.stringify(query.labels))}) wanted
      WHERE NOT EXISTS (SELECT 1 FROM task_labels l WHERE l.task_id = t.id AND l.label = wanted.value))`);
  }
  if (query.words !== undefined && query.words.length > 0) {
    if (!query.words.every((word) => typeof word === 'string' && word.trim() !== ''))
      invalid('words must be non-empty text');
    const words = JSON.stringify(query.words.map((word) => word.toLowerCase()));
    where.push(
      `NOT EXISTS (SELECT 1 FROM json_each(${statement.param(words)}) word WHERE instr(${SEARCHED_TEXT}, word.value) = 0)`,
    );
  }
  if (query.types !== undefined) {
    if (!query.types.every(isTaskType)) invalid('types must be task types');
    where.push(`t.type IN (SELECT value FROM json_each(${statement.param(JSON.stringify(query.types))}))`);
  }
  if (query.fields !== undefined && Object.keys(query.fields).length > 0) {
    // Each wanted value as JSON text, against the task's value at its key's
    // path in the task's own row: equal to it, or, for a multiple-choice
    // value, one of its options. The key's characters need no escaping in a path.
    const wanted = Object.entries(query.fields).map(([key, value]) => {
      if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(key)) invalid('fields must name fields by key');
      if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !isFinite(value)))
        invalid(`fields.${key} must be text, a number, or true or false`);
      return { path: `$."${key}"`, value: JSON.stringify(value) };
    });
    where.push(`NOT EXISTS (SELECT 1 FROM json_each(${statement.param(JSON.stringify(wanted))}) w
      WHERE NOT coalesce(t.field_values -> json_extract(w.value, '$.path') = json_extract(w.value, '$.value')
        OR (json_type(t.field_values, json_extract(w.value, '$.path')) = 'array' AND EXISTS (
          SELECT 1 FROM json_each(t.field_values, json_extract(w.value, '$.path')) o
          WHERE json_quote(o.value) = json_extract(w.value, '$.value'))), 0))`);
  }
  const ranges = [
    ['created_at', '>=', query.createdAfter, 'createdAfter'],
    ['created_at', '<', query.createdBefore, 'createdBefore'],
    ['updated_at', '>=', query.updatedAfter, 'updatedAfter'],
    ['updated_at', '<', query.updatedBefore, 'updatedBefore'],
  ] as const;
  for (const [column, comparison, value, field] of ranges) {
    if (value !== undefined) where.push(`t.${column} ${comparison} ${statement.param(instant(value, field))}`);
  }
}

export class Reads {
  readonly #db: Database;
  readonly #now: () => string;

  constructor(db: Database, now: () => string) {
    this.#db = db;
    this.#now = now;
  }

  async taskRows(projectId: string, taskIds: readonly string[]): Promise<TaskRow[]> {
    if (taskIds.length === 0) return [];
    const { results } = await this.#db
      .prepare(`${TASKS_AMONG} ${ORDER}`)
      .bind(projectId, this.#now(), JSON.stringify(taskIds))
      .all<TaskRow>();
    return results;
  }

  async getTask(projectId: string, taskId: string): Promise<Task | null> {
    const [row] = await this.taskRows(projectId, [taskId]);
    return row === undefined ? null : toTask(row);
  }

  async getTasks(projectId: string, taskIds: readonly string[]): Promise<Task[]> {
    if (taskIds.length > TASK_LIMITS.page) invalid(`taskIds must be at most ${TASK_LIMITS.page} task ids`);
    return (await this.taskRows(projectId, taskIds)).map(toTask);
  }

  /** The work agent statistics count: in progress or blocked through the
   * (project_id, status) index, and closed from a time through the
   * (project_id, closed_at) one, as one statement over every project named. */
  async listWork(projectIds: readonly string[], closedSince: string): Promise<WorkItem[]> {
    if (projectIds.length === 0) return [];
    if (!projectIds.every((id) => typeof id === 'string')) invalid('projectIds must be project ids');
    const columns = `t.id, t.project_id, t.type, t.await_type, t.status, t.priority, t.assignee, t.assignee_model,
      t.started_at, t.updated_at, t.closed_at, t.closed_by, t.closed_model`;
    const { results } = await this.#db
      .prepare(
        `SELECT ${columns} FROM json_each(?1) wanted CROSS JOIN tasks t INDEXED BY tasks_by_project_status
           ON t.project_id = wanted.value WHERE t.status IN ('in_progress', 'blocked')
         UNION ALL
         SELECT ${columns} FROM json_each(?1) wanted CROSS JOIN tasks t INDEXED BY tasks_by_project_closed
           ON t.project_id = wanted.value WHERE t.closed_at >= ?2`,
      )
      .bind(JSON.stringify([...new Set(projectIds)]), instant(closedSince, 'closedSince'))
      .all<WorkRow>();
    return results.map(toWork);
  }

  async findTasks(projectId: string, taskIds: readonly string[]): Promise<string[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT t.id FROM ${among('?2')} CROSS JOIN tasks t ON t.id = wanted.id WHERE t.project_id = ?1 ORDER BY t.id`,
      )
      .bind(projectId, JSON.stringify(taskIds))
      .all<{ id: string }>();
    return results.map((row) => row.id);
  }

  async listTasks(projectId: string, query: TaskQuery): Promise<TaskPage> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > TASK_LIMITS.page) {
      invalid(`limit must be a whole number from 1 to ${TASK_LIMITS.page}`);
    }
    const statement = new Query(projectId, this.#now());
    const { where } = statement;
    if (query.statuses !== undefined) where.push(`t.status IN ${statusList(query.statuses)}`);
    if (query.closedSince !== undefined)
      where.push(`t.closed_at >= ${statement.param(instant(query.closedSince, 'closedSince'))}`);
    if (query.closedBefore !== undefined)
      where.push(`t.closed_at < ${statement.param(instant(query.closedBefore, 'closedBefore'))}`);
    filter(statement, query);
    if (query.cursor !== undefined) {
      const [priority, createdAt, id] = decodeCursor(query.cursor);
      where.push(
        `(t.priority, t.created_at, t.id) > (${statement.param(priority)}, ${statement.param(createdAt)}, ${statement.param(id)})`,
      );
    }
    const byCloseDate = query.closedSince !== undefined || query.closedBefore !== undefined;
    const sql = `${tasksIn('project', byCloseDate ? 'tasks_by_project_closed' : null)}${where.map((clause) => ` AND ${clause}`).join('')} ${ORDER} LIMIT ${statement.param(query.limit + 1)}`;
    const { results } = await this.#db
      .prepare(sql)
      .bind(...statement.args)
      .all<TaskRow>();
    const page = results.slice(0, query.limit);
    const last = page.at(-1);
    return {
      tasks: page.map(toTask),
      nextCursor: results.length > query.limit && last !== undefined ? encodeCursor(last) : null,
    };
  }

  /** A board's tasks: the open ones in full and the closed ones from a date,
   * as two statements in one round trip. */
  async listBoard(projectId: string | null, query: BoardQuery): Promise<Task[]> {
    const scope: Scope = projectId === null ? 'every' : 'project';
    const now = this.#now();
    const statements: Statement[] = [];
    const add = (statuses: readonly string[], closedSince: string | undefined, stages?: string) => {
      const statement = new Query(projectId, now);
      let index: ClosedIndex | null = null;
      if (closedSince === undefined && stages === undefined)
        statement.where.push(`t.status IN ${statusList(statuses)}`);
      // Only a closed task has a closed_at or a stage (the schema checks it), so either reads closed tasks alone.
      if (closedSince !== undefined) {
        index = 'tasks_by_project_closed';
        statement.where.push(`t.closed_at >= ${statement.param(instant(closedSince, 'closedSince'))}`);
      }
      if (stages !== undefined) {
        index ??= 'tasks_by_project_stage';
        statement.where.push(`t.delivery_stage IN ${stages}`);
      }
      filter(statement, query);
      const sql = `${tasksIn(scope, index, query.withoutExternalLinks !== true)}${statement.where.map((clause) => ` AND ${clause}`).join('')}`;
      // An every-project statement never reads ?1, which is null; READY always reads ?2.
      statements.push(this.#db.prepare(sql).bind(...statement.args));
    };
    if ((query.statuses as readonly string[]).includes('closed'))
      invalid('a board reads closed tasks through closedSince');
    if (query.stages !== undefined) {
      // No open task has a stage, and no closed task is ready.
      const stages = stageList(query.stages);
      if (query.ready !== true) add([], query.closedSince, stages);
    } else {
      if (query.statuses.length > 0) add(query.statuses, undefined);
      if (query.closedSince !== undefined && query.ready !== true) add([], query.closedSince);
    }
    if (statements.length === 0) return [];
    const results = await this.#db.batch<TaskRow>(statements);
    return results.flatMap((result) => result.results.map(toTask)).sort(byUrgency);
  }

  async listLabelled(projectId: string, query: LabelQuery): Promise<LabelPage> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > TASK_LIMITS.page) {
      invalid(`limit must be a whole number from 1 to ${TASK_LIMITS.page}`);
    }
    if (typeof query.label !== 'string' || query.label.length < 1 || query.label.length > TASK_LIMITS.label) {
      invalid(`label must be text of 1 to ${TASK_LIMITS.label} characters`);
    }
    if (query.after !== undefined && typeof query.after !== 'string') invalid('after must be a task id');
    const { results } = await this.#db
      .prepare(LABELLED)
      .bind(projectId, this.#now(), query.label, query.after ?? '', query.limit + 1)
      .all<TaskRow>();
    const page = results.slice(0, query.limit);
    return {
      tasks: page.map(toTask),
      next: results.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async listExternalLinks(taskIds: readonly string[]): Promise<TaskExternalLinks[]> {
    if (taskIds.length === 0) return [];
    const { results } = await this.#db
      .prepare(
        `SELECT x.task_id, json_group_array(json_object('url', x.url, 'title', x.title, 'kind', x.kind)) AS links
         FROM ${among('?1')} CROSS JOIN task_external_links x ON x.task_id = wanted.id
         GROUP BY x.task_id ORDER BY x.task_id`,
      )
      .bind(JSON.stringify(taskIds))
      .all<{ task_id: string; links: string }>();
    return results.map((row) => ({ taskId: row.task_id, externalLinks: externalLinks(row.links) }));
  }

  async listFields(projectId: string): Promise<CustomField[]> {
    const { results } = await this.#db
      .prepare('SELECT * FROM custom_fields WHERE project_id = ?1 ORDER BY created_at, key')
      .bind(projectId)
      .all<FieldRow>();
    return results.map(toField);
  }

  async listEpics(projectId: string): Promise<EpicProgress[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT t.id, t.title, t.status, t.priority, count(c.id) AS children,
           coalesce(sum(c.status = 'closed'), 0) AS closed_children
         FROM tasks t LEFT JOIN tasks c ON c.parent_id = t.id
         WHERE t.project_id = ?1 AND t.status IN ${NOT_CLOSED} AND t.type = 'epic'
         GROUP BY t.id ORDER BY t.priority, t.created_at, t.id`,
      )
      .bind(projectId)
      .all<EpicRow>();
    return results.map(toEpic);
  }

  async nextDeferralAfter(time: string): Promise<string | null> {
    // The partial index tasks_by_defer_until answers this from one entry.
    const row = await this.#db
      .prepare('SELECT min(defer_until) AS next FROM tasks WHERE defer_until > ?1')
      .bind(instant(time, 'time'))
      .first<{ next: string | null }>();
    return row?.next ?? null;
  }

  async listComments(projectId: string, taskId: string): Promise<TaskComment[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT m.* FROM task_comments m
         WHERE m.task_id = ?2 AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = ?2 AND t.project_id = ?1)
         ORDER BY m.created_at, m.id`,
      )
      .bind(projectId, taskId)
      .all<CommentRow>();
    return results.map(toComment);
  }

  async listHistory(projectId: string, taskId: string, limit: number, beforeSeq?: number): Promise<TaskEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > TASK_LIMITS.page)
      invalid(`limit must be a whole number from 1 to ${TASK_LIMITS.page}`);
    const { results } = await this.#db
      .prepare(
        'SELECT * FROM task_events INDEXED BY task_events_by_task WHERE task_id = ?2 AND project_id = ?1 AND seq < ?3 ORDER BY seq DESC LIMIT ?4',
      )
      .bind(projectId, taskId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit)
      .all<EventRow>();
    return results.map(toEvent);
  }

  async latestChange(): Promise<number> {
    // seq is the table's integer primary key, so max() reads one entry.
    const row = await this.#db.prepare('SELECT coalesce(max(seq), 0) AS seq FROM task_events').first<{ seq: number }>();
    return row?.seq ?? 0;
  }

  async listChanges(after: number, limit: number, projectId?: string): Promise<ChangePage> {
    if (!Number.isInteger(after) || after < 0) invalid('after must be a whole number of 0 or more');
    if (!Number.isInteger(limit) || limit < 1 || limit > TASK_LIMITS.page)
      invalid(`limit must be a whole number from 1 to ${TASK_LIMITS.page}`);
    const statement =
      projectId === undefined
        ? this.#db.prepare('SELECT * FROM task_events WHERE seq > ?1 ORDER BY seq LIMIT ?2').bind(after, limit)
        : this.#db
            .prepare('SELECT * FROM task_events WHERE seq > ?1 AND project_id = ?3 ORDER BY seq LIMIT ?2')
            .bind(after, limit, projectId);
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
