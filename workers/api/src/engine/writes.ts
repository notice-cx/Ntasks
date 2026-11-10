// Every write the engine makes. Each is one batch, which commits whole or not
// at all; the write guard (src/store/migrations/0001_task_store.sql) rolls a
// batch back when its versioned update matched no row or a link would close a
// loop.
import {
  guardRefusalOf,
  TASK_LIMITS,
  TaskRefused,
  WORK_DETAILS,
  type Actor,
  type CommentPins,
  type CommentResult,
  type CreateProjectInput,
  type CreateTaskInput,
  type CustomField,
  type DefineFieldInput,
  type DeliveryMove,
  type DeliveryOptions,
  type DeliverySignal,
  type DeliveryStage,
  type DependencyType,
  type ExternalLink,
  type FieldResult,
  type FieldValue,
  type Json,
  type JsonObject,
  type Project,
  type Retry,
  type Task,
  type TaskDelivery,
  type TaskComment,
  type TaskEventKind,
  type TaskRefusal,
  type TaskStep,
  type TaskWork,
  type TaskWrite,
  type WriteResult,
} from '@ntasks/domain';
import type { Database, Statement } from './database.ts';
import type { Reads } from './reads.ts';
import { deliveryOf, toField, toTask, type FieldRow, type StoredTaskRow } from './rows.ts';
import * as check from './validate.ts';

/** How long a retry record answers a repeated key. */
const RECEIPT_DAYS = 7;
/** How long a derived key's record of a new task answers: a task asked for later is a new one. */
const DERIVED_NEW_TASK_HOURS = 24;
/**
 * Whether a derived key's record no longer answers, as SQL on a write_receipts
 * row. The record carries its own rule: a task its write left (`$.left`) has
 * moved from the version it was left at, or a record of new tasks
 * (`$.newTask`) is older than ?dayAgo. Every lookup reads the same rule.
 */
const STALE = (dayAgo: string) => `((json_extract(result, '$.newTask') = 1 AND created_at < ${dayAgo}) OR EXISTS (
  SELECT 1 FROM json_each(write_receipts.result, '$.left') AS l
  WHERE json_extract(l.value, '$.version') IS NOT (
    SELECT version FROM tasks WHERE id = json_extract(l.value, '$.taskId') AND project_id = write_receipts.project_id)))`;
/** How many times a write tries again, with a new task id or a fresh read,
 * after another write took its id or changed a task it also changes. */
const ATTEMPTS = 5;

const MESSAGES: Readonly<Record<TaskRefusal, string>> = Object.freeze({
  not_found: 'The task does not exist in this project.',
  version_conflict: 'The task changed after you read it. Read it again and retry with its new version.',
  cycle: 'This would make tasks wait on each other in a loop.',
  held: 'Someone else holds this task.',
  retry_conflict: 'This idempotency key was already used for a different request.',
  invalid: 'The write is not valid.',
});

function refuse(refusal: TaskRefusal, message: string = MESSAGES[refusal]): never {
  throw new TaskRefused(refusal, message);
}

/** A random task key of lowercase letters and digits, as Beads' hash ids have. */
export function randomKey(length = 4): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => alphabet[byte % alphabet.length]).join(
    '',
  );
}

/** What a failed batch means for the caller: a refusal is thrown; a collision is returned for a retry. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureOf(error: unknown): 'id_taken' | 'receipt_taken' {
  const message = messageOf(error);
  const refusal = guardRefusalOf(message);
  if (refusal !== null) refuse(refusal);
  if (message.includes('UNIQUE constraint failed: tasks.id')) return 'id_taken';
  if (message.includes('UNIQUE constraint failed: write_receipts')) return 'receipt_taken';
  if (message.includes('FOREIGN KEY constraint failed')) refuse('not_found', 'A task this write names does not exist.');
  throw error;
}

type Row = Record<string, string | number | null>;

export interface WriteOptions {
  readonly now: () => string;
  readonly newKey: () => string;
}

/** Links as history events record them: the full list, sorted. */
function linkList(links: ReadonlyMap<string, DependencyType>): Json {
  return [...links].sort(([a], [b]) => a.localeCompare(b)).map(([taskId, type]) => ({ taskId, type }));
}

/** External links as history events record them: the full list, ordered by URL as a read orders them. */
function externalList(links: ReadonlyMap<string, ExternalLink>): Json {
  return [...links.values()]
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
    .map(({ url, title, kind }) => ({ url, title, kind }));
}

/** A delivery as history events record it. */
function deliveryJson(delivery: TaskDelivery): JsonObject {
  const { stage, commit, pullRequest, mergeCommit, builtAt, mergedAt, liveAt } = delivery;
  return { stage, commit, pullRequest, mergeCommit, builtAt, mergedAt, liveAt };
}

/** The order of the stages: a task moves only to a later one. */
const STAGE_ORDER: Readonly<Record<DeliveryStage, number>> = Object.freeze({ built: 0, merged: 1, live: 2 });

/** The columns that hold a task's delivery, which a reopen clears. */
const DELIVERY_COLUMNS = [
  'delivery_stage',
  'delivery_commit',
  'delivery_pull_request',
  'delivery_merge_commit',
  'built_at',
  'merged_at',
  'live_at',
] as const;

/**
 * The built and merged tasks of the projects in ?1 whose pull request is in
 * ?2, or whose commit or merge commit matches one in ?3, with whether their
 * project deploys. Two commits match when one is a prefix of the other; both
 * then share their first 7 characters, so each commit reads one range of an
 * index ('g' sorts after every hexadecimal digit).
 */
const DELIVERY_CANDIDATES = `WITH matched(id) AS (
  SELECT t.id FROM json_each(?2) w CROSS JOIN tasks t INDEXED BY tasks_by_delivery_pull_request
    ON t.delivery_pull_request = w.value
  UNION
  SELECT t.id FROM json_each(?3) w CROSS JOIN tasks t INDEXED BY tasks_by_delivery_commit
    ON t.delivery_commit >= substr(w.value, 1, 7) AND t.delivery_commit < substr(w.value, 1, 7) || 'g'
  WHERE substr(w.value, 1, length(t.delivery_commit)) = t.delivery_commit
    OR substr(t.delivery_commit, 1, length(w.value)) = w.value
  UNION
  SELECT t.id FROM json_each(?3) w CROSS JOIN tasks t INDEXED BY tasks_by_delivery_merge_commit
    ON t.delivery_merge_commit >= substr(w.value, 1, 7) AND t.delivery_merge_commit < substr(w.value, 1, 7) || 'g'
  WHERE substr(w.value, 1, length(t.delivery_merge_commit)) = t.delivery_merge_commit
    OR substr(t.delivery_merge_commit, 1, length(w.value)) = w.value
)
SELECT t.*, p.deploys AS deploys FROM matched CROSS JOIN tasks t ON t.id = matched.id JOIN projects p ON p.id = t.project_id
WHERE t.project_id IN (SELECT value FROM json_each(?1)) AND t.delivery_stage IN ('built', 'merged')
ORDER BY t.id`;

/** Field values as history events record them: every value the task carries, by key in order. */
function fieldMap(values: ReadonlyMap<string, FieldValue>): Json {
  return Object.fromEntries([...values].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Work details in WORK_DETAILS' order, then `touches`, so one set of details
 * is stored and recorded one way. An empty `touches` takes the list off. */
function workIn(details: TaskWork): TaskWork {
  return Object.fromEntries([
    ...WORK_DETAILS.flatMap((detail) => (details[detail] === undefined ? [] : [[detail, details[detail]]])),
    ...(details.touches === undefined || details.touches.length === 0 ? [] : [['touches', details.touches]]),
  ]) as TaskWork;
}

/**
 * How a new task starts: open; claimed by the actor, in progress; or closed as
 * done by the actor, held by nobody, with its delivery at built when the close
 * names a commit or a pull request. The columns, and the values its created
 * event records.
 */
function filedState(fields: check.CreateFields, actor: Actor, at: string) {
  const close = fields.close;
  const held = fields.claim;
  const columns: Row = held ? { assignee: actor.name, assignee_model: actor.model ?? null } : {};
  if (fields.claim) columns.started_at = at;
  let delivery: JsonObject | null = null;
  if (close !== null) {
    Object.assign(columns, {
      closed_at: at,
      close_reason: close.reason,
      resolution: 'done',
      closed_by: actor.name,
      closed_model: actor.model ?? null,
      close_link: close.link,
    });
    if (close.commit !== null || close.pullRequest !== null) {
      Object.assign(columns, {
        delivery_stage: 'built',
        delivery_commit: close.commit,
        delivery_pull_request: close.pullRequest,
        built_at: at,
      });
      delivery = deliveryJson({
        stage: 'built',
        commit: close.commit,
        pullRequest: close.pullRequest,
        mergeCommit: null,
        builtAt: at,
        mergedAt: null,
        liveAt: null,
      });
    }
  }
  return {
    status: close !== null ? 'closed' : fields.claim ? 'in_progress' : 'open',
    columns,
    assignee: held ? actor.name : null,
    startedAt: fields.claim ? at : null,
    close:
      close === null
        ? null
        : {
            at,
            reason: close.reason,
            resolution: 'done',
            duplicateOf: null,
            by: actor.name,
            model: actor.model ?? null,
            link: close.link,
            acceptance: null,
          },
    delivery,
  } as const;
}

export class Writes {
  readonly #db: Database;
  readonly #reads: Reads;
  readonly #now: () => string;
  readonly #newKey: () => string;

  constructor(db: Database, reads: Reads, options: WriteOptions) {
    this.#db = db;
    this.#reads = reads;
    this.#now = options.now;
    this.#newKey = options.newKey;
  }

  #insert(table: string, row: Row): Statement {
    const columns = Object.keys(row);
    return this.#db
      .prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, index) => `?${index + 1}`).join(', ')})`,
      )
      .bind(...Object.values(row));
  }

  #event(
    task: { id: string; projectId: string },
    version: number,
    kind: TaskEventKind,
    actor: Actor,
    at: string,
    changes: JsonObject,
  ) {
    return this.#insert('task_events', {
      task_id: task.id,
      project_id: task.projectId,
      version,
      kind,
      actor: actor.name,
      model: actor.model ?? null,
      at,
      changes: JSON.stringify(changes),
    });
  }

  /**
   * The statements that add comment `id` to `task` with its history event,
   * pinned or not as `pins` says, and unpin the comments `pins` names. The
   * event records both, so the task's history says who pinned and unpinned
   * what, and when. The task's version stays as it is: the event records
   * `version`, or with null the version the task stands at when the batch runs.
   */
  #comment(
    task: { id: string; projectId: string },
    version: number | null,
    id: string,
    text: string,
    pins: check.CheckedPins | null,
    actor: Actor,
    at: string,
  ): Statement[] {
    const unpin = pins?.unpin ?? [];
    const changes: JsonObject = {
      commentId: id,
      text,
      ...(pins?.pin === true ? { pinned: true } : {}),
      ...(unpin.length > 0 ? { unpinned: [...unpin] } : {}),
    };
    const event =
      version === null
        ? this.#db
            .prepare(
              `INSERT INTO task_events (task_id, project_id, version, kind, actor, model, at, changes)
               SELECT id, project_id, version, 'commented', ?2, ?3, ?4, ?5 FROM tasks WHERE id = ?1`,
            )
            .bind(task.id, actor.name, actor.model ?? null, at, JSON.stringify(changes))
        : this.#event(task, version, 'commented', actor, at, changes);
    return [
      this.#insert('task_comments', {
        id,
        task_id: task.id,
        author: actor.name,
        text,
        created_at: at,
        pinned: pins?.pin === true ? 1 : 0,
      }),
      ...unpin.map((commentId) =>
        this.#db.prepare('UPDATE task_comments SET pinned = 0 WHERE id = ?1 AND task_id = ?2').bind(commentId, task.id),
      ),
      event,
    ];
  }

  /** Refuses pins that unpin a comment which is not a pinned comment of the task. */
  async #canUnpin(taskId: string, pins: check.CheckedPins | null): Promise<void> {
    const wanted = pins?.unpin ?? [];
    if (wanted.length === 0) return;
    const { results } = await this.#db
      .prepare(
        `SELECT m.id FROM json_each(?2) wanted CROSS JOIN task_comments m ON m.id = wanted.value
         WHERE m.task_id = ?1 AND m.pinned = 1`,
      )
      .bind(taskId, JSON.stringify(wanted))
      .all<{ id: string }>();
    const pinned = new Set(results.map((row) => row.id));
    const not = wanted.filter((id) => !pinned.has(id));
    if (not.length > 0) refuse('invalid', `${not.join(', ')} is not a pinned comment of ${taskId}`);
  }

  /** Adds an external link, or gives the one to the same URL this title and kind. */
  #externalLink(taskId: string, link: ExternalLink, actor: Actor, at: string): Statement {
    return this.#db
      .prepare(
        `INSERT INTO task_external_links (task_id, url, title, kind, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (task_id, url) DO UPDATE SET title = excluded.title, kind = excluded.kind`,
      )
      .bind(taskId, link.url, link.title, link.kind, at, actor.name);
  }

  /** Fails the batch with `version_conflict` when one of these fields was
   * retired since the write checked it, so the caller checks again. */
  #noneRetired(projectId: string, keys: readonly string[]): Statement {
    return this.#db
      .prepare(
        `INSERT INTO write_guard (ok, refusal) SELECT NOT EXISTS (
           SELECT 1 FROM json_each(?2) k CROSS JOIN custom_fields f ON f.project_id = ?1 AND f.key = k.value
           WHERE f.retired_at IS NOT NULL
         ), 'version_conflict'`,
      )
      .bind(projectId, JSON.stringify(keys));
  }

  /** Fails the batch with `cycle` if `from` already waits, through blocks links, on `to`. */
  #noBlockingLoop(from: string, to: string): Statement {
    return this.#db
      .prepare(
        `INSERT INTO write_guard (ok, refusal) SELECT NOT EXISTS (
           WITH RECURSIVE reach(id) AS (
             SELECT ?1
             UNION
             SELECT e.depends_on_id FROM task_edges e JOIN reach ON e.task_id = reach.id WHERE e.type = 'blocks'
           )
           SELECT 1 FROM reach WHERE id = ?2
         ), 'cycle'`,
      )
      .bind(from, to);
  }

  /** Fails the batch with `cycle` if `taskId` is `parentId` or one of its ancestors. */
  #noParentLoop(parentId: string, taskId: string): Statement {
    return this.#db
      .prepare(
        `INSERT INTO write_guard (ok, refusal) SELECT NOT EXISTS (
           WITH RECURSIVE up(id) AS (
             SELECT ?1
             UNION
             SELECT t.parent_id FROM tasks t JOIN up ON t.id = up.id WHERE t.parent_id IS NOT NULL
           )
           SELECT 1 FROM up WHERE id = ?2
         ), 'cycle'`,
      )
      .bind(parentId, taskId);
  }

  /** A new approval: the gate task, its created event, and the link by which `taskId` waits on it. */
  #gate(
    gateId: string,
    taskId: string,
    projectId: string,
    priority: number,
    { reason, title: given }: check.CheckedApproval,
    actor: Actor,
    at: string,
  ): Statement[] {
    // The reason holds a line that is not blank: validate.ts refuses one that does not.
    const title =
      given ??
      reason
        .replace(/\r/gu, '')
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line !== '')!
        .slice(0, 512);
    return this.#request(gateId, taskId, projectId, priority, { title, description: reason, steps: null }, actor, at);
  }

  /** The gate a write opens: an approval, or a request that a person do steps. */
  #opened(
    gateId: string,
    taskId: string,
    projectId: string,
    priority: number,
    write: Pick<check.CheckedWrite, 'requestApproval' | 'requestAction'>,
    actor: Actor,
    at: string,
  ): Statement[] {
    if (write.requestApproval !== null)
      return this.#gate(gateId, taskId, projectId, priority, write.requestApproval, actor, at);
    const { title, context, steps } = write.requestAction!;
    return this.#request(gateId, taskId, projectId, priority, { title, description: context, steps }, actor, at);
  }

  /** A new request to a person: the gate task, its created event, and the
   * link by which `taskId` waits on it. With steps, it asks them to do the
   * steps; without, to approve its description. */
  #request(
    gateId: string,
    taskId: string,
    projectId: string,
    priority: number,
    ask: { readonly title: string; readonly description: string; readonly steps: readonly TaskStep[] | null },
    actor: Actor,
    at: string,
  ): Statement[] {
    const { title, description: reason, steps } = ask;
    return [
      this.#insert('tasks', {
        id: gateId,
        project_id: projectId,
        type: 'gate',
        await_type: 'human',
        status: 'open',
        priority,
        title,
        description: reason,
        metadata: '{}',
        filed_by: actor.name,
        filed_model: actor.model ?? null,
        version: 1,
        created_at: at,
        updated_at: at,
        steps: steps === null ? null : JSON.stringify(steps),
      }),
      this.#event({ id: gateId, projectId }, 1, 'created', actor, at, {
        id: gateId,
        projectId,
        parentId: null,
        type: 'gate',
        awaitType: 'human',
        status: 'open',
        priority,
        title,
        description: reason,
        acceptance: '',
        notes: '',
        design: '',
        estimateMinutes: null,
        assignee: null,
        assigneeModel: null,
        assigneeFor: null,
        work: {},
        startedAt: null,
        deferUntil: null,
        dueAt: null,
        choices: null,
        choice: null,
        metadata: {},
        labels: [],
        dependencies: [],
        externalLinks: [],
        fields: {},
        close: null,
        ...(steps === null ? {} : { steps: steps as unknown as Json }),
        filedBy: actor.name,
        filedModel: actor.model ?? null,
      }),
      this.#insert('task_edges', {
        task_id: taskId,
        depends_on_id: gateId,
        type: 'blocks',
        created_at: at,
        created_by: actor.name,
      }),
    ];
  }

  #cutoff(hours = RECEIPT_DAYS * 24): string {
    return new Date(Date.parse(this.#now()) - hours * 3_600_000).toISOString();
  }

  /**
   * The recorded result of an earlier write with this key, or null; a key
   * reused for another request is refused. A derived key's stale record
   * answers nothing, so the write runs again (#staleReceipt clears it).
   */
  async #recorded(retry: Retry | undefined, projectId: string): Promise<Record<string, Json> | null> {
    if (retry === undefined) return null;
    const row = await this.#db
      .prepare(
        `SELECT project_id, request_hash, result, ${STALE('?5')} AS stale FROM write_receipts
         WHERE principal = ?1 AND operation = ?2 AND idempotency_key = ?3 AND created_at >= ?4`,
      )
      .bind(retry.principal, retry.operation, retry.key, this.#cutoff(), this.#cutoff(DERIVED_NEW_TASK_HOURS))
      .first<{ project_id: string; request_hash: string; result: string; stale: number }>();
    if (row === null) return null;
    if (row.request_hash !== retry.requestHash || row.project_id !== projectId) refuse('retry_conflict');
    if (retry.derived === true && row.stale) return null;
    return JSON.parse(row.result) as Record<string, Json>;
  }

  /**
   * For a derived key, the statement that clears its record when stale. It
   * goes first in the write's batch, so it reads the task as the write found
   * it: a record that a racing identical write just made stands, and this
   * write's own record then collides with it and replays it.
   */
  #staleReceipt(retry: Retry | undefined): Statement[] {
    if (retry?.derived !== true) return [];
    return [
      this.#db
        .prepare(
          `DELETE FROM write_receipts WHERE principal = ?1 AND operation = ?2 AND idempotency_key = ?3 AND ${STALE('?4')}`,
        )
        .bind(retry.principal, retry.operation, retry.key, this.#cutoff(DERIVED_NEW_TASK_HOURS)),
    ];
  }

  /**
   * Clears this principal's expired records, then records this write's
   * result. A derived key's record also keeps the version the batch leaves
   * each task of `left` at, read as the record lands, and with `newTask`
   * marks a record of tasks the write created, which answers for a day.
   */
  #receipt(
    retry: Retry | undefined,
    projectId: string,
    result: JsonObject,
    at: string,
    left: readonly string[] = [],
    newTask = false,
  ): Statement[] {
    if (retry === undefined) return [];
    return [
      this.#db
        .prepare('DELETE FROM write_receipts WHERE principal = ?1 AND created_at < ?2')
        .bind(retry.principal, this.#cutoff()),
      retry.derived === true
        ? this.#db
            .prepare(
              `INSERT INTO write_receipts (principal, operation, idempotency_key, project_id, request_hash, result, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, json_set(?6, '$.left', json((
                 SELECT json_group_array(json_object('taskId', id, 'version', version)) FROM tasks
                 WHERE project_id = ?4 AND id IN (SELECT value FROM json_each(?8))))), ?7)`,
            )
            .bind(
              retry.principal,
              retry.operation,
              retry.key,
              projectId,
              retry.requestHash,
              JSON.stringify(newTask ? { ...result, newTask: true } : result),
              at,
              JSON.stringify(left),
            )
        : this.#insert('write_receipts', {
            principal: retry.principal,
            operation: retry.operation,
            idempotency_key: retry.key,
            project_id: projectId,
            request_hash: retry.requestHash,
            result: JSON.stringify(result),
            created_at: at,
          }),
    ];
  }

  async #result(
    projectId: string,
    taskId: string,
    created: readonly string[],
    replayed: boolean,
  ): Promise<WriteResult> {
    const tasks = (await this.#reads.taskRows(projectId, [taskId, ...created])).map(toTask);
    const task = tasks.find((candidate) => candidate.id === taskId) ?? refuse('not_found');
    return {
      task,
      created: created.map((id) => tasks.find((candidate) => candidate.id === id) ?? refuse('not_found')),
      replayed,
    };
  }

  /** A recorded write's answer as it stands now, with the comment it added, if any. */
  async #recordedResult(projectId: string, recorded: Record<string, Json>, taskId: string): Promise<WriteResult> {
    const result = await this.#result(projectId, taskId, recorded.created as string[], true);
    if (typeof recorded.commentId !== 'string') return result;
    const comment = (await this.#reads.listComments(projectId, taskId)).find(
      (candidate) => candidate.id === recorded.commentId,
    );
    return comment === undefined ? result : { ...result, comment };
  }

  async #replay(retry: Retry | undefined, projectId: string): Promise<WriteResult | null> {
    const recorded = await this.#recorded(retry, projectId);
    if (recorded === null) return null;
    return this.#recordedResult(projectId, recorded, recorded.taskId as string);
  }

  async recordedWrite(projectId: string, retryInput: Retry): Promise<WriteResult | null> {
    const retry = check.retry(retryInput) ?? check.invalid('a retry identity is required');
    const recorded = await this.#recorded(retry, projectId);
    if (recorded === null) return null;
    // A comment's record names no task: its key was used for another kind of request.
    if (typeof recorded.taskId !== 'string') refuse('retry_conflict');
    return this.#recordedResult(projectId, recorded, recorded.taskId);
  }

  async recordUnchanged(
    projectId: string,
    taskId: string,
    expectedVersion: number,
    retryInput: Retry,
  ): Promise<WriteResult> {
    const retry = check.retry(retryInput) ?? check.invalid('a retry identity is required');
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
      check.invalid('expectedVersion must be the version you read, a whole number of 1 or more');
    const replayed = await this.#replay(retry, projectId);
    if (replayed !== null) return replayed;
    try {
      await this.#db.batch([
        ...this.#staleReceipt(retry),
        this.#db
          .prepare(
            `INSERT INTO write_guard (ok, refusal) SELECT EXISTS (
               SELECT 1 FROM tasks WHERE id = ?1 AND project_id = ?2
             ), 'not_found'`,
          )
          .bind(taskId, projectId),
        // The guard, not an earlier read, decides: the task must stand at the
        // version the caller planned from when the record lands.
        this.#db
          .prepare(
            `INSERT INTO write_guard (ok, refusal) SELECT EXISTS (
               SELECT 1 FROM tasks WHERE id = ?1 AND project_id = ?2 AND version = ?3
             ), 'version_conflict'`,
          )
          .bind(taskId, projectId, expectedVersion),
        ...this.#receipt(retry, projectId, { taskId, created: [] }, this.#now(), [taskId]),
      ]);
    } catch (error) {
      // The same retried request may have recorded its answer while this one ran.
      const replay = await this.#replay(retry, projectId);
      if (replay !== null) return replay;
      failureOf(error);
      refuse('retry_conflict');
    }
    return this.#result(projectId, taskId, [], false);
  }

  async #projectOf(projectId: string): Promise<Project> {
    return (await this.#reads.project(projectId)) ?? refuse('not_found', 'The project does not exist.');
  }

  /** The id the parent's next child takes: its id, a dot and one more than the highest child number used. */
  async #childId(parentId: string): Promise<string> {
    const row = await this.#db
      // The pattern is one bound value, so SQLite reaches it through the primary key's index.
      .prepare(
        `SELECT coalesce(max(CAST(substr(id, length(?1) + 2) AS INTEGER)), 0) + 1 AS next FROM tasks WHERE id GLOB ?2`,
      )
      .bind(parentId, `${parentId}.[0-9]*`)
      .first<{ next: number }>();
    return `${parentId}.${row?.next ?? 1}`;
  }

  async #existing(projectId: string | null, taskIds: readonly string[]): Promise<Map<string, StoredTaskRow>> {
    if (taskIds.length === 0) return new Map();
    const { results } = await this.#db
      .prepare(
        `SELECT t.* FROM (SELECT DISTINCT value AS id FROM json_each(?1)) wanted CROSS JOIN tasks t ON t.id = wanted.id` +
          (projectId === null ? '' : ' WHERE t.project_id = ?2'),
      )
      .bind(...(projectId === null ? [JSON.stringify(taskIds)] : [JSON.stringify(taskIds), projectId]))
      .all<StoredTaskRow>();
    const found = new Map(results.map((row) => [row.id, row]));
    for (const id of taskIds) if (!found.has(id)) refuse('not_found', `There is no task ${id}.`);
    return found;
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const id = check.text(input?.id, 'id', 64, true);
    const key = check.text(input.key, 'key', 128, true);
    const name = check.text(input.name, 'name', 128, true);
    if (typeof input.prefix !== 'string' || !/^[a-z0-9]{1,32}$/u.test(input.prefix)) {
      check.invalid('prefix must be 1 to 32 lowercase letters or digits, with no hyphen');
    }
    try {
      await this.#insert('projects', { id, key, name, prefix: input.prefix, created_at: this.#now() }).run();
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed'))
        check.invalid('another project already uses this id, key or prefix');
      throw error;
    }
    return this.#projectOf(id);
  }

  async setProjectDeploys(projectId: string, deploys: boolean): Promise<Project> {
    if (typeof deploys !== 'boolean') check.invalid('deploys must be true or false');
    await this.#projectOf(projectId);
    await this.#db
      .prepare('UPDATE projects SET deploys = ?2 WHERE id = ?1')
      .bind(projectId, deploys ? 1 : 0)
      .run();
    return this.#projectOf(projectId);
  }

  async reportDelivery(
    projectIdsInput: readonly string[],
    signalInput: DeliverySignal,
    actorInput: Actor,
    options: DeliveryOptions = {},
  ): Promise<DeliveryMove[]> {
    const actor = check.actor(actorInput);
    const signal = check.deliverySignal(signalInput);
    if (!Array.isArray(projectIdsInput) || !projectIdsInput.every((id) => typeof id === 'string'))
      check.invalid('projectIds must be project ids');
    if (projectIdsInput.length === 0) return [];
    const turnOn = signal.stage === 'live' ? options.turnOnDeploys : undefined;
    const kept = new Set(turnOn?.except ?? []);
    // Only a merge names its merge commit, and only when it names one commit.
    const mergeCommit = signal.stage === 'merged' && signal.commits.length === 1 ? signal.commits[0]! : null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const { results } = await this.#db
        .prepare(DELIVERY_CANDIDATES)
        .bind(
          JSON.stringify([...new Set(projectIdsInput)]),
          JSON.stringify(signal.pullRequests),
          JSON.stringify(signal.commits),
        )
        .all<StoredTaskRow & { readonly deploys: number }>();
      const at = this.#now();
      const statements: Statement[] = [];
      const moves: DeliveryMove[] = [];
      const turnedOn = new Set<string>();
      for (const row of results) {
        const current = deliveryOf(row);
        if (current === null) continue;
        const turnsOn = turnOn !== undefined && row.deploys !== 1 && !kept.has(row.project_id);
        if (turnsOn && !turnedOn.has(row.project_id)) {
          turnedOn.add(row.project_id);
          statements.push(
            this.#db.prepare('UPDATE projects SET deploys = 1 WHERE id = ?1 AND deploys = 0').bind(row.project_id),
          );
        }
        // A project that does not deploy has nothing after merged.
        const stage: DeliveryStage = signal.stage === 'live' && row.deploys !== 1 && !turnsOn ? 'merged' : signal.stage;
        if (STAGE_ORDER[stage] <= STAGE_ORDER[current.stage]) continue;
        const next: TaskDelivery = {
          ...current,
          stage,
          mergeCommit: current.mergeCommit ?? mergeCommit,
          mergedAt: stage === 'merged' ? at : current.mergedAt,
          liveAt: stage === 'live' ? at : null,
        };
        statements.push(
          this.#db
            .prepare(
              `UPDATE tasks SET delivery_stage = ?1, delivery_merge_commit = ?2, merged_at = ?3, live_at = ?4,
                 version = version + 1, updated_at = ?5
               WHERE id = ?6 AND version = ?7`,
            )
            .bind(next.stage, next.mergeCommit, next.mergedAt, next.liveAt, at, row.id, row.version),
          this.#db.prepare("INSERT INTO write_guard (ok, refusal) VALUES (changes() = 1, 'version_conflict')"),
          this.#event({ id: row.id, projectId: row.project_id }, row.version + 1, 'updated', actor, at, {
            delivery: deliveryJson(next),
          }),
        );
        moves.push({ taskId: row.id, projectId: row.project_id, stage });
      }
      if (statements.length === 0) return [];
      try {
        await this.#db.batch(statements);
        return moves;
      } catch (error) {
        // Another write changed a task this signal moves: read the tasks again and decide again.
        if (guardRefusalOf(messageOf(error)) === 'version_conflict') continue;
        throw error;
      }
    }
    refuse('version_conflict', 'The tasks this signal moves kept changing; send it again.');
  }

  async createTask(
    projectId: string,
    input: CreateTaskInput,
    actorInput: Actor,
    retryInput?: Retry,
  ): Promise<WriteResult> {
    const actor = check.actor(actorInput);
    const retry = check.retry(retryInput);
    const fields = check.createInput(input);
    const project = await this.#projectOf(projectId);
    const replayed = await this.#replay(retry, projectId);
    if (replayed !== null) return replayed;
    if (fields.parentId !== null) await this.#existing(projectId, [fields.parentId]);
    await this.#existing(
      null,
      fields.links.map((link) => link.taskId),
    );
    // A `blocks`-direction link changes the other task too: its version, and its history.
    const changedOthers = [
      ...new Set(fields.links.filter((link) => link.direction === 'blocks').map((link) => link.taskId)),
    ];

    let lastFailure: 'id_taken' | 'version_conflict' = 'id_taken';
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      // Read again on every attempt: the caller named no version for these
      // tasks, so a change to one of them since is retried, not refused.
      const others = (await this.#reads.taskRows(projectId, changedOthers)).map(toTask);
      if (others.length !== changedOthers.length)
        refuse('not_found', 'A task this new one blocks is not in this project.');
      const id =
        fields.parentId === null ? `${project.prefix}-${this.#newKey()}` : await this.#childId(fields.parentId);
      const gateId = fields.requestApproval === null ? null : `${project.prefix}-${this.#newKey()}`;
      const created = gateId === null ? [] : [gateId];
      const at = this.#now();
      const dependencies = new Map<string, DependencyType>();
      if (gateId !== null) dependencies.set(gateId, 'blocks');
      // Checked on every attempt: a field retired since the last one takes no value.
      const values = new Map<string, FieldValue>();
      if (fields.fields !== null) {
        const checked = check.fieldValues(await this.#reads.listFields(projectId), fields.fields, false);
        for (const [key, value] of Object.entries(checked)) if (value !== null) values.set(key, value);
      }
      const filed = filedState(fields, actor, at);
      const statements: Statement[] = [
        ...this.#staleReceipt(retry),
        this.#insert('tasks', {
          id,
          project_id: projectId,
          parent_id: fields.parentId,
          type: fields.type,
          status: filed.status,
          ...filed.columns,
          priority: fields.priority,
          title: fields.title,
          description: fields.description,
          acceptance: fields.acceptance,
          notes: fields.notes,
          design: fields.design,
          estimate_minutes: fields.estimateMinutes,
          field_values: JSON.stringify(fieldMap(values)),
          defer_until: fields.deferUntil,
          due_at: fields.dueAt,
          choices: fields.choices === null ? null : JSON.stringify(fields.choices),
          metadata: JSON.stringify(fields.metadata),
          filed_by: actor.name,
          filed_model: actor.model ?? null,
          version: 1,
          created_at: at,
          updated_at: at,
        }),
        ...fields.labels.map((label) => this.#insert('task_labels', { task_id: id, label })),
        ...fields.externalLinks.map((link) => this.#externalLink(id, link, actor, at)),
        ...(values.size === 0 ? [] : [this.#noneRetired(projectId, [...values.keys()])]),
      ];
      if (gateId !== null && fields.requestApproval !== null) {
        statements.push(...this.#gate(gateId, id, projectId, fields.priority, fields.requestApproval, actor, at));
      }
      for (const link of fields.links) {
        if (link.taskId === id) refuse('invalid', 'A task cannot link to itself.');
        const [from, to] = link.direction === 'depends-on' ? [id, link.taskId] : [link.taskId, id];
        if (link.direction === 'depends-on') dependencies.set(link.taskId, link.type);
        statements.push(
          this.#insert('task_edges', {
            task_id: from,
            depends_on_id: to,
            type: link.type,
            created_at: at,
            created_by: actor.name,
          }),
        );
        if (link.type === 'blocks') statements.push(this.#noBlockingLoop(to, from));
      }
      for (const other of others) {
        const otherLinks = new Map(other.dependencies.map((dependency) => [dependency.taskId, dependency.type]));
        for (const link of fields.links)
          if (link.direction === 'blocks' && link.taskId === other.id) otherLinks.set(id, link.type);
        statements.push(
          this.#db
            .prepare('UPDATE tasks SET version = version + 1, updated_at = ?1 WHERE id = ?2 AND version = ?3')
            .bind(at, other.id, other.version),
          this.#db.prepare("INSERT INTO write_guard (ok, refusal) VALUES (changes() = 1, 'version_conflict')"),
          this.#event(other, other.version + 1, 'updated', actor, at, { dependencies: linkList(otherLinks) }),
        );
      }
      statements.push(
        this.#event({ id, projectId }, 1, 'created', actor, at, {
          id,
          projectId,
          parentId: fields.parentId,
          type: fields.type,
          awaitType: null,
          status: filed.status,
          priority: fields.priority,
          title: fields.title,
          description: fields.description,
          acceptance: fields.acceptance,
          notes: fields.notes,
          design: fields.design,
          estimateMinutes: fields.estimateMinutes,
          assignee: filed.assignee,
          assigneeModel: filed.assignee === null ? null : (actor.model ?? null),
          assigneeFor: null,
          work: {},
          startedAt: filed.startedAt,
          deferUntil: fields.deferUntil,
          dueAt: fields.dueAt,
          choices: fields.choices,
          choice: null,
          metadata: fields.metadata,
          labels: [...fields.labels].sort(),
          dependencies: linkList(dependencies),
          externalLinks: externalList(new Map(fields.externalLinks.map((link) => [link.url, link]))),
          fields: fieldMap(values),
          close: filed.close,
          ...(filed.delivery === null ? {} : { delivery: filed.delivery }),
          filedBy: actor.name,
          filedModel: actor.model ?? null,
        }),
        ...this.#receipt(retry, projectId, { taskId: id, created }, at, [id, ...created], true),
      );
      try {
        await this.#db.batch(statements);
        return await this.#result(projectId, id, created, false);
      } catch (error) {
        if (guardRefusalOf(messageOf(error)) === 'version_conflict') {
          lastFailure = 'version_conflict';
          continue;
        }
        const failure = failureOf(error);
        if (failure === 'id_taken') {
          lastFailure = 'id_taken';
          continue;
        }
        return (await this.#replay(retry, projectId)) ?? refuse('retry_conflict');
      }
    }
    if (lastFailure === 'version_conflict')
      refuse('version_conflict', 'A task this new one blocks kept changing; try again.');
    throw new Error(`No free task id in project ${projectId} after ${ATTEMPTS} attempts.`);
  }

  async writeTask(
    projectId: string,
    taskId: string,
    writeInput: TaskWrite,
    actorInput: Actor,
    retryInput?: Retry,
  ): Promise<WriteResult> {
    const actor = check.actor(actorInput);
    const retry = check.retry(retryInput);
    const write = check.write(writeInput);
    if (write.others.some((other) => other.taskId === taskId))
      refuse('invalid', 'others names other tasks than the one written');
    const project = await this.#projectOf(projectId);
    const rows = await this.#reads.taskRows(projectId, [taskId, ...write.others.map((other) => other.taskId)]);
    const row = rows.find((candidate) => candidate.id === taskId);
    if (row === undefined) refuse('not_found');
    const replayed = await this.#replay(retry, projectId);
    if (replayed !== null) return replayed;
    if (row.version !== write.expectedVersion) refuse('version_conflict');
    const at = this.#now();
    const commentId = write.comment === null ? null : crypto.randomUUID();
    const change = await this.#prepare(projectId, toTask(row), write, actor, at, false, commentId);
    const others = await Promise.all(
      write.others.map(async (other) => {
        const found = rows.find((candidate) => candidate.id === other.taskId);
        if (found === undefined) refuse('not_found', `There is no task ${other.taskId}.`);
        if (found.version !== other.write.expectedVersion) refuse('version_conflict');
        const otherComment = other.write.comment === null ? null : crypto.randomUUID();
        return this.#prepare(projectId, toTask(found), other.write, actor, at, true, otherComment);
      }),
    );

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const opens = write.requestApproval !== null || write.requestAction !== null;
      const gateId = opens ? `${project.prefix}-${this.#newKey()}` : null;
      const recorded = {
        taskId,
        created: gateId === null ? [] : [gateId],
        ...(commentId === null ? {} : { commentId }),
      };
      const statements: Statement[] = [
        ...this.#staleReceipt(retry),
        ...change(gateId),
        ...others.flatMap((other) => other(null)),
        ...this.#receipt(retry, projectId, recorded, at, [
          taskId,
          ...recorded.created,
          ...write.others.map((other) => other.taskId),
        ]),
      ];
      try {
        await this.#db.batch(statements);
        const result = await this.#result(projectId, taskId, recorded.created, false);
        if (commentId === null || write.comment === null) return result;
        const comment: TaskComment = {
          id: commentId,
          taskId,
          author: actor.name,
          text: write.comment,
          createdAt: at,
          pinned: write.pins?.pin === true,
        };
        return { ...result, comment };
      } catch (error) {
        // The same retried request may have committed while this attempt ran;
        // its version then moved on, and the recorded result is the answer.
        if (guardRefusalOf(messageOf(error)) === 'version_conflict') {
          const replay = await this.#replay(retry, projectId);
          if (replay !== null) return replay;
        }
        const failure = failureOf(error);
        if (failure === 'id_taken') continue;
        return (await this.#replay(retry, projectId)) ?? refuse('retry_conflict');
      }
    }
    throw new Error(`No free task id in project ${projectId} after ${ATTEMPTS} attempts.`);
  }

  /**
   * The statements that make `write` to `current`, as of `at`, given the id a
   * requested approval's gate takes, and the id its comment takes. A write
   * that only adds a comment to a task it rides beside (`others`), or a
   * comment with a helper and work details that change nothing, leaves the
   * task's version as it is.
   */
  async #prepare(
    projectId: string,
    current: Task,
    write: check.CheckedWrite,
    actor: Actor,
    at: string,
    beside: boolean,
    commentId: string | null,
  ): Promise<(gateId: string | null) => Statement[]> {
    const taskId = current.id;
    const set = write.set;
    const columns: Row = {};
    const changes: Record<string, Json> = {};
    const change = (column: string, field: string, value: string | number | null, recorded: Json = value) => {
      columns[column] = value;
      changes[field] = recorded;
    };
    const closed = current.status === 'closed';
    if (write.close !== null && closed) refuse('invalid', 'The task is already closed.');
    if (write.reopen && !closed) refuse('invalid', 'Only a closed task can be reopened.');
    if (closed && !write.reopen && set.status !== undefined)
      refuse('invalid', 'Reopen a closed task before changing its status.');
    if (current.type === 'gate' && set.type !== undefined) refuse('invalid', "A gate's type cannot change.");
    await this.#canUnpin(taskId, write.pins);

    if (set.title !== undefined) change('title', 'title', set.title);
    if (set.description !== undefined) change('description', 'description', set.description);
    if (set.acceptance !== undefined) change('acceptance', 'acceptance', set.acceptance);
    if (set.notes !== undefined) change('notes', 'notes', set.notes);
    if (set.design !== undefined) change('design', 'design', set.design);
    if (set.estimateMinutes !== undefined) change('estimate_minutes', 'estimateMinutes', set.estimateMinutes);
    if (set.type !== undefined) change('type', 'type', set.type);
    if (set.priority !== undefined) change('priority', 'priority', set.priority);
    if (set.deferUntil !== undefined) change('defer_until', 'deferUntil', set.deferUntil);
    if (set.dueAt !== undefined) change('due_at', 'dueAt', set.dueAt);
    if (set.choices !== undefined)
      change('choices', 'choices', set.choices === null ? null : JSON.stringify(set.choices), set.choices);
    if (set.choice !== undefined)
      change('choice', 'choice', set.choice === null ? null : JSON.stringify(set.choice), set.choice);
    const choices = set.choices !== undefined ? set.choices : current.choices;
    const choice = set.choice !== undefined ? set.choice : current.choice;
    if (choice !== null && choices === null) refuse('invalid', 'A choice needs choices to pick from.');
    if (set.steps !== undefined) {
      const filed = current.steps;
      if (filed === null) refuse('invalid', 'Only a request that a person do steps has steps.');
      const kept =
        set.steps.length === filed.length &&
        set.steps.every((step, index) => step.text === filed[index]!.text && step.command === filed[index]!.command);
      if (!kept) refuse('invalid', "A request's steps keep the text and commands it was filed with.");
      change('steps', 'steps', JSON.stringify(set.steps), set.steps as unknown as Json);
    }

    if (set.parentId !== undefined && set.parentId !== current.parentId) {
      if (set.parentId === taskId) refuse('cycle');
      if (set.parentId !== null) await this.#existing(projectId, [set.parentId]);
      change('parent_id', 'parentId', set.parentId);
    }

    if (set.assignee !== undefined && set.assignee !== current.assignee) {
      const claim = set.assignee === actor.name;
      if (claim && current.assignee !== null) refuse('held', `${current.assignee} holds this task.`);
      change('assignee', 'assignee', set.assignee);
      change('assignee_model', 'assigneeModel', claim ? (actor.model ?? null) : null);
    }

    // The helper and the work details are the holder's: a write that ends its
    // hold, by a release, a hand-on or a close, starts them over from none.
    const holder = set.assignee !== undefined ? set.assignee : current.assignee;
    const closedAfter = write.close !== null || (closed && !write.reopen);
    const ended = write.close !== null || (set.assignee !== undefined && set.assignee !== current.assignee);
    const helper = set.assigneeFor !== undefined ? set.assigneeFor : ended ? null : current.assigneeFor;
    const work = workIn({ ...(ended ? {} : current.work), ...set.work });
    if ((helper !== null || Object.keys(work).length > 0) && (holder === null || closedAfter))
      refuse('invalid', "A helper and work details belong to the task's holder: the task needs one, and to be open.");
    if (helper !== current.assigneeFor) change('assignee_for', 'assigneeFor', helper);
    if (JSON.stringify(work) !== JSON.stringify(workIn(current.work)))
      change('work', 'work', JSON.stringify(work), work);

    let kind: TaskEventKind = 'updated';
    if (write.close !== null) {
      kind = 'closed';
      if (write.close.duplicateOf !== null) {
        if (write.close.duplicateOf === taskId) refuse('invalid', 'A task cannot duplicate itself.');
        await this.#existing(projectId, [write.close.duplicateOf]);
      }
      columns.status = 'closed';
      columns.closed_at = at;
      columns.close_reason = write.close.reason;
      columns.resolution = write.close.resolution;
      columns.duplicate_of = write.close.duplicateOf;
      columns.closed_by = actor.name;
      columns.closed_model = actor.model ?? null;
      columns.close_link = write.close.link;
      const { acceptance } = write.close;
      columns.close_acceptance = acceptance === null ? null : JSON.stringify(acceptance);
      changes.status = 'closed';
      changes.close = {
        at,
        reason: write.close.reason,
        resolution: write.close.resolution,
        duplicateOf: write.close.duplicateOf,
        by: actor.name,
        model: actor.model ?? null,
        link: write.close.link,
        acceptance: acceptance as unknown as JsonObject | null,
      };
      const { commit, pullRequest } = write.close;
      if (commit !== null || pullRequest !== null) {
        columns.delivery_stage = 'built';
        columns.delivery_commit = commit;
        columns.delivery_pull_request = pullRequest;
        columns.built_at = at;
        changes.delivery = deliveryJson({
          stage: 'built',
          commit,
          pullRequest,
          mergeCommit: null,
          builtAt: at,
          mergedAt: null,
          liveAt: null,
        });
      }
    } else if (write.reopen) {
      kind = 'reopened';
      for (const column of [
        'closed_at',
        'close_reason',
        'resolution',
        'duplicate_of',
        'closed_by',
        'closed_model',
        'close_link',
        'close_acceptance',
        ...DELIVERY_COLUMNS,
      ])
        columns[column] = null;
      change('status', 'status', set.status ?? 'open');
      changes.close = null;
      if (current.delivery !== null) changes.delivery = null;
    } else if (set.status !== undefined) {
      change('status', 'status', set.status);
    }
    const status = (columns.status as string | undefined) ?? current.status;
    if (status === 'in_progress' && current.startedAt === null) change('started_at', 'startedAt', at);

    if (write.metadata !== null) {
      const metadata: Record<string, Json> = { ...current.metadata };
      for (const [key, value] of Object.entries(write.metadata)) {
        if (value === null) delete metadata[key];
        else metadata[key] = value;
      }
      change('metadata', 'metadata', JSON.stringify(metadata), metadata);
    }

    const labels = new Set(current.labels);
    const addLabels = write.addLabels.filter((label) => !labels.has(label));
    const removeLabels = write.removeLabels.filter((label) => labels.has(label));
    for (const label of addLabels) labels.add(label);
    for (const label of removeLabels) labels.delete(label);
    if (addLabels.length > 0 || removeLabels.length > 0) changes.labels = [...labels].sort();

    const links = new Map(current.dependencies.map((dependency) => [dependency.taskId, dependency.type]));
    const removeLinks = write.removeLinks.filter((id) => links.has(id));
    for (const id of removeLinks) links.delete(id);
    for (const link of write.addLinks) if (link.taskId === taskId) refuse('invalid', 'A task cannot link to itself.');
    await this.#existing(
      null,
      write.addLinks.map((link) => link.taskId),
    );
    const addLinks = write.addLinks.filter((link) => links.get(link.taskId) !== link.type);
    for (const link of addLinks) links.set(link.taskId, link.type);

    const values = new Map(Object.entries(current.fields));
    const setValues: [string, FieldValue][] = [];
    const clearValues: string[] = [];
    if (write.setFields !== null) {
      const checked = check.fieldValues(await this.#reads.listFields(projectId), write.setFields, true);
      for (const [key, value] of Object.entries(checked)) {
        const standing = values.get(key);
        if (value === null) {
          if (standing === undefined) continue;
          values.delete(key);
          clearValues.push(key);
        } else if (JSON.stringify(standing) !== JSON.stringify(value)) {
          values.set(key, value);
          setValues.push([key, value]);
        }
      }
      if (setValues.length > 0 || clearValues.length > 0)
        change('field_values', 'fields', JSON.stringify(fieldMap(values)), fieldMap(values));
    }

    const external = new Map(current.externalLinks.map((link) => [link.url, link]));
    const removeExternal = write.removeExternalLinks.filter((url) => external.has(url));
    for (const url of removeExternal) external.delete(url);
    const addExternal = write.addExternalLinks.filter((link) => {
      const standing = external.get(link.url);
      return standing?.title !== link.title || standing.kind !== link.kind;
    });
    for (const link of addExternal) external.set(link.url, link);
    // Only a write that adds is held to the limit, so a task imported with more can still lose some.
    if (addExternal.length > 0 && external.size > TASK_LIMITS.externalLinks)
      refuse('invalid', `a task links to at most ${TASK_LIMITS.externalLinks} pages outside Ntasks`);
    if (addExternal.length > 0 || removeExternal.length > 0) changes.externalLinks = externalList(external);

    // A comment riding beside another task's write, or one whose helper and
    // work details change nothing, is a plain comment: the version stays.
    const keys = Object.keys(set);
    const detailsOnly = keys.length > 0 && keys.every((key) => key === 'assigneeFor' || key === 'work');
    const commentOnly =
      (beside || detailsOnly) &&
      write.comment !== null &&
      write.requestApproval === null &&
      write.requestAction === null &&
      Object.keys(columns).length === 0 &&
      addLabels.length === 0 &&
      removeLabels.length === 0 &&
      addLinks.length === 0 &&
      removeLinks.length === 0 &&
      addExternal.length === 0 &&
      removeExternal.length === 0;
    return (gateId) => {
      const comment = (version: number): Statement[] => {
        if (write.comment === null || commentId === null) return [];
        return this.#comment(current, version, commentId, write.comment, write.pins, actor, at);
      };
      if (commentOnly) {
        // The write was planned from this version of the task; the batch fails whole if it moved since.
        return [
          this.#db
            .prepare(
              `INSERT INTO write_guard (ok, refusal) SELECT EXISTS (
                 SELECT 1 FROM tasks WHERE id = ?1 AND project_id = ?2 AND version = ?3
               ), 'version_conflict'`,
            )
            .bind(taskId, projectId, current.version),
          ...comment(current.version),
        ];
      }
      const taskLinks = new Map(links);
      if (gateId !== null) taskLinks.set(gateId, 'blocks');
      if (gateId !== null || addLinks.length > 0 || removeLinks.length > 0) changes.dependencies = linkList(taskLinks);
      const version = current.version + 1;
      const assignments = Object.keys(columns).map((column, index) => `${column} = ?${index + 1}`);
      const values = Object.values(columns);
      const statements: Statement[] = [
        this.#db
          .prepare(
            `UPDATE tasks SET ${[...assignments, 'version = version + 1', `updated_at = ?${values.length + 1}`].join(', ')}
             WHERE id = ?${values.length + 2} AND project_id = ?${values.length + 3} AND version = ?${values.length + 4}`,
          )
          .bind(...values, at, taskId, projectId, current.version),
        this.#db.prepare("INSERT INTO write_guard (ok, refusal) VALUES (changes() = 1, 'version_conflict')"),
      ];
      if (set.parentId !== undefined && set.parentId !== null && set.parentId !== current.parentId) {
        statements.push(this.#noParentLoop(set.parentId, taskId));
      }
      if (gateId !== null)
        statements.push(...this.#opened(gateId, taskId, projectId, current.priority, write, actor, at));
      for (const label of removeLabels) {
        statements.push(
          this.#db.prepare('DELETE FROM task_labels WHERE task_id = ?1 AND label = ?2').bind(taskId, label),
        );
      }
      for (const label of addLabels) statements.push(this.#insert('task_labels', { task_id: taskId, label }));
      for (const id of removeLinks) {
        statements.push(
          this.#db.prepare('DELETE FROM task_edges WHERE task_id = ?1 AND depends_on_id = ?2').bind(taskId, id),
        );
      }
      for (const link of addLinks) {
        statements.push(
          this.#db
            .prepare(
              `INSERT INTO task_edges (task_id, depends_on_id, type, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5)
               ON CONFLICT (task_id, depends_on_id) DO UPDATE SET type = excluded.type`,
            )
            .bind(taskId, link.taskId, link.type, at, actor.name),
        );
        if (link.type === 'blocks') statements.push(this.#noBlockingLoop(link.taskId, taskId));
      }
      for (const url of removeExternal) {
        statements.push(
          this.#db.prepare('DELETE FROM task_external_links WHERE task_id = ?1 AND url = ?2').bind(taskId, url),
        );
      }
      for (const link of addExternal) statements.push(this.#externalLink(taskId, link, actor, at));
      if (setValues.length > 0)
        statements.push(
          this.#noneRetired(
            projectId,
            setValues.map(([key]) => key),
          ),
        );
      statements.push(...comment(version), this.#event(current, version, kind, actor, at, changes));
      return statements;
    };
  }

  /** The project's field with this key, or null. */
  async #field(projectId: string, key: string): Promise<CustomField | null> {
    const row = await this.#db
      .prepare('SELECT * FROM custom_fields WHERE project_id = ?1 AND key = ?2')
      .bind(projectId, key)
      .first<FieldRow>();
    return row === null ? null : toField(row);
  }

  /** The answer of an earlier define or retire with this retry identity, or null. */
  async #recordedField(retry: Retry | undefined, projectId: string): Promise<FieldResult | null> {
    const recorded = await this.#recorded(retry, projectId);
    if (recorded === null) return null;
    // A task write's record names no field: its key was used for another kind of request.
    if (typeof recorded.fieldKey !== 'string') refuse('retry_conflict');
    const field = (await this.#field(projectId, recorded.fieldKey)) ?? refuse('not_found');
    return { field, replayed: true };
  }

  async defineField(
    projectId: string,
    input: DefineFieldInput,
    actorInput: Actor,
    retryInput?: Retry,
  ): Promise<FieldResult> {
    const actor = check.actor(actorInput);
    const retry = check.retry(retryInput);
    const definition = check.fieldDefinition(input);
    await this.#projectOf(projectId);
    const replayed = await this.#recordedField(retry, projectId);
    if (replayed !== null) return replayed;
    const at = this.#now();
    try {
      await this.#db.batch([
        // The limit is checked in the batch, so two defines at once cannot pass it together; the
        // guard reports a field the limit kept out as not_found, which the catch below reads as the limit.
        this.#db
          .prepare(
            `INSERT INTO custom_fields (project_id, key, name, type, options, created_at, created_by)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
             WHERE (SELECT count(*) FROM custom_fields WHERE project_id = ?1) < ?8`,
          )
          .bind(
            projectId,
            definition.key,
            definition.name,
            definition.type,
            definition.options === null ? null : JSON.stringify(definition.options),
            at,
            actor.name,
            TASK_LIMITS.fields,
          ),
        this.#db.prepare("INSERT INTO write_guard (ok, refusal) VALUES (changes() = 1, 'not_found')"),
        ...this.#receipt(retry, projectId, { fieldKey: definition.key }, at),
      ]);
    } catch (error) {
      const message = messageOf(error);
      const replay = await this.#recordedField(retry, projectId);
      if (replay !== null) return replay;
      if (message.includes('UNIQUE constraint failed: custom_fields'))
        refuse('invalid', `the project already has a field ${definition.key}; a key names one field, retired or not`);
      if (guardRefusalOf(message) === 'not_found')
        refuse('invalid', `a project defines at most ${TASK_LIMITS.fields} fields, retired ones included`);
      failureOf(error);
      refuse('retry_conflict');
    }
    return { field: (await this.#field(projectId, definition.key)) ?? refuse('not_found'), replayed: false };
  }

  async retireField(projectId: string, key: string, actorInput: Actor, retryInput?: Retry): Promise<FieldResult> {
    const actor = check.actor(actorInput);
    const retry = check.retry(retryInput);
    if (!check.isFieldKey(key)) check.invalid('key must be a field key, such as severity');
    await this.#projectOf(projectId);
    const replayed = await this.#recordedField(retry, projectId);
    if (replayed !== null) return replayed;
    const at = this.#now();
    try {
      await this.#db.batch([
        this.#db
          .prepare(
            `INSERT INTO write_guard (ok, refusal) SELECT EXISTS (
               SELECT 1 FROM custom_fields WHERE project_id = ?1 AND key = ?2
             ), 'not_found'`,
          )
          .bind(projectId, key),
        // Retiring a retired field changes nothing; its key is still recorded for a retry.
        this.#db
          .prepare(
            `UPDATE custom_fields SET retired_at = ?3, retired_by = ?4
             WHERE project_id = ?1 AND key = ?2 AND retired_at IS NULL`,
          )
          .bind(projectId, key, at, actor.name),
        ...this.#receipt(retry, projectId, { fieldKey: key }, at),
      ]);
    } catch (error) {
      const replay = await this.#recordedField(retry, projectId);
      if (replay !== null) return replay;
      if (guardRefusalOf(messageOf(error)) === 'not_found') refuse('not_found', `The project has no field ${key}.`);
      failureOf(error);
      refuse('retry_conflict');
    }
    return { field: (await this.#field(projectId, key)) ?? refuse('not_found'), replayed: false };
  }

  async addComment(
    projectId: string,
    taskId: string,
    textInput: string,
    actorInput: Actor,
    retryInput?: Retry,
    pinsInput?: CommentPins,
  ): Promise<CommentResult> {
    const actor = check.actor(actorInput);
    const retry = check.retry(retryInput);
    const text = check.text(textInput, 'comment', 4096, true);
    const pins = check.pins(pinsInput);
    const [row] = await this.#reads.taskRows(projectId, [taskId]);
    if (row === undefined) refuse('not_found');
    const replayComment = async (): Promise<CommentResult | null> => {
      const recorded = await this.#recorded(retry, projectId);
      if (recorded === null) return null;
      const comment = (await this.#reads.listComments(projectId, taskId)).find(
        (candidate) => candidate.id === recorded.commentId,
      );
      return comment === undefined ? refuse('not_found') : { comment, replayed: true };
    };
    const replayed = await replayComment();
    if (replayed !== null) return replayed;
    await this.#canUnpin(taskId, pins);
    const id = crypto.randomUUID();
    const at = this.#now();
    try {
      await this.#db.batch([
        ...this.#staleReceipt(retry),
        // A write may land between the read above and this batch: the event records the version then.
        ...this.#comment({ id: taskId, projectId: row.project_id }, null, id, text, pins, actor, at),
        ...this.#receipt(retry, projectId, { commentId: id }, at, [taskId]),
      ]);
    } catch (error) {
      failureOf(error);
      return (await replayComment()) ?? refuse('retry_conflict');
    }
    return {
      comment: { id, taskId, author: actor.name, text, createdAt: at, pinned: pins?.pin === true },
      replayed: false,
    };
  }
}
