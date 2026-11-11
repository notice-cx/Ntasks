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
  PARENT_CONTEXT_LIMITS,
  TASK_LIMITS,
  TaskRefused,
  type BoardQuery,
  type BurndownRead,
  type ChangePage,
  type CustomField,
  type EpicProgress,
  type FormerId,
  type HeldTask,
  type LabelPage,
  type LabelQuery,
  type ParentContext,
  type Project,
  type Repository,
  type Task,
  type TaskComment,
  type TaskExternalLinks,
  type TaskEvent,
  type TaskFilters,
  type TaskResolution,
  type TaskStatus,
  type IconScheme,
  type StoredProjectIcon,
  type TaskType,
  type WinsRead,
  type WorkItem,
} from '@ntasks/domain';
import {
  externalLinks,
  toClosedSibling,
  toComment,
  toField,
  toEpic,
  toEvent,
  toHeld,
  toProject,
  toProjectIcon,
  toTask,
  toWin,
  toWork,
  type ClosedSiblingRow,
  type CommentRow,
  type EpicRow,
  type EventRow,
  type FieldRow,
  type HeldRow,
  type ProjectIconRow,
  type ProjectRow,
  type TaskRow,
  type WinRow,
  type WorkRow,
} from './rows.ts';
import type { Bindable, Database, Statement } from './database.ts';
import { instant } from './validate.ts';

/** A project's row with the times its light and dark icons were read, as `ProjectRow` holds it. */
const PROJECT_SELECT = `SELECT p.*, i.read_at AS icon_at, d.read_at AS dark_icon_at FROM projects p
  LEFT JOIN project_icons i ON i.project_id = p.id AND i.scheme = 'light'
  LEFT JOIN project_icons d ON d.project_id = p.id AND d.scheme = 'dark'`;

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
 *
 * A task labelled `human` that is not an epic is a person's to answer, and
 * only its own `blocks` links hold it: a parent's wait does not, so the
 * person is asked while the work above them waits. The tasks under it stay
 * held, because `blocked` still lists it.
 */
const READY = `(t.status = 'open' AND t.type <> 'gate'
  AND (t.defer_until IS NULL OR t.defer_until <= ?2)
  AND (p.defer_until IS NULL OR p.defer_until <= ?2)
  AND (t.id NOT IN (SELECT id FROM blocked)
    OR (t.type <> 'epic'
      AND EXISTS (SELECT 1 FROM task_labels l WHERE l.task_id = t.id AND l.label = 'human')
      AND NOT EXISTS (
        SELECT 1 FROM task_edges e JOIN tasks blocker ON blocker.id = e.depends_on_id
        WHERE e.task_id = t.id AND e.type = 'blocks' AND blocker.status <> 'closed'))))`;

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
  (SELECT json_group_array(json_object('id', e.depends_on_id, 'type', e.type, 'title', o.title, 'status', o.status,
       'resolution', o.resolution, 'closedAt', o.closed_at))
     FROM task_edges e JOIN tasks o ON o.id = e.depends_on_id WHERE e.task_id = t.id) AS dependencies_json,
  (SELECT json_group_array(json_object('id', e.task_id, 'type', e.type, 'title', o.title, 'status', o.status,
       'resolution', o.resolution, 'closedAt', o.closed_at))
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

/** Orders text newest or largest first. */
function compareDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

/** The row parentContext reads: the parent, and its lists as JSON arrays with their totals. */
interface ParentContextRow {
  readonly id: string;
  readonly title: string;
  readonly type: TaskType;
  readonly status: TaskStatus;
  readonly pinned_total: number;
  readonly pinned_json: string;
  readonly closed_total: number;
  readonly closed_json: string;
}

function invalid(message: string): never {
  throw new TaskRefused('invalid', message);
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
  // Each reads the task's own history entries: task_events_by_actor for a
  // writer, and the partial indexes of the changes that name a helper or a session.
  if (query.changedBy !== undefined)
    where.push(`EXISTS (SELECT 1 FROM task_events e INDEXED BY task_events_by_actor
      WHERE e.task_id = t.id AND e.actor = ${statement.param(query.changedBy)})`);
  if (query.changedFor !== undefined)
    where.push(`EXISTS (SELECT 1 FROM task_events e INDEXED BY task_events_by_helper
      WHERE e.task_id = t.id AND e.actor_for = ${statement.param(query.changedFor)})`);
  if (query.changedIn !== undefined)
    where.push(`EXISTS (SELECT 1 FROM task_events e INDEXED BY task_events_by_session
      WHERE e.task_id = t.id AND e.session = ${statement.param(query.changedIn)})`);
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

  /** The work agent statistics count, with where its change is: in progress
   * or blocked through the (project_id, status) index, and closed from a time
   * through the (project_id, closed_at) one, as one statement over every
   * project named. */
  async listWork(projectIds: readonly string[], closedSince: string): Promise<WorkItem[]> {
    if (projectIds.length === 0) return [];
    if (!projectIds.every((id) => typeof id === 'string')) invalid('projectIds must be project ids');
    const columns = `t.id, t.project_id, t.type, t.await_type, t.status, t.priority, t.assignee, t.assignee_model,
      t.started_at, t.updated_at, t.closed_at, t.closed_by, t.closed_model, t.delivery_pull_request,
      t.delivery_commit, t.delivery_merge_commit, t.delivery_stage, t.merged_at, t.live_at`;
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

  /**
   * The wins between ?2 and ?3: the tasks not closed whose choice a person
   * answered then, through the (project_id, status) index, and the tasks
   * closed from ?4 on that shipped then, were answered then, or are epics or
   * approvals closed as done then, through the (project_id, closed_at) one.
   * Beside them, whether any change shipped before ?2, which stops at the
   * first such task the stage index holds. Then, for the epics, their
   * children closed as done through the parent index.
   */
  async listWins(projectIds: readonly string[], from: string, to: string, closedSince: string): Promise<WinsRead> {
    if (projectIds.length === 0) return { items: [], shippedBefore: false };
    if (!projectIds.every((id) => typeof id === 'string')) invalid('projectIds must be project ids');
    const columns = `t.id, t.project_id, t.type, t.title, t.status, t.resolution, t.closed_at, t.closed_by,
      t.closed_model, t.choice, t.delivery_pull_request, t.delivery_commit, t.delivery_merge_commit,
      t.delivery_stage, t.merged_at, t.live_at`;
    const answered = `(t.choice IS NOT NULL AND json_extract(t.choice, '$.at') >= ?2 AND json_extract(t.choice, '$.at') < ?3)`;
    const shipped = 'coalesce(t.merged_at, t.live_at)';
    const args: Bindable[] = [
      JSON.stringify([...new Set(projectIds)]),
      instant(from, 'from'),
      instant(to, 'to'),
      instant(closedSince, 'closedSince'),
    ];
    const [found, before] = await this.#db.batch<WinRow | { shipped_before: number }>([
      this.#db
        .prepare(
          `SELECT ${columns} FROM json_each(?1) wanted CROSS JOIN tasks t INDEXED BY tasks_by_project_status
             ON t.project_id = wanted.value WHERE t.status IN ${NOT_CLOSED} AND ${answered}
           UNION ALL
           SELECT ${columns} FROM json_each(?1) wanted CROSS JOIN tasks t INDEXED BY tasks_by_project_closed
             ON t.project_id = wanted.value WHERE t.closed_at >= ?4 AND (${answered}
               OR (${shipped} >= ?2 AND ${shipped} < ?3)
               OR (t.closed_at >= ?2 AND t.closed_at < ?3 AND t.resolution = 'done' AND t.type IN ('epic', 'gate')))`,
        )
        .bind(...args),
      this.#db
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM json_each(?1) wanted CROSS JOIN tasks t INDEXED BY tasks_by_project_stage
             ON t.project_id = wanted.value WHERE t.delivery_stage IN ('merged', 'live') AND ${shipped} < ?2) AS shipped_before`,
        )
        .bind(args[0]!, args[1]!),
    ]);
    const rows = found!.results as WinRow[];
    const epics = rows.filter((row) => row.type === 'epic' && row.resolution === 'done').map((row) => row.id);
    const done = new Map<string, number>();
    if (epics.length > 0) {
      const { results } = await this.#db
        .prepare(
          `SELECT t.parent_id AS epic, count(*) AS done FROM ${among('?1')} CROSS JOIN tasks t INDEXED BY tasks_by_parent
             ON t.parent_id = wanted.id WHERE t.status = 'closed' AND t.resolution = 'done' GROUP BY t.parent_id`,
        )
        .bind(JSON.stringify(epics))
        .all<{ epic: string; done: number }>();
      for (const row of results) done.set(row.epic, row.done);
    }
    const shippedBefore = (before!.results[0] as { shipped_before: number } | undefined)?.shipped_before === 1;
    return { items: rows.map((row) => toWin(row, done.get(row.id) ?? 0)), shippedBefore };
  }

  /**
   * What a burn-down from ?2 counts: when each task not closed was created,
   * which the (project_id, status) index holds, so no task row is read; and
   * when each task closed from ?2 on was created and closed, and how, through
   * the (project_id, closed_at) one. Beside them, whether any task closed
   * before ?2, which stops at the first the closed index holds.
   */
  async listBurndown(projectIds: readonly string[], from: string): Promise<BurndownRead> {
    if (projectIds.length === 0) return { items: [], closedBefore: false };
    if (!projectIds.every((id) => typeof id === 'string')) invalid('projectIds must be project ids');
    const args: Bindable[] = [JSON.stringify([...new Set(projectIds)]), instant(from, 'from')];
    type Row = { created_at: string; closed_at: string | null; resolution: TaskResolution | null };
    const [found, before] = await this.#db.batch<Row | { closed_before: number }>([
      this.#db
        .prepare(
          `SELECT t.created_at, NULL AS closed_at, NULL AS resolution
             FROM json_each(?1) wanted CROSS JOIN tasks t INDEXED BY tasks_by_project_status
             ON t.project_id = wanted.value WHERE t.status IN ${NOT_CLOSED}
           UNION ALL
           SELECT t.created_at, t.closed_at, t.resolution
             FROM json_each(?1) wanted CROSS JOIN tasks t INDEXED BY tasks_by_project_closed
             ON t.project_id = wanted.value WHERE t.closed_at >= ?2`,
        )
        .bind(...args),
      this.#db
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM json_each(?1) wanted CROSS JOIN tasks t INDEXED BY tasks_by_project_closed
             ON t.project_id = wanted.value WHERE t.closed_at < ?2) AS closed_before`,
        )
        .bind(...args),
    ]);
    return {
      items: (found!.results as Row[]).map((row) => ({
        createdAt: row.created_at,
        closedAt: row.closed_at,
        resolution: row.resolution,
      })),
      closedBefore: (before!.results[0] as { closed_before: number } | undefined)?.closed_before === 1,
    };
  }

  /** The open tasks one holder holds, through the assignee index: one entry
   * per task held, and its last activity from task_events_by_actor. */
  async listHeld(assignee: string): Promise<HeldTask[]> {
    if (typeof assignee !== 'string' || assignee === '') invalid('assignee must be a name');
    const { results } = await this.#db
      .prepare(
        `SELECT t.id, t.project_id, t.title, t.priority, t.assignee_for, t.work, ${LAST_ACTIVITY} AS last_activity_at
         FROM tasks t INDEXED BY tasks_by_assignee WHERE t.assignee = ?1 AND t.status <> 'closed' ${ORDER}`,
      )
      .bind(assignee)
      .all<HeldRow>();
    return results.map(toHeld);
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

  async listUnder(projectId: string, taskIds: readonly string[], limit: number): Promise<Task[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > TASK_LIMITS.page)
      invalid(`limit must be a whole number from 1 to ${TASK_LIMITS.page}`);
    if (taskIds.length === 0) return [];
    // UNION ends a parent loop an import could leave; the LIMIT stops the walk itself.
    const { results } = await this.#db
      .prepare(
        `WITH RECURSIVE under(id) AS (
           SELECT c.id FROM ${among('?2')} CROSS JOIN tasks c INDEXED BY tasks_by_parent ON c.parent_id = wanted.id
           WHERE c.project_id = ?1
           UNION
           SELECT c.id FROM under CROSS JOIN tasks c INDEXED BY tasks_by_parent ON c.parent_id = under.id
           LIMIT ?3
         )
         SELECT id FROM under`,
      )
      .bind(projectId, JSON.stringify(taskIds), limit)
      .all<{ id: string }>();
    return (
      await this.taskRows(
        projectId,
        results.map((row) => row.id),
      )
    ).map(toTask);
  }

  async formerIds(taskIds: readonly string[]): Promise<FormerId[]> {
    if (taskIds.length === 0) return [];
    if (taskIds.length > TASK_LIMITS.page) invalid(`taskIds must be at most ${TASK_LIMITS.page} task ids`);
    const { results } = await this.#db
      .prepare(
        `SELECT a.alias AS former_id, t.id AS task_id, t.project_id FROM ${among('?1')}
         CROSS JOIN task_aliases a ON a.alias = wanted.id JOIN tasks t ON t.id = a.task_id ORDER BY a.alias`,
      )
      .bind(JSON.stringify(taskIds))
      .all<{ former_id: string; task_id: string; project_id: string }>();
    return results.map((row) => ({ formerId: row.former_id, taskId: row.task_id, projectId: row.project_id }));
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

  /**
   * The task's parent, its newest pinned comments and its most recently
   * closed other children, each list with its total, in one statement. Each
   * list and count reads its own index entries (task_comments_pinned,
   * tasks_closed_by_parent), so the parent's other comments and open
   * children are never read.
   */
  async parentContext(projectId: string, taskId: string): Promise<ParentContext | null> {
    const pinnedFrom = `FROM task_comments m INDEXED BY task_comments_pinned WHERE m.task_id = p.id AND m.pinned = 1`;
    const closedFrom = `FROM tasks s INDEXED BY tasks_closed_by_parent
      WHERE s.parent_id = p.id AND s.closed_at IS NOT NULL AND s.id <> t.id`;
    const row = await this.#db
      .prepare(
        `SELECT p.id, p.title, p.type, p.status,
           (SELECT count(*) ${pinnedFrom}) AS pinned_total,
           (SELECT json_group_array(json_object('id', id, 'task_id', task_id, 'author', author, 'text', text,
               'created_at', created_at, 'pinned', pinned, 'test', test))
              FROM (SELECT m.* ${pinnedFrom} ORDER BY m.created_at DESC, m.id DESC LIMIT ?3)) AS pinned_json,
           (SELECT count(*) ${closedFrom}) AS closed_total,
           (SELECT json_group_array(json_object('id', id, 'title', title, 'resolution', resolution,
               'closed_at', closed_at, 'closed_by', closed_by, 'close_reason', close_reason,
               'delivery_commit', delivery_commit, 'delivery_pull_request', delivery_pull_request,
               'close_link', close_link))
              FROM (SELECT s.* ${closedFrom} ORDER BY s.closed_at DESC, s.id LIMIT ?4)) AS closed_json
         FROM tasks t CROSS JOIN tasks p ON p.id = t.parent_id
         WHERE t.id = ?2 AND t.project_id = ?1`,
      )
      .bind(projectId, taskId, PARENT_CONTEXT_LIMITS.pinned, PARENT_CONTEXT_LIMITS.closedSiblings)
      .first<ParentContextRow>();
    if (row === null) return null;
    // json_group_array keeps no order SQLite promises, so each list is put back in its own.
    const pinned = (JSON.parse(row.pinned_json) as CommentRow[])
      .sort((a, b) => compareDesc(a.created_at, b.created_at) || compareDesc(a.id, b.id))
      .map(toComment);
    const closed = (JSON.parse(row.closed_json) as ClosedSiblingRow[])
      .sort((a, b) => compareDesc(a.closed_at, b.closed_at) || compareDesc(b.id, a.id))
      .map(toClosedSibling);
    return {
      id: row.id,
      title: row.title,
      type: row.type,
      status: row.status,
      pinned,
      pinnedTotal: row.pinned_total,
      closedSiblings: closed,
      closedSiblingsTotal: row.closed_total,
    };
  }

  async listHistory(projectId: string, taskId: string, limit: number, beforeSeq?: number): Promise<TaskEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > TASK_LIMITS.page)
      invalid(`limit must be a whole number from 1 to ${TASK_LIMITS.page}`);
    const { results } = await this.#db
      .prepare(
        // An event keeps the project its task was in when it was recorded, so a
        // moved task's earlier events name its earlier project: the task's own
        // project decides. A move is also recorded in the project the task
        // left, for that project's changes; its history keeps the move once,
        // as the project it went to recorded it.
        `SELECT e.* FROM task_events e INDEXED BY task_events_by_task
         WHERE e.task_id = ?2 AND e.seq < ?3 AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = ?2 AND t.project_id = ?1)
           AND NOT (e.kind = 'updated' AND coalesce(json_extract(e.changes, '$.projectId') <> e.project_id, 0))
         ORDER BY e.seq DESC LIMIT ?4`,
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
    const { results } = await this.#db.prepare(`${PROJECT_SELECT} ORDER BY p.key`).all<ProjectRow>();
    return results.map(toProject);
  }

  async listRepositories(): Promise<Repository[]> {
    const { results } = await this.#db
      .prepare('SELECT name, merges_live FROM repositories ORDER BY name')
      .all<{ readonly name: string; readonly merges_live: number }>();
    return results.map((row) => ({ name: row.name, mergesLive: row.merges_live === 1 }));
  }

  async project(projectId: string): Promise<Project | null> {
    const row = await this.#db.prepare(`${PROJECT_SELECT} WHERE p.id = ?1`).bind(projectId).first<ProjectRow>();
    return row === null ? null : toProject(row);
  }

  async projectIcon(projectId: string, scheme: IconScheme): Promise<StoredProjectIcon | null> {
    const row = await this.#db
      .prepare(
        'SELECT source_url, content_type, bytes, read_at FROM project_icons WHERE project_id = ?1 AND scheme = ?2',
      )
      .bind(projectId, scheme)
      .first<ProjectIconRow>();
    return row === null ? null : toProjectIcon(row);
  }
}
