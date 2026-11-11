// Every write the engine makes. Each is one batch, which commits whole or not
// at all; the write guard (src/store/migrations/0001_task_store.sql) rolls a
// batch back when its versioned update matched no row or a link would close a
// loop.
import {
  closedByNtasks,
  epicChange,
  epicCloseReason,
  guardRefusalOf,
  KEEP_OPEN,
  NTASKS_ACTOR,
  ICON_SCHEMES,
  PROJECT_ICON_MAX_BYTES,
  PROJECT_ICON_TYPES,
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
  type EpicCause,
  type ExternalLink,
  type FieldResult,
  type FieldValue,
  type Json,
  type MovedId,
  type MoveResult,
  type JsonObject,
  type Project,
  type ProjectChange,
  type IconScheme,
  type RepositoryResult,
  type ProjectIcon,
  type Retry,
  type Task,
  type TaskDelivery,
  type TaskComment,
  type TaskEventKind,
  type TaskPlacement,
  type TaskRefusal,
  type TaskResolution,
  type TaskStatus,
  type TaskStep,
  type TaskTestResult,
  type TaskWork,
  type TaskWrite,
  type WriteResult,
} from '@ntasks/domain';
import { githubPullOf } from '../delivery.ts';
import type { Bindable, Database, Statement } from './database.ts';
import type { Reads } from './reads.ts';
import { deliveryOf, DROPPED, toField, toTask, type FieldRow, type StoredTaskRow } from './rows.ts';
import * as check from './validate.ts';

/** The helper agent and the agent session a change was made through, as its history event records them. */
interface Through {
  readonly actorFor: string | null;
  readonly session: string | null;
}
const THROUGH_NONE: Through = Object.freeze({ actorFor: null, session: null });

/** What a change by `actor` to `task` was made through: the task's helper and session when `actor` holds it. */
function heldThrough(actor: Actor, task: Pick<Task, 'assignee' | 'assigneeFor' | 'work'>): Through {
  return task.assignee === actor.name
    ? { actorFor: task.assigneeFor, session: task.work.session ?? null }
    : THROUGH_NONE;
}

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

/** How long the store keeps a push's commits, for a task closed with one of them after the push. */
export const PUSH_KEPT_MS = 86_400_000;

/** The push that brought a commit onto a repository's default branch: the repository, the push's newest commit and its time. */
interface PushedCommit {
  readonly repository: string;
  readonly head: string;
  readonly pushedAt: string;
  /** A merge in the repository is the change going live, so the push shipped it. */
  readonly mergesLive: boolean;
}

/** Where a task closed with a commit starts: at built, or where the push that brought its commit in left it. */
function pushedStage(pushed: PushedCommit | null): DeliveryStage {
  if (pushed === null) return 'built';
  return pushed.mergesLive ? 'live' : 'merged';
}

/** The most open tasks one drop links to for naming it, which bounds the close's write. */
export const NAMED_LINKS = 20;

/**
 * Whether a write beside another task's only comments on it, which leaves
 * that task's version, and so its dropped list, as they were (#prepare).
 */
function commentsOnly(write: check.CheckedWrite): boolean {
  return (
    write.comment !== null &&
    Object.keys(write.set).length === 0 &&
    write.close === null &&
    !write.reopen &&
    write.metadata === null &&
    // Field values that change nothing leave the version too; an empty set of them is the one case read here.
    (write.setFields === null || Object.keys(write.setFields).length === 0) &&
    write.requestApproval === null &&
    write.requestAction === null &&
    write.addLabels.length === 0 &&
    write.removeLabels.length === 0 &&
    write.addLinks.length === 0 &&
    write.removeLinks.length === 0 &&
    write.addExternalLinks.length === 0 &&
    write.removeExternalLinks.length === 0
  );
}

/**
 * Whether a text names this task id as a whole id: not inside a longer
 * word, and not as the start of a child's id, as `web-a1.2` starts with
 * `web-a1`. A sentence's full stop after it still names it.
 */
function namesTask(taskId: string): (text: string) => boolean {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const whole = new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'u');
  return (text) => whole.test(text);
}

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
  if (message.includes('UNIQUE constraint failed: tasks.id') || message.includes("a moved task's former id"))
    return 'id_taken';
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
  const { stage, commit, pullRequest, mergeCommit, repository, builtAt, mergedAt, liveAt } = delivery;
  return {
    stage,
    commit,
    pullRequest,
    mergeCommit,
    ...(repository === null ? {} : { repository }),
    builtAt,
    mergedAt,
    liveAt,
  };
}

/** The repository a task's change reached: the one its delivery records, or else the one its GitHub pull request is in. */
function repositoryOf(delivery: TaskDelivery): string | null {
  if (delivery.repository !== null) return delivery.repository;
  return delivery.pullRequest === null ? null : (githubPullOf(delivery.pullRequest)?.repository ?? null);
}

/** The order of the stages: a task moves only to a later one. */
const STAGE_ORDER: Readonly<Record<DeliveryStage, number>> = Object.freeze({ built: 0, merged: 1, live: 2 });

/** The columns that hold a task's delivery, which a reopen clears. */
const DELIVERY_COLUMNS = [
  'delivery_stage',
  'delivery_commit',
  'delivery_pull_request',
  'delivery_merge_commit',
  'delivery_repository',
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
  UNION
  SELECT t.id FROM json_each(?4) w CROSS JOIN tasks t ON t.id = w.value
)
SELECT t.*, p.deploys AS deploys FROM matched CROSS JOIN tasks t ON t.id = matched.id JOIN projects p ON p.id = t.project_id
WHERE t.project_id IN (SELECT value FROM json_each(?1)) AND t.delivery_stage IN ('built', 'merged')
ORDER BY t.id`;

/**
 * The tasks at merged whose change reached repository ?1: the one their
 * delivery records, or else the one their pull request ?2 starts with.
 */
const MERGED_IN_REPOSITORY = `SELECT * FROM tasks
WHERE delivery_stage = 'merged'
  AND (delivery_repository = ?1 OR (delivery_repository IS NULL AND substr(lower(delivery_pull_request), 1, length(?2)) = ?2))
ORDER BY id`;

/** The most times one write checks an epic as it climbs from the tasks it changes, so a parent chain that loops, as an import could leave, still ends. */
const EPIC_CHECKS = 8;

/** A task as a write leaves it, as far as the epic above it reads it. */
interface Placed {
  readonly parentId: string | null;
  readonly closed: boolean;
  readonly resolution: TaskResolution | null;
}

/** A task a write changes or files: where it stood, null for a new task, and where the write leaves it. */
interface Moved extends Placed {
  readonly id: string;
  /** The id it had before the write, when a move gave it a new one. */
  readonly formerId?: string;
  readonly before: { readonly parentId: string | null; readonly closed: boolean } | null;
  /** Closed before and closed by this write too: a close that replaces Ntasks's own close of an epic. */
  readonly closedAgain?: boolean;
}

/** Whether `write` takes the keep-open label off `current`, an epic it leaves open. */
function unkeptBy(current: Task, write: check.CheckedWrite): boolean {
  return (
    (write.set.type ?? current.type) === 'epic' &&
    current.labels.includes(KEEP_OPEN) &&
    write.removeLabels.includes(KEEP_OPEN) &&
    !write.addLabels.includes(KEEP_OPEN) &&
    !movedBy(current, write).closed
  );
}

/** Where `write` leaves `current`. */
function movedBy(current: Task, write: check.CheckedWrite): Moved {
  const wasClosed = current.status === 'closed';
  const closed = write.close !== null || (wasClosed && !write.reopen);
  return {
    id: current.id,
    before: { parentId: current.parentId, closed: wasClosed },
    parentId: write.set.parentId !== undefined ? write.set.parentId : current.parentId,
    closed,
    resolution: write.close !== null ? write.close.resolution : closed ? (current.close?.resolution ?? null) : null,
    closedAgain: wasClosed && write.close !== null,
  };
}

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
 * names a commit or a pull request, or at merged when `pushed` names the push
 * that brought its commit onto a default branch. The columns, and the values
 * its created event records.
 */
function filedState(fields: check.CreateFields, actor: Actor, at: string, pushed: PushedCommit | null) {
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
      const liveAt = pushed?.mergesLive === true ? pushed.pushedAt : null;
      Object.assign(columns, {
        delivery_stage: pushedStage(pushed),
        delivery_commit: close.commit,
        delivery_pull_request: close.pullRequest,
        built_at: at,
        ...(pushed === null
          ? {}
          : {
              delivery_merge_commit: pushed.head,
              delivery_repository: pushed.repository,
              merged_at: pushed.pushedAt,
              live_at: liveAt,
            }),
      });
      delivery = deliveryJson({
        stage: pushedStage(pushed),
        commit: close.commit,
        pullRequest: close.pullRequest,
        mergeCommit: pushed?.head ?? null,
        repository: pushed?.repository ?? null,
        builtAt: at,
        mergedAt: pushed?.pushedAt ?? null,
        liveAt,
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
    through: Through = THROUGH_NONE,
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
      actor_for: through.actorFor,
      session: through.session,
    });
  }

  /**
   * The statements that add comment `id` to `task` with its history event,
   * pinned or not as `pins` says, and unpin the comments `pins` names. The
   * event records both, so the task's history says who pinned and unpinned
   * what, and when. The task's version stays as it is: the event records
   * `version` and `through`, or with null the version the task stands at
   * when the batch runs and, for a comment by its holder, the task's helper
   * and session then.
   */
  #comment(
    task: { id: string; projectId: string },
    version: number | null,
    id: string,
    text: string,
    pins: check.CheckedPins | null,
    test: TaskTestResult | null,
    actor: Actor,
    at: string,
    through: Through = THROUGH_NONE,
  ): Statement[] {
    const unpin = pins?.unpin ?? [];
    const changes: JsonObject = {
      commentId: id,
      text,
      ...(pins?.pin === true ? { pinned: true } : {}),
      ...(unpin.length > 0 ? { unpinned: [...unpin] } : {}),
      ...(test === null ? {} : { test: { ...test } }),
    };
    const event =
      version === null
        ? this.#db
            .prepare(
              `INSERT INTO task_events (task_id, project_id, version, kind, actor, model, at, changes, actor_for, session)
               SELECT id, project_id, version, 'commented', ?2, ?3, ?4, ?5,
                 CASE WHEN assignee = ?2 THEN assignee_for END,
                 CASE WHEN assignee = ?2 THEN json_extract(work, '$.session') END
               FROM tasks WHERE id = ?1`,
            )
            .bind(task.id, actor.name, actor.model ?? null, at, JSON.stringify(changes))
        : this.#event(task, version, 'commented', actor, at, changes, through);
    return [
      this.#insert('task_comments', {
        id,
        task_id: task.id,
        author: actor.name,
        text,
        created_at: at,
        pinned: pins?.pin === true ? 1 : 0,
        test: test === null ? null : JSON.stringify(test),
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
    { reason, title: given, pullRequest }: check.CheckedApproval,
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
    const pull = pullRequest === null ? null : githubPullOf(pullRequest);
    const link: ExternalLink | null =
      pullRequest === null
        ? null
        : {
            url: pullRequest,
            title: pull === null ? 'Pull request' : `${pull.repository}#${pull.number}`,
            kind: 'pull-request',
          };
    return this.#request(
      gateId,
      taskId,
      projectId,
      priority,
      { title, description: reason, steps: null, link },
      actor,
      at,
    );
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
    return this.#request(
      gateId,
      taskId,
      projectId,
      priority,
      { title, description: context, steps, link: null },
      actor,
      at,
    );
  }

  /** A new request to a person: the gate task, its created event, its link
   * to the pull request an approval gates, and the link by which `taskId`
   * waits on it. With steps, it asks them to do the steps; without, to
   * approve its description. */
  #request(
    gateId: string,
    taskId: string,
    projectId: string,
    priority: number,
    ask: {
      readonly title: string;
      readonly description: string;
      readonly steps: readonly TaskStep[] | null;
      readonly link: ExternalLink | null;
    },
    actor: Actor,
    at: string,
  ): Statement[] {
    const { title, description: reason, steps, link } = ask;
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
        externalLinks: link === null ? [] : externalList(new Map([[link.url, link]])),
        fields: {},
        close: null,
        ...(steps === null ? {} : { steps: steps as unknown as Json }),
        filedBy: actor.name,
        filedModel: actor.model ?? null,
      }),
      ...(link === null ? [] : [this.#externalLink(gateId, link, actor, at)]),
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
   * answers nothing, so the write runs again (#staleReceipt clears it). A
   * record kept in another project answers when the task it wrote has moved
   * to this one, and with a null project wherever it was kept.
   */
  async #recorded(retry: Retry | undefined, projectId: string | null): Promise<Record<string, Json> | null> {
    if (retry === undefined) return null;
    const row = await this.#db
      .prepare(
        `SELECT project_id, request_hash, result, ${STALE('?5')} AS stale FROM write_receipts
         WHERE principal = ?1 AND operation = ?2 AND idempotency_key = ?3 AND created_at >= ?4`,
      )
      .bind(retry.principal, retry.operation, retry.key, this.#cutoff(), this.#cutoff(DERIVED_NEW_TASK_HOURS))
      .first<{ project_id: string; request_hash: string; result: string; stale: number }>();
    if (row === null) return null;
    if (row.request_hash !== retry.requestHash) refuse('retry_conflict');
    const recorded = JSON.parse(row.result) as Record<string, Json>;
    if (projectId !== null && row.project_id !== projectId) {
      const [moved] = typeof recorded.taskId === 'string' ? await this.#tasksNow([recorded.taskId]) : [];
      if (moved?.projectId !== projectId) refuse('retry_conflict');
    }
    if (retry.derived === true && row.stale) return null;
    return recorded;
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
    epics: readonly string[] = [],
  ): Promise<WriteResult> {
    const tasks = (await this.#reads.taskRows(projectId, [taskId, ...created, ...epics])).map(toTask);
    const found = (id: string) => tasks.find((candidate) => candidate.id === id) ?? refuse('not_found');
    return {
      task: found(taskId),
      created: created.map(found),
      ...(epics.length === 0 ? {} : { epics: epics.map(found) }),
      replayed,
    };
  }

  /** A recorded write's answer as it stands now, with the comment it added, if any; a task it wrote that moved since is read where it is now. */
  async #recordedResult(recorded: Record<string, Json>, taskId: string): Promise<WriteResult> {
    const epics = Array.isArray(recorded.epics) ? (recorded.epics as string[]) : [];
    const created = recorded.created as string[];
    const tasks = await this.#tasksNow([taskId, ...created, ...epics]);
    const byId = new Map([taskId, ...created, ...epics].map((id, index) => [id, tasks[index]]));
    const found = (id: string) => byId.get(id) ?? refuse('not_found');
    const task = found(taskId);
    const result: WriteResult = {
      task,
      created: created.map(found),
      ...(epics.length === 0 ? {} : { epics: epics.map(found) }),
      replayed: true,
    };
    if (typeof recorded.commentId !== 'string') return result;
    const comment = (await this.#reads.listComments(task.projectId, task.id)).find(
      (candidate) => candidate.id === recorded.commentId,
    );
    return comment === undefined ? result : { ...result, comment };
  }

  async #replay(retry: Retry | undefined, projectId: string): Promise<WriteResult | null> {
    const recorded = await this.#recorded(retry, projectId);
    if (recorded === null) return null;
    return this.#recordedResult(recorded, recorded.taskId as string);
  }

  async recordedWrite(projectId: string, retryInput: Retry): Promise<WriteResult | null> {
    const retry = check.retry(retryInput) ?? check.invalid('a retry identity is required');
    const recorded = await this.#recorded(retry, projectId);
    if (recorded === null) return null;
    // A comment's record names no task: its key was used for another kind of request.
    if (typeof recorded.taskId !== 'string') refuse('retry_conflict');
    return this.#recordedResult(recorded, recorded.taskId);
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
    return `${parentId}.${await this.#childNumber(parentId)}`;
  }

  /** One more than the highest child number the parent's children, or their former ids, use. */
  async #childNumber(parentId: string): Promise<number> {
    const row = await this.#db
      // The pattern is one bound value, so SQLite reaches it through the primary key's index.
      .prepare(
        // A child number a moved child left behind stays its former id, so it is never given again.
        `SELECT coalesce(max(CAST(substr(id, length(?1) + 2) AS INTEGER)), 0) + 1 AS next FROM (
           SELECT id FROM tasks WHERE id GLOB ?2 UNION ALL SELECT alias FROM task_aliases WHERE alias GLOB ?2)`,
      )
      .bind(parentId, `${parentId}.[0-9]*`)
      .first<{ next: number }>();
    return row?.next ?? 1;
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

  /**
   * The statements that close or reopen, on their own, the epics a write
   * leaves with every task directly under them closed or with one open again
   * (epicChange), each recorded as Ntasks's change, climbing to the epic
   * each one is under; and the ids of those epics, deepest first. An epic
   * the write changes itself is among them only when the write takes its
   * keep-open label off (`unkept`): otherwise whoever writes an epic decides
   * it. The statements go after the write's own, in its batch, and fail it
   * with version_conflict when the tasks under an epic changed since they
   * were read, so the caller decides again.
   */
  async #epicsAfter(
    moved: readonly Moved[],
    at: string,
    unkept: readonly string[] = [],
    commented: ReadonlySet<string> = new Set(),
  ): Promise<{ readonly statements: Statement[]; readonly epics: string[] }> {
    const formerIds = moved.flatMap((task) => (task.formerId === undefined ? [] : [task.formerId]));
    // A task this write moves to another project is read by its old id, and the batch gives it its new one.
    const renamed = new Map(moved.flatMap((task) => (task.formerId === undefined ? [] : [[task.formerId, task.id]])));
    const written = new Set([...moved.map((task) => task.id), ...formerIds]);
    const left = new Map<string, Placed>(moved.map((task) => [task.id, task]));
    // Each epic waits in the queue at most once, with the first cause that reached it.
    const queue = new Map<string, EpicCause>(unkept.map((epicId) => [epicId, { kind: 'unkept' }]));
    const visit = (epicId: string | null, cause: EpicCause) => {
      if (epicId !== null && !written.has(epicId) && !queue.has(epicId)) queue.set(epicId, cause);
    };
    for (const task of moved) {
      const { before } = task;
      const movedOut = before !== null && before.parentId !== task.parentId;
      if (before !== null && !movedOut && before.closed === task.closed && task.closedAgain !== true) continue;
      if (movedOut) visit(before.parentId, { kind: 'moved-out', child: task.id });
      // A task already closed that moves in closes nothing itself; it only completes the epic.
      const kind = movedOut && before.closed && task.closed ? 'moved-in' : 'closed';
      visit(task.parentId, { kind, child: task.id });
    }
    const checks = new Map<string, number>();
    type EpicRow = {
      readonly project_id: string;
      readonly status: TaskStatus;
      readonly parent_id: string | null;
      readonly closed_by: string | null;
      readonly assignee_for: string | null;
      readonly work: string;
      readonly kept: number;
    };
    const read = new Map<string, EpicRow | null>();
    const decided = new Map<string, Placed & { readonly reason: string | null }>();
    // One per epic, from its last check, which saw every change this write makes under it.
    const guards = new Map<string, Statement>();
    for (const [epicId, cause] of queue) {
      queue.delete(epicId);
      const count = (checks.get(epicId) ?? 0) + 1;
      checks.set(epicId, count);
      if (count > EPIC_CHECKS) continue;
      if (!read.has(epicId)) {
        read.set(
          epicId,
          await this.#db
            .prepare(
              // A move leaves an epic of another project; any other write's epics are in its project.
              `SELECT project_id, status, parent_id, closed_by, assignee_for, work,
                 EXISTS (SELECT 1 FROM task_labels WHERE task_id = ?1 AND label = ?2) AS kept
               FROM tasks WHERE id = ?1 AND type = 'epic'`,
            )
            .bind(epicId, KEEP_OPEN)
            .first<EpicRow>(),
        );
      }
      const epic = read.get(epicId);
      if (epic === null || epic === undefined) continue;
      const excluded = JSON.stringify([...left.keys(), ...formerIds]);
      const { results } = await this.#db
        .prepare(
          `SELECT status, resolution FROM tasks INDEXED BY tasks_by_parent
           WHERE parent_id = ?1 AND id NOT IN (SELECT value FROM json_each(?2))`,
        )
        .bind(epicId, excluded)
        .all<{ status: TaskStatus; resolution: TaskResolution | null }>();
      const kept = cause.kind !== 'unkept' && epic.kept === 1;
      // At the batch, the tasks under the epic that this write does not change, how they closed, and its label must be as read.
      guards.set(
        epicId,
        this.#db
          .prepare(
            `INSERT INTO write_guard (ok, refusal)
             SELECT count(*) = ?3 AND coalesce(sum(status <> 'closed'), 0) = ?4
               AND coalesce(sum(status = 'closed' AND resolution NOT IN ('wont-do', 'no-longer-needed')), 0) = ?7
               AND EXISTS (SELECT 1 FROM task_labels WHERE task_id = ?1 AND label = ?5) = ?6, 'version_conflict'
             FROM tasks INDEXED BY tasks_by_parent WHERE parent_id = ?1 AND id NOT IN (SELECT value FROM json_each(?2))`,
          )
          .bind(
            epicId,
            excluded,
            results.length,
            results.filter((row) => row.status !== 'closed').length,
            KEEP_OPEN,
            kept ? 1 : 0,
            results.filter(
              (row) => row.status === 'closed' && row.resolution !== 'wont-do' && row.resolution !== 'no-longer-needed',
            ).length,
          ),
      );
      const children = [
        ...results.map((row) => ({ closed: row.status === 'closed', resolution: row.resolution })),
        ...[...left.values()].filter((task) => task.parentId === epicId),
      ];
      const standing = decided.get(epicId);
      const change = epicChange(
        {
          type: 'epic',
          status: standing === undefined ? epic.status : standing.closed ? 'closed' : 'open',
          labels: kept ? [KEEP_OPEN] : [],
          closedBy: standing === undefined ? epic.closed_by : standing.closed ? NTASKS_ACTOR : null,
        },
        children,
      );
      if (change === null) continue;
      const placed = {
        parentId: epic.parent_id,
        closed: change !== 'reopen',
        resolution: change === 'reopen' ? null : change.close,
        reason: change === 'reopen' ? null : epicCloseReason(cause),
      };
      decided.set(epicId, placed);
      left.set(epicId, placed);
      visit(epic.parent_id, { kind: 'closed', child: epicId });
    }
    const statements: Statement[] = [...guards.values()];
    const epics: string[] = [];
    // An epic this batch closes, such as a child epic closing with its parent, is no open task to link to.
    // A task the write only comments on stays as it was, so it can still take a link.
    const unlinked = new Set([
      ...[...written].filter((id) => !commented.has(id)),
      ...[...decided].flatMap(([id, placed]) => (placed.closed ? [id] : [])),
    ]);
    for (const [epicId, placed] of decided) {
      const epic = read.get(epicId)!;
      // An epic closed and opened again in one write is left as it was.
      if (placed.closed === (epic.status === 'closed')) continue;
      epics.push(epicId);
      const actor: Actor = { name: NTASKS_ACTOR };
      if (placed.closed) {
        const work = JSON.parse(epic.work) as Record<string, unknown>;
        // An epic this write also changes is left without them: its links may change in the same batch.
        const named =
          placed.resolution !== null && DROPPED.includes(placed.resolution) && !written.has(epicId)
            ? await this.#namedLinksOf(epicId, actor, at, renamed, unlinked)
            : { statements: [], links: null };
        statements.push(
          this.#db
            .prepare(
              `UPDATE tasks SET status = 'closed', closed_at = ?1, close_reason = ?2, resolution = ?3,
                 duplicate_of = NULL, closed_by = ?4, closed_model = NULL, close_link = NULL, close_acceptance = NULL, close_test = NULL,
                 assignee_for = NULL, work = '{}', version = version + 1, updated_at = ?1
               WHERE id = ?5 AND project_id = ?6 AND status <> 'closed'`,
            )
            .bind(at, placed.reason, placed.resolution, NTASKS_ACTOR, epicId, epic.project_id),
          this.#db.prepare("INSERT INTO write_guard (ok, refusal) VALUES (changes() = 1, 'version_conflict')"),
          this.#eventAtVersion(epicId, 'closed', actor, at, {
            status: 'closed',
            close: {
              at,
              reason: placed.reason,
              resolution: placed.resolution,
              duplicateOf: null,
              by: NTASKS_ACTOR,
              model: null,
              link: null,
              acceptance: null,
            },
            // An epic the write changes may have taken a helper or work details in it, so both are recorded cleared.
            ...(epic.assignee_for === null && !written.has(epicId) ? {} : { assigneeFor: null }),
            ...(Object.keys(work).length === 0 && !written.has(epicId) ? {} : { work: {} }),
            ...(named.links === null ? {} : { dependencies: named.links }),
          }),
          ...named.statements,
        );
      } else {
        statements.push(
          this.#db
            .prepare(
              `UPDATE tasks SET status = 'open', closed_at = NULL, close_reason = NULL, resolution = NULL,
                 duplicate_of = NULL, closed_by = NULL, closed_model = NULL, close_link = NULL, close_acceptance = NULL, close_test = NULL,
                 ${DELIVERY_COLUMNS.map((column) => `${column} = NULL`).join(', ')},
                 version = version + 1, updated_at = ?1
               WHERE id = ?2 AND project_id = ?3 AND status = 'closed' AND closed_by = ?4`,
            )
            .bind(at, epicId, epic.project_id, NTASKS_ACTOR),
          this.#db.prepare("INSERT INTO write_guard (ok, refusal) VALUES (changes() = 1, 'version_conflict')"),
          this.#eventAtVersion(epicId, 'reopened', actor, at, { status: 'open', close: null }),
        );
      }
    }
    return { statements, epics };
  }

  /** A history event of `taskId` at the version the batch leaves it at when the statement runs. */
  #eventAtVersion(taskId: string, kind: TaskEventKind, actor: Actor, at: string, changes: JsonObject): Statement {
    return this.#db
      .prepare(
        `INSERT INTO task_events (task_id, project_id, version, kind, actor, model, at, changes)
         SELECT id, project_id, version, ?2, ?3, ?4, ?5, ?6 FROM tasks WHERE id = ?1`,
      )
      .bind(taskId, kind, actor.name, actor.model ?? null, at, JSON.stringify(changes));
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

  async updateProject(projectId: string, change: ProjectChange): Promise<Project> {
    await this.#projectOf(projectId);
    const set = (column: string, value: Bindable) =>
      this.#db.prepare(`UPDATE projects SET ${column} = ?2 WHERE id = ?1`).bind(projectId, value);
    const statements: Statement[] = [];
    if (change.name !== undefined) {
      const name = check.text(change.name, 'name', 128, true).trim();
      if (/[\r\n]/u.test(name)) check.invalid('name must be one line');
      statements.push(set('name', name));
    }
    if (change.deploys !== undefined) {
      if (typeof change.deploys !== 'boolean') check.invalid('deploys must be true or false');
      statements.push(set('deploys', change.deploys ? 1 : 0));
    }
    if (change.disabled !== undefined) {
      if (typeof change.disabled !== 'boolean') check.invalid('disabled must be true or false');
      // Disabling a disabled project keeps the time it was first disabled.
      statements.push(
        this.#db
          .prepare('UPDATE projects SET disabled_at = CASE WHEN ?2 THEN coalesce(disabled_at, ?3) END WHERE id = ?1')
          .bind(projectId, change.disabled, this.#now()),
      );
    }
    if (change.website !== undefined) {
      const url = change.website === null ? null : check.httpUrl(change.website.url);
      if (change.website !== null && url === null) check.invalid('website must be an http or https URL');
      statements.push(set('website_url', url));
      // The icons belong to the website they were read from: a new website, or none, replaces them.
      statements.push(this.#db.prepare('DELETE FROM project_icons WHERE project_id = ?1').bind(projectId));
      for (const scheme of ICON_SCHEMES) {
        const icon = change.website?.icons[scheme] ?? null;
        if (icon !== null) statements.push(this.#iconInsert(projectId, scheme, icon));
      }
    }
    if (statements.length > 0) await this.#db.batch(statements);
    return this.#projectOf(projectId);
  }

  #iconInsert(projectId: string, scheme: IconScheme, icon: ProjectIcon): Statement {
    const sourceUrl = check.httpUrl(icon.sourceUrl) ?? check.invalid('icon.sourceUrl must be an http or https URL');
    if (!(PROJECT_ICON_TYPES as readonly string[]).includes(icon.contentType))
      check.invalid(`icon.contentType must be one of ${PROJECT_ICON_TYPES.join(', ')}`);
    if (
      !(icon.bytes instanceof ArrayBuffer) ||
      icon.bytes.byteLength === 0 ||
      icon.bytes.byteLength > PROJECT_ICON_MAX_BYTES
    )
      check.invalid(`icon.bytes must hold 1 to ${PROJECT_ICON_MAX_BYTES} bytes`);
    return this.#db
      .prepare(
        'INSERT INTO project_icons (project_id, scheme, source_url, content_type, bytes, read_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      )
      .bind(projectId, scheme, sourceUrl, icon.contentType, icon.bytes, this.#now());
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
    // Only a merge names its merge commit: the one it says brought the work in, or else its only commit.
    const mergeCommit =
      signal.stage !== 'merged'
        ? null
        : (signal.mergeCommit ?? (signal.commits.length === 1 ? signal.commits[0]! : null));
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const { results } = await this.#db
        .prepare(DELIVERY_CANDIDATES)
        .bind(
          JSON.stringify([...new Set(projectIdsInput)]),
          JSON.stringify(signal.pullRequests),
          JSON.stringify(signal.commits),
          JSON.stringify(signal.taskIds ?? []),
        )
        .all<StoredTaskRow & { readonly deploys: number }>();
      const at = this.#now();
      // The time the change reached the stage, as the sender knows it, but never later than now.
      const reached = signal.at !== undefined && signal.at < at ? signal.at : at;
      const statements: Statement[] = [];
      const moves: DeliveryMove[] = [];
      const turnedOn = new Set<string>();
      // A task it moves adds its repository to this list itself, by a trigger (store migration 0014).
      const repositories = results.length === 0 ? new Map<string, boolean>() : await this.#repositories();
      for (const row of results) {
        const current = deliveryOf(row);
        if (current === null) continue;
        // A deploy that started before the merge was a preview of the change, not the deploy that shipped it.
        // One in the same second counts: GitHub gives both times to the second, and a merge queue merges
        // only after its checks pass on its branch, so a preview there starts minutes before the merge.
        if (signal.mergedBy !== undefined && (current.mergedAt === null || current.mergedAt > signal.mergedBy))
          continue;
        const recorded = current.repository ?? signal.repository ?? null;
        const repository = repositoryOf({ ...current, repository: recorded });
        // A repository whose merges go live has no deploy: nothing waits between its merge and live.
        const mergesLive = repository !== null && repositories.get(repository) === true;
        const turnsOn = turnOn !== undefined && row.deploys !== 1 && !kept.has(row.project_id);
        if (turnsOn && !turnedOn.has(row.project_id)) {
          turnedOn.add(row.project_id);
          statements.push(
            this.#db.prepare('UPDATE projects SET deploys = 1 WHERE id = ?1 AND deploys = 0').bind(row.project_id),
          );
        }
        // A project that does not deploy has nothing after merged.
        const stage: DeliveryStage = mergesLive
          ? 'live'
          : signal.stage === 'live' && row.deploys !== 1 && !turnsOn
            ? 'merged'
            : signal.stage;
        if (STAGE_ORDER[stage] <= STAGE_ORDER[current.stage]) continue;
        const next: TaskDelivery = {
          ...current,
          stage,
          mergeCommit: current.mergeCommit ?? mergeCommit,
          repository: recorded,
          mergedAt: stage === 'merged' || signal.stage === 'merged' ? reached : current.mergedAt,
          liveAt: stage === 'live' ? reached : null,
        };
        statements.push(...this.#delivered(row, next, actor, at));
        moves.push({ taskId: row.id, projectId: row.project_id, stage });
      }
      statements.push(...this.#pushed(signal, reached, at));
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

  /** Each repository whose changes moved a task, and whether its merges go live. */
  async #repositories(): Promise<Map<string, boolean>> {
    const { results } = await this.#db
      .prepare('SELECT name, merges_live FROM repositories')
      .all<{ readonly name: string; readonly merges_live: number }>();
    return new Map(results.map((row) => [row.name, row.merges_live === 1]));
  }

  /** The statements that move `row`'s delivery to `next`: the versioned update, its guard and its history event. */
  #delivered(row: StoredTaskRow, next: TaskDelivery, actor: Actor, at: string): Statement[] {
    return [
      this.#db
        .prepare(
          `UPDATE tasks SET delivery_stage = ?1, delivery_merge_commit = ?2, merged_at = ?3, live_at = ?4,
             delivery_repository = ?8, version = version + 1, updated_at = ?5
           WHERE id = ?6 AND version = ?7`,
        )
        .bind(next.stage, next.mergeCommit, next.mergedAt, next.liveAt, at, row.id, row.version, next.repository),
      this.#db.prepare("INSERT INTO write_guard (ok, refusal) VALUES (changes() = 1, 'version_conflict')"),
      this.#event({ id: row.id, projectId: row.project_id }, row.version + 1, 'updated', actor, at, {
        delivery: deliveryJson(next),
      }),
    ];
  }

  async setRepository(nameInput: string, mergesLive: boolean, actorInput: Actor): Promise<RepositoryResult> {
    const actor = check.actor(actorInput);
    const name = check.repositoryName(nameInput);
    if (typeof mergesLive !== 'boolean') check.invalid('mergesLive must be true or false');
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const known = await this.#db.prepare('SELECT 1 FROM repositories WHERE name = ?1').bind(name).first();
      if (known === null) refuse('not_found', `No change in ${name} moved a task here.`);
      const at = this.#now();
      const statements: Statement[] = [
        this.#db.prepare('UPDATE repositories SET merges_live = ?2 WHERE name = ?1').bind(name, mergesLive ? 1 : 0),
      ];
      const moves: DeliveryMove[] = [];
      if (mergesLive) {
        const { results } = await this.#db
          .prepare(MERGED_IN_REPOSITORY)
          .bind(name, `https://github.com/${name}/pull/`)
          .all<StoredTaskRow>();
        for (const row of results) {
          const current = deliveryOf(row);
          if (current?.stage !== 'merged' || repositoryOf(current) !== name) continue;
          // It went live when it merged: the repository has no deploy.
          statements.push(
            ...this.#delivered(row, { ...current, stage: 'live', liveAt: current.mergedAt ?? at }, actor, at),
          );
          moves.push({ taskId: row.id, projectId: row.project_id, stage: 'live' });
        }
      }
      try {
        await this.#db.batch(statements);
        return { repository: { name, mergesLive }, moved: moves };
      } catch (error) {
        // Another write changed a task this moves: read the tasks again and decide again.
        if (guardRefusalOf(messageOf(error)) === 'version_conflict') continue;
        throw error;
      }
    }
    refuse('version_conflict', `The tasks of ${name} kept changing; turn it on again.`);
  }

  /**
   * A push's commits, kept for PUSH_KEPT_MS with its newest commit and its
   * time, and the commits older than that removed; nothing for any other
   * signal. Only a push names its merge commit apart from its commits
   * (src/github.ts), and every signal names its repository.
   */
  #pushed(signal: DeliverySignal, pushedAt: string, at: string): Statement[] {
    if (signal.stage !== 'merged' || signal.mergeCommit === undefined || signal.repository === undefined) return [];
    const since = new Date(Date.parse(at) - PUSH_KEPT_MS).toISOString();
    return [
      this.#db.prepare('DELETE FROM pushed_commits WHERE pushed_at < ?1').bind(since),
      this.#db
        .prepare(
          `INSERT INTO pushed_commits (commit_sha, repository, head, pushed_at)
           SELECT value, ?2, ?3, ?4 FROM json_each(?1) WHERE true
           ON CONFLICT (commit_sha, repository) DO NOTHING`,
        )
        .bind(JSON.stringify(signal.commits), signal.repository, signal.mergeCommit, pushedAt),
    ];
  }

  /**
   * The push that brought this commit onto a default branch within
   * PUSH_KEPT_MS, the first one when several did; null when none did. Two
   * commits match when one starts with the other, as a signal matches them.
   */
  async #pushOf(commit: string, at: string): Promise<PushedCommit | null> {
    const since = new Date(Date.parse(at) - PUSH_KEPT_MS).toISOString();
    const row = await this.#db
      .prepare(
        `SELECT c.repository, c.head, c.pushed_at, coalesce(r.merges_live, 0) AS merges_live
         FROM pushed_commits c LEFT JOIN repositories r ON r.name = c.repository
         WHERE c.commit_sha >= substr(?1, 1, 7) AND c.commit_sha < substr(?1, 1, 7) || 'g'
           AND (substr(?1, 1, length(c.commit_sha)) = c.commit_sha OR substr(c.commit_sha, 1, length(?1)) = ?1)
           AND c.pushed_at >= ?2
         ORDER BY c.pushed_at LIMIT 1`,
      )
      .bind(commit, since)
      .first<{ repository: string; head: string; pushed_at: string; merges_live: number }>();
    return row === null
      ? null
      : { repository: row.repository, head: row.head, pushedAt: row.pushed_at, mergesLive: row.merges_live === 1 };
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
      const close = fields.close;
      const pushed =
        close !== null && close.commit !== null && close.pullRequest === null
          ? await this.#pushOf(close.commit, at)
          : null;
      const filed = filedState(fields, actor, at, pushed);
      const placed: Moved = {
        id,
        before: null,
        parentId: fields.parentId,
        closed: filed.close !== null,
        resolution: filed.close === null ? null : 'done',
      };
      const epicsAfter = fields.parentId === null ? null : await this.#epicsAfter([placed], at);
      const epics = epicsAfter?.epics ?? [];
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
          this.#event(
            other,
            other.version + 1,
            'updated',
            actor,
            at,
            { dependencies: linkList(otherLinks) },
            heldThrough(actor, other),
          ),
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
        ...(epicsAfter?.statements ?? []),
        ...this.#receipt(
          retry,
          projectId,
          { taskId: id, created, ...(epics.length === 0 ? {} : { epics }) },
          at,
          [id, ...created],
          true,
        ),
      );
      try {
        await this.#db.batch(statements);
        return await this.#result(projectId, id, created, false, epics);
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
    // A task this write changes takes no named link: the change clears its dropped list anyway. A comment changes nothing.
    const written = new Set([
      taskId,
      ...write.others.flatMap((other) => (commentsOnly(other.write) ? [] : [other.taskId])),
    ]);
    const change = await this.#prepare(projectId, toTask(row), write, actor, at, false, commentId, written);
    const moved = [movedBy(toTask(row), write)];
    const unkept = unkeptBy(toTask(row), write) ? [taskId] : [];
    const others = await Promise.all(
      write.others.map(async (other) => {
        const found = rows.find((candidate) => candidate.id === other.taskId);
        if (found === undefined) refuse('not_found', `There is no task ${other.taskId}.`);
        if (found.version !== other.write.expectedVersion) refuse('version_conflict');
        const otherComment = other.write.comment === null ? null : crypto.randomUUID();
        moved.push(movedBy(toTask(found), other.write));
        if (unkeptBy(toTask(found), other.write)) unkept.push(other.taskId);
        return this.#prepare(projectId, toTask(found), other.write, actor, at, true, otherComment, written);
      }),
    );
    const commented = new Set(write.others.flatMap((other) => (commentsOnly(other.write) ? [other.taskId] : [])));
    const { statements: settled, epics } = await this.#epicsAfter(moved, at, unkept, commented);

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const opens = write.requestApproval !== null || write.requestAction !== null;
      const gateId = opens ? `${project.prefix}-${this.#newKey()}` : null;
      const recorded = {
        taskId,
        created: gateId === null ? [] : [gateId],
        ...(commentId === null ? {} : { commentId }),
        ...(epics.length === 0 ? {} : { epics }),
      };
      const statements: Statement[] = [
        ...this.#staleReceipt(retry),
        ...change(gateId),
        ...others.flatMap((other) => other(null)),
        ...settled,
        ...this.#receipt(retry, projectId, recorded, at, [
          taskId,
          ...recorded.created,
          ...write.others.map((other) => other.taskId),
        ]),
      ];
      try {
        await this.#db.batch(statements);
        const result = await this.#result(projectId, taskId, recorded.created, false, epics);
        if (commentId === null || write.comment === null) return result;
        const comment: TaskComment = {
          id: commentId,
          taskId,
          author: actor.name,
          text: write.comment,
          createdAt: at,
          pinned: write.pins?.pin === true,
          test: write.test,
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

  /** The task with each of these ids, or the id it moved to, read in the project it is in now: one entry for each id, undefined for an id that names no task. */
  async #tasksNow(taskIds: readonly string[]): Promise<(Task | undefined)[]> {
    if (taskIds.length === 0) return [];
    const now = new Map(taskIds.map((id) => [id, id]));
    for (const former of await this.#reads.formerIds(taskIds)) now.set(former.formerId, former.taskId);
    const { results } = await this.#db
      .prepare('SELECT t.id, t.project_id FROM json_each(?1) w CROSS JOIN tasks t ON t.id = w.value')
      .bind(JSON.stringify([...new Set(now.values())]))
      .all<{ id: string; project_id: string }>();
    const byProject = new Map<string, string[]>();
    for (const row of results) byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row.id]);
    const tasks = new Map<string, Task>();
    for (const [projectId, ids] of byProject)
      for (const row of await this.#reads.taskRows(projectId, ids)) tasks.set(row.id, toTask(row));
    return taskIds.map((id) => tasks.get(now.get(id)!));
  }

  /** A move's answer from its record, its tasks as they stand now. */
  async #moveResult(recorded: Record<string, Json>, replayed: boolean): Promise<MoveResult> {
    const epics = Array.isArray(recorded.epics) ? (recorded.epics as string[]) : [];
    const moved = (recorded.moved as [string, string][]).map(([from, to]): MovedId => ({ from, to }));
    const present = (tasks: readonly (Task | undefined)[]) => tasks.filter((task) => task !== undefined);
    const [tasks, closed] = await Promise.all([this.#tasksNow(recorded.tasks as string[]), this.#tasksNow(epics)]);
    return { tasks: present(tasks), moved, ...(epics.length === 0 ? {} : { epics: present(closed) }), replayed };
  }

  /** A move's record answers wherever its tasks went since: the tasks it placed may have moved on. */
  async #replayMove(retry: Retry | undefined): Promise<MoveResult | null> {
    const recorded = await this.#recorded(retry, null);
    if (recorded === null) return null;
    // Another write's record names no moved tasks: its key was used for another kind of request.
    if (!Array.isArray(recorded.tasks)) refuse('retry_conflict');
    return this.#moveResult(recorded, true);
  }

  async recordedMove(retryInput: Retry): Promise<MoveResult | null> {
    const retry = check.retry(retryInput) ?? check.invalid('a retry identity is required');
    return this.#replayMove(retry);
  }

  /** A new key in the project that is no task's id or former id, nor one of `taken`. */
  async #freeId(prefix: string, taken: ReadonlySet<string>): Promise<string> {
    for (let tries = 0; ; tries += 1) {
      const id = `${prefix}-${this.#newKey()}`;
      if (taken.has(id) && tries < ATTEMPTS) continue;
      const used = await this.#db
        .prepare(
          'SELECT EXISTS (SELECT 1 FROM tasks WHERE id = ?1) OR EXISTS (SELECT 1 FROM task_aliases WHERE alias = ?1) AS used',
        )
        .bind(id)
        .first<{ used: number }>();
      // A key still taken after a few tries goes to the batch, which fails on it and starts again.
      if (used?.used !== 1 || tries >= ATTEMPTS) return id;
    }
  }

  async moveTasks(
    projectId: string,
    placementsInput: readonly TaskPlacement[],
    actorInput: Actor,
    retryInput?: Retry,
  ): Promise<MoveResult> {
    const actor = check.actor(actorInput);
    const retry = check.retry(retryInput);
    const placements = check.placements(placementsInput);
    const project = await this.#projectOf(projectId);
    const replayed = await this.#replayMove(retry);
    if (replayed !== null) return replayed;

    const rows = await this.#existing(
      null,
      placements.map((placement) => placement.taskId),
    );
    for (const placement of placements)
      if (rows.get(placement.taskId)!.version !== placement.expectedVersion) refuse('version_conflict');
    const placing = new Map(placements.map((placement) => [placement.taskId, placement]));
    await this.#existing(projectId, [
      ...new Set(placements.flatMap(({ parentId }) => (parentId === null || placing.has(parentId) ? [] : [parentId]))),
    ]);
    // Parents before their children, so a child takes its new parent's id; a loop among them is refused.
    const ordered: TaskPlacement[] = [];
    const placed = new Set<string>();
    while (ordered.length < placements.length) {
      const ready = placements.filter(
        ({ taskId, parentId }) =>
          !placed.has(taskId) && (parentId === null || !placing.has(parentId) || placed.has(parentId)),
      );
      if (ready.length === 0) refuse('cycle');
      for (const placement of ready) {
        ordered.push(placement);
        placed.add(placement.taskId);
      }
    }
    const leaving = placements.filter(({ taskId }) => rows.get(taskId)!.project_id !== projectId);
    if (leaving.length > 0) {
      const { results } = await this.#db
        .prepare(
          `SELECT c.id, c.parent_id FROM json_each(?1) w CROSS JOIN tasks c INDEXED BY tasks_by_parent
           ON c.parent_id = w.value ORDER BY c.id`,
        )
        .bind(JSON.stringify(leaving.map(({ taskId }) => taskId)))
        .all<{ id: string; parent_id: string }>();
      const behind = results.find((child) => !placing.has(child.id));
      if (behind !== undefined)
        refuse('invalid', `${behind.parent_id} moves to another project only with ${behind.id}, a task under it`);
    }

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const at = this.#now();
      const newIds = new Map<string, string>();
      const children = new Map<string, number>();
      for (const { taskId, parentId } of ordered) {
        if (rows.get(taskId)!.project_id === projectId) continue;
        const parent = parentId === null ? null : (newIds.get(parentId) ?? parentId);
        if (parent === null) {
          newIds.set(taskId, await this.#freeId(project.prefix, new Set(newIds.values())));
          continue;
        }
        const next = children.get(parent) ?? (await this.#childNumber(parent));
        children.set(parent, next + 1);
        newIds.set(taskId, `${parent}.${next}`);
      }
      const after = (id: string) => newIds.get(id) ?? id;

      const statements: Statement[] = [...this.#staleReceipt(retry)];
      // Other tasks name a moved task as their parent or duplicate until their own statements below follow it.
      if (newIds.size > 0) statements.push(this.#db.prepare('PRAGMA defer_foreign_keys = ON'));
      const moved: Moved[] = [];
      const loops: Statement[] = [];
      for (const { taskId, parentId } of ordered) {
        const row = rows.get(taskId)!;
        const id = after(taskId);
        const parent = parentId === null ? null : after(parentId);
        const duplicateOf = row.duplicate_of === null ? null : after(row.duplicate_of);
        if (id === taskId && parent === row.parent_id && duplicateOf === row.duplicate_of) {
          // It stays where it is only as it was read: a write since moves the batch to plan again.
          statements.push(
            this.#db
              .prepare(
                `INSERT INTO write_guard (ok, refusal) SELECT EXISTS (
                   SELECT 1 FROM tasks WHERE id = ?1 AND version = ?2
                 ), 'version_conflict'`,
              )
              .bind(taskId, row.version),
          );
          continue;
        }
        const changes: Record<string, Json> = {};
        const through = heldThrough(actor, {
          assignee: row.assignee,
          assigneeFor: row.assignee_for,
          work: JSON.parse(row.work) as TaskWork,
        });
        if (id !== taskId) Object.assign(changes, { id, projectId });
        if (parent !== row.parent_id) changes.parentId = parent;
        if (duplicateOf !== row.duplicate_of) {
          changes.close = {
            at: row.closed_at,
            reason: row.close_reason,
            resolution: row.resolution,
            duplicateOf,
            by: row.closed_by,
            model: row.closed_model,
            link: row.close_link,
            acceptance: row.close_acceptance === null ? null : (JSON.parse(row.close_acceptance) as JsonObject),
          };
        }
        statements.push(
          this.#db
            .prepare(
              `UPDATE tasks SET id = ?1, project_id = ?2, parent_id = ?3, duplicate_of = ?4, version = version + 1,
                 updated_at = ?5 WHERE id = ?6 AND version = ?7`,
            )
            .bind(id, projectId, parent, duplicateOf, at, taskId, row.version),
          this.#db.prepare("INSERT INTO write_guard (ok, refusal) VALUES (changes() = 1, 'version_conflict')"),
          // A client that reads one project's changes sees the task leave it, by the id it had there, as well as
          // arrive in the other.
          ...(id === taskId
            ? []
            : [
                this.#event(
                  { id, projectId: row.project_id },
                  row.version + 1,
                  'updated',
                  actor,
                  at,
                  { ...changes, formerId: taskId },
                  through,
                ),
              ]),
          this.#event({ id, projectId }, row.version + 1, 'updated', actor, at, changes, through),
        );
        if (parent !== null) loops.push(this.#noParentLoop(parent, id));
        const closed = row.status === 'closed';
        moved.push({
          id,
          ...(id === taskId ? {} : { formerId: taskId }),
          before: { parentId: row.parent_id, closed },
          parentId: parent,
          closed,
          resolution: row.resolution,
        });
      }
      const placedIds = JSON.stringify(ordered.map(({ taskId }) => after(taskId)));
      for (const [from, to] of newIds) {
        statements.push(
          this.#db
            .prepare(
              'UPDATE tasks SET duplicate_of = ?1, version = version + 1, updated_at = ?2 WHERE duplicate_of = ?3',
            )
            .bind(to, at, from),
          this.#db
            .prepare(
              `INSERT INTO task_events (task_id, project_id, version, kind, actor, model, at, changes)
               SELECT id, project_id, version, 'updated', ?2, ?3, ?4, json_object('close', json_object(
                 'at', closed_at, 'reason', close_reason, 'resolution', resolution, 'duplicateOf', duplicate_of,
                 'by', closed_by, 'model', closed_model, 'link', close_link, 'acceptance', json(close_acceptance)))
               FROM tasks WHERE duplicate_of = ?1 AND id NOT IN (SELECT value FROM json_each(?5))`,
            )
            .bind(to, actor.name, actor.model ?? null, at, placedIds),
          // A task filed under a moved task since the move was planned would be left in the old project.
          this.#db
            .prepare(
              `INSERT INTO write_guard (ok, refusal) SELECT NOT EXISTS (
                 SELECT 1 FROM tasks INDEXED BY tasks_by_parent WHERE parent_id = ?1
               ), 'version_conflict'`,
            )
            .bind(from),
        );
      }
      statements.push(...loops);
      const { statements: settled, epics } = await this.#epicsAfter(moved, at);
      const recorded = {
        taskId: after(placements[0]!.taskId),
        created: [],
        tasks: placements.map(({ taskId }) => after(taskId)),
        moved: [...newIds],
        ...(epics.length === 0 ? {} : { epics }),
      };
      statements.push(
        ...settled,
        ...this.#receipt(retry, projectId, recorded as unknown as JsonObject, at, recorded.tasks),
      );
      try {
        await this.#db.batch(statements);
        return this.#moveResult(recorded as unknown as Record<string, Json>, false);
      } catch (error) {
        if (guardRefusalOf(messageOf(error)) === 'version_conflict') {
          const replay = await this.#replayMove(retry);
          if (replay !== null) return replay;
        }
        const failure = failureOf(error);
        if (failure === 'id_taken') continue;
        return (await this.#replayMove(retry)) ?? refuse('retry_conflict');
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
    written: ReadonlySet<string>,
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
    // An epic Ntasks closed on its own takes a close by whoever closes it now, with their reason.
    if (write.close !== null && closed && !closedByNtasks(current)) refuse('invalid', 'The task is already closed.');
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
    // A change by the holder was made through its helper and session: as the
    // write leaves them while it keeps the hold, or as they stood when the
    // write ends it, whatever it names for the next holder.
    const through: Through =
      current.assignee === actor.name
        ? ended
          ? heldThrough(actor, current)
          : { actorFor: helper ?? current.assigneeFor, session: work.session ?? current.work.session ?? null }
        : holder === actor.name
          ? { actorFor: helper, session: work.session ?? null }
          : THROUGH_NONE;

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
      const { acceptance, test } = write.close;
      columns.close_acceptance = acceptance === null ? null : JSON.stringify(acceptance);
      columns.close_test = test === null ? null : JSON.stringify(test);
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
        test: test as unknown as JsonObject | null,
      };
      const { commit, pullRequest } = write.close;
      if (commit !== null || pullRequest !== null) {
        // A commit pushed to a default branch before the close is merged already, as its push would have moved it.
        const pushed = commit !== null && pullRequest === null ? await this.#pushOf(commit, at) : null;
        const liveAt = pushed?.mergesLive === true ? pushed.pushedAt : null;
        columns.delivery_stage = pushedStage(pushed);
        columns.delivery_commit = commit;
        columns.delivery_pull_request = pullRequest;
        columns.built_at = at;
        if (pushed !== null) {
          columns.delivery_merge_commit = pushed.head;
          columns.delivery_repository = pushed.repository;
          columns.merged_at = pushed.pushedAt;
          columns.live_at = liveAt;
        }
        changes.delivery = deliveryJson({
          stage: pushedStage(pushed),
          commit,
          pullRequest,
          mergeCommit: pushed?.head ?? null,
          repository: pushed?.repository ?? null,
          builtAt: at,
          mergedAt: pushed?.pushedAt ?? null,
          liveAt,
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
        'close_test',
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
    // A task dropped here relates to each open task whose text names it, so that task relies on it (droppedSince).
    if (write.close !== null && DROPPED.includes(write.close.resolution)) {
      // A link the close itself removes stays removed.
      const linked = new Set([
        ...links.keys(),
        ...current.dependents.map((link) => link.taskId),
        ...written,
        ...write.removeLinks,
      ]);
      for (const naming of await this.#namedBy(taskId, linked)) {
        addLinks.push({ taskId: naming, type: 'related' });
        links.set(naming, 'related');
      }
    }

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
    // The pull request an approval gates is part of what a person approves,
    // and stays as the approval was asked for, so no answer comes to cover another.
    if (
      current.type === 'gate' &&
      [...removeExternal.map((url) => current.externalLinks.find((link) => link.url === url)), ...addExternal].some(
        (link) =>
          link?.kind === 'pull-request' ||
          current.externalLinks.some((had) => had.url === link?.url && had.kind === 'pull-request'),
      )
    )
      refuse(
        'invalid',
        "An approval's pull request stays as the approval was asked for; ask for a new approval instead.",
      );
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
        return this.#comment(current, version, commentId, write.comment, write.pins, write.test, actor, at, through);
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
      statements.push(...comment(version), this.#event(current, version, kind, actor, at, changes, through));
      return statements;
    };
  }

  /**
   * The open tasks, in any project, whose description, acceptance, notes or
   * design name this task by its id or a former id, as a whole id, newest
   * change first, at most NAMED_LINKS of them, leaving out those in `linked`.
   * It reads one index entry and one row for each task that is not closed.
   */
  async #namedBy(taskId: string, linked: ReadonlySet<string>): Promise<string[]> {
    const { results: aliases } = await this.#db
      .prepare('SELECT alias FROM task_aliases INDEXED BY task_aliases_by_task WHERE task_id = ?1')
      .bind(taskId)
      .all<{ alias: string }>();
    const ids = [taskId, ...aliases.map((row) => row.alias)];
    // One condition per id, bound as ?1, ?2…: a json_each over the ids would read a row more for each task.
    const names = ids
      .map((_, index) =>
        ['description', 'acceptance', 'notes', 'design'].map((column) => `instr(t.${column}, ?${index + 1}) > 0`),
      )
      .flat()
      .join(' OR ');
    const { results } = await this.#db
      .prepare(
        `SELECT t.id, t.description, t.acceptance, t.notes, t.design FROM projects p
           CROSS JOIN tasks t INDEXED BY tasks_by_project_status
             ON t.project_id = p.id AND t.status IN ('open', 'in_progress', 'blocked', 'deferred')
         WHERE t.id <> ?1 AND (${names})
         ORDER BY t.updated_at DESC, t.id`,
      )
      .bind(...ids)
      .all<{ id: string; description: string; acceptance: string; notes: string; design: string }>();
    const named = ids.map(namesTask);
    return results
      .filter(
        (row) =>
          !linked.has(row.id) &&
          [row.description, row.acceptance, row.notes, row.design].some((text) => named.some((test) => test(text))),
      )
      .slice(0, NAMED_LINKS)
      .map((row) => row.id);
  }

  /**
   * The related links an epic Ntasks drops takes to the open tasks that name
   * it, as a close that drops a task adds them (#prepare), and its links once
   * they are added, for its history; none when no open task names it.
   */
  async #namedLinksOf(
    epicId: string,
    actor: Actor,
    at: string,
    renamed: ReadonlyMap<string, string>,
    written: ReadonlySet<string>,
  ): Promise<{ statements: Statement[]; links: Json | null }> {
    const { results } = await this.#db
      .prepare(
        `SELECT depends_on_id AS id, type FROM task_edges WHERE task_id = ?1
         UNION ALL SELECT task_id AS id, NULL AS type FROM task_edges INDEXED BY task_edges_by_dependency WHERE depends_on_id = ?1`,
      )
      .bind(epicId)
      .all<{ id: string; type: DependencyType | null }>();
    const naming = await this.#namedBy(epicId, new Set([...results.map((row) => row.id), ...written]));
    if (naming.length === 0) return { statements: [], links: null };
    const links = new Map(
      results.flatMap((row) => (row.type === null ? [] : [[renamed.get(row.id) ?? row.id, row.type] as const])),
    );
    for (const id of naming) links.set(id, 'related');
    const statements = naming.map((id) =>
      this.#db
        .prepare(
          `INSERT INTO task_edges (task_id, depends_on_id, type, created_at, created_by) VALUES (?1, ?2, 'related', ?3, ?4)
           ON CONFLICT (task_id, depends_on_id) DO NOTHING`,
        )
        .bind(epicId, id, at, actor.name),
    );
    return { statements, links: linkList(links) };
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
    testInput?: TaskTestResult,
  ): Promise<CommentResult> {
    const actor = check.actor(actorInput);
    const retry = check.retry(retryInput);
    const text = check.text(textInput, 'comment', 4096, true);
    const pins = check.pins(pinsInput);
    const test = testInput === undefined ? null : check.testResult(testInput, 'test');
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
        ...this.#comment({ id: taskId, projectId: row.project_id }, null, id, text, pins, test, actor, at),
        ...this.#receipt(retry, projectId, { commentId: id }, at, [taskId]),
      ]);
    } catch (error) {
      failureOf(error);
      return (await replayComment()) ?? refuse('retry_conflict');
    }
    return {
      comment: { id, taskId, author: actor.name, text, createdAt: at, pinned: pins?.pin === true, test },
      replayed: false,
    };
  }
}
