// Every write the engine makes. Each is one D1 batch, which commits whole or
// not at all; the write guard (migrations/0001_task_store.sql) rolls a batch
// back when its versioned update matched no row or a link would close a loop.
import {
  guardRefusalOf,
  TaskRefused,
  type Actor,
  type CommentResult,
  type CreateProjectInput,
  type CreateTaskInput,
  type DependencyType,
  type Json,
  type JsonObject,
  type Project,
  type Retry,
  type Task,
  type TaskEventKind,
  type TaskRefusal,
  type TaskWrite,
  type WriteResult,
} from '@ntasks/domain';
import type { Reads } from './reads.ts';
import type { TaskRow } from './rows.ts';
import * as check from './validate.ts';

/** How long a retry record answers a repeated key. */
const RECEIPT_DAYS = 7;
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
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => alphabet[byte % alphabet.length]).join('');
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

export class Writes {
  readonly #db: D1Database;
  readonly #reads: Reads;
  readonly #now: () => string;
  readonly #newKey: () => string;

  constructor(db: D1Database, reads: Reads, options: WriteOptions) {
    this.#db = db;
    this.#reads = reads;
    this.#now = options.now;
    this.#newKey = options.newKey;
  }

  #insert(table: string, row: Row): D1PreparedStatement {
    const columns = Object.keys(row);
    return this.#db
      .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, index) => `?${index + 1}`).join(', ')})`)
      .bind(...Object.values(row));
  }

  #event(task: { id: string; projectId: string }, version: number, kind: TaskEventKind, actor: Actor, at: string, changes: JsonObject) {
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

  /** Fails the batch with `cycle` if `from` already waits, through blocks links, on `to`. */
  #noBlockingLoop(from: string, to: string): D1PreparedStatement {
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
  #noParentLoop(parentId: string, taskId: string): D1PreparedStatement {
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

  #cutoff(): string {
    return new Date(Date.parse(this.#now()) - RECEIPT_DAYS * 86_400_000).toISOString();
  }

  /** The recorded result of an earlier write with this key, or null; a key reused for another request is refused. */
  async #recorded(retry: Retry | undefined, projectId: string): Promise<Record<string, Json> | null> {
    if (retry === undefined) return null;
    const row = await this.#db
      .prepare(
        `SELECT project_id, request_hash, result FROM write_receipts
         WHERE principal = ?1 AND operation = ?2 AND idempotency_key = ?3 AND created_at >= ?4`,
      )
      .bind(retry.principal, retry.operation, retry.key, this.#cutoff())
      .first<{ project_id: string; request_hash: string; result: string }>();
    if (row === null) return null;
    if (row.request_hash !== retry.requestHash || row.project_id !== projectId) refuse('retry_conflict');
    return JSON.parse(row.result) as Record<string, Json>;
  }

  /** Clears this principal's expired records, then records this write's result. */
  #receipt(retry: Retry | undefined, projectId: string, result: JsonObject, at: string): D1PreparedStatement[] {
    if (retry === undefined) return [];
    return [
      this.#db.prepare('DELETE FROM write_receipts WHERE principal = ?1 AND created_at < ?2').bind(retry.principal, this.#cutoff()),
      this.#insert('write_receipts', {
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

  async #result(projectId: string, taskId: string, created: readonly string[], replayed: boolean): Promise<WriteResult> {
    const rows = await this.#reads.taskRows(projectId, [taskId, ...created]);
    const tasks = await this.#reads.hydrate(rows);
    const task = tasks.find((candidate) => candidate.id === taskId) ?? refuse('not_found');
    return { task, created: created.map((id) => tasks.find((candidate) => candidate.id === id) ?? refuse('not_found')), replayed };
  }

  async #replay(retry: Retry | undefined, projectId: string): Promise<WriteResult | null> {
    const recorded = await this.#recorded(retry, projectId);
    if (recorded === null) return null;
    return this.#result(projectId, recorded.taskId as string, recorded.created as string[], true);
  }

  async #projectOf(projectId: string): Promise<Project> {
    return (await this.#reads.project(projectId)) ?? refuse('not_found', 'The project does not exist.');
  }

  /** The id the parent's next child takes: its id, a dot and one more than the highest child number used. */
  async #childId(parentId: string): Promise<string> {
    const row = await this.#db
      .prepare(`SELECT coalesce(max(CAST(substr(id, length(?1) + 2) AS INTEGER)), 0) + 1 AS next FROM tasks WHERE id GLOB ?1 || '.[0-9]*'`)
      .bind(parentId)
      .first<{ next: number }>();
    return `${parentId}.${row?.next ?? 1}`;
  }

  async #existing(projectId: string | null, taskIds: readonly string[]): Promise<Map<string, TaskRow>> {
    if (taskIds.length === 0) return new Map();
    const { results } = await this.#db
      .prepare(`SELECT * FROM tasks WHERE id IN (SELECT value FROM json_each(?1))${projectId === null ? '' : ' AND project_id = ?2'}`)
      .bind(...(projectId === null ? [JSON.stringify(taskIds)] : [JSON.stringify(taskIds), projectId]))
      .all<TaskRow>();
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
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) check.invalid('another project already uses this id, key or prefix');
      throw error;
    }
    return this.#projectOf(id);
  }

  async createTask(projectId: string, input: CreateTaskInput, actorInput: Actor, retryInput?: Retry): Promise<WriteResult> {
    const actor = check.actor(actorInput);
    const retry = check.retry(retryInput);
    const fields = check.createInput(input);
    const project = await this.#projectOf(projectId);
    const replayed = await this.#replay(retry, projectId);
    if (replayed !== null) return replayed;
    if (fields.parentId !== null) await this.#existing(projectId, [fields.parentId]);
    await this.#existing(null, fields.links.map((link) => link.taskId));
    // A `blocks`-direction link changes the other task too: its version, and its history.
    const changedOthers = [...new Set(fields.links.filter((link) => link.direction === 'blocks').map((link) => link.taskId))];

    let lastFailure: 'id_taken' | 'version_conflict' = 'id_taken';
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      // Read again on every attempt: the caller named no version for these
      // tasks, so a change to one of them since is retried, not refused.
      const others = await this.#reads.hydrate(await this.#reads.taskRows(projectId, changedOthers));
      if (others.length !== changedOthers.length) refuse('not_found', 'A task this new one blocks is not in this project.');
      const id = fields.parentId === null ? `${project.prefix}-${this.#newKey()}` : await this.#childId(fields.parentId);
      const at = this.#now();
      const dependencies = new Map<string, DependencyType>();
      const statements: D1PreparedStatement[] = [
        this.#insert('tasks', {
          id,
          project_id: projectId,
          parent_id: fields.parentId,
          type: fields.type,
          status: 'open',
          priority: fields.priority,
          title: fields.title,
          description: fields.description,
          acceptance: fields.acceptance,
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
      ];
      for (const link of fields.links) {
        if (link.taskId === id) refuse('invalid', 'A task cannot link to itself.');
        const [from, to] = link.direction === 'depends-on' ? [id, link.taskId] : [link.taskId, id];
        if (link.direction === 'depends-on') dependencies.set(link.taskId, link.type);
        statements.push(this.#insert('task_edges', { task_id: from, depends_on_id: to, type: link.type, created_at: at, created_by: actor.name }));
        if (link.type === 'blocks') statements.push(this.#noBlockingLoop(to, from));
      }
      for (const other of others) {
        const otherLinks = new Map(other.dependencies.map((dependency) => [dependency.taskId, dependency.type]));
        for (const link of fields.links) if (link.direction === 'blocks' && link.taskId === other.id) otherLinks.set(id, link.type);
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
          status: 'open',
          priority: fields.priority,
          title: fields.title,
          description: fields.description,
          acceptance: fields.acceptance,
          assignee: null,
          assigneeModel: null,
          startedAt: null,
          deferUntil: fields.deferUntil,
          dueAt: fields.dueAt,
          choices: fields.choices,
          choice: null,
          metadata: fields.metadata,
          labels: [...fields.labels].sort(),
          dependencies: linkList(dependencies),
          close: null,
          filedBy: actor.name,
          filedModel: actor.model ?? null,
        }),
        ...this.#receipt(retry, projectId, { taskId: id, created: [] }, at),
      );
      try {
        await this.#db.batch(statements);
        return await this.#result(projectId, id, [], false);
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
    if (lastFailure === 'version_conflict') refuse('version_conflict', 'A task this new one blocks kept changing; try again.');
    throw new Error(`No free task id in project ${projectId} after ${ATTEMPTS} attempts.`);
  }

  async writeTask(projectId: string, taskId: string, writeInput: TaskWrite, actorInput: Actor, retryInput?: Retry): Promise<WriteResult> {
    const actor = check.actor(actorInput);
    const retry = check.retry(retryInput);
    const write = check.write(writeInput);
    const project = await this.#projectOf(projectId);
    const [row] = await this.#reads.taskRows(projectId, [taskId]);
    if (row === undefined) refuse('not_found');
    const replayed = await this.#replay(retry, projectId);
    if (replayed !== null) return replayed;
    if (row.version !== write.expectedVersion) refuse('version_conflict');
    const [current] = (await this.#reads.hydrate([row])) as [Task];

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
    if (closed && !write.reopen && set.status !== undefined) refuse('invalid', 'Reopen a closed task before changing its status.');
    if (current.type === 'gate' && set.type !== undefined) refuse('invalid', "A gate's type cannot change.");

    if (set.title !== undefined) change('title', 'title', set.title);
    if (set.description !== undefined) change('description', 'description', set.description);
    if (set.acceptance !== undefined) change('acceptance', 'acceptance', set.acceptance);
    if (set.type !== undefined) change('type', 'type', set.type);
    if (set.priority !== undefined) change('priority', 'priority', set.priority);
    if (set.deferUntil !== undefined) change('defer_until', 'deferUntil', set.deferUntil);
    if (set.dueAt !== undefined) change('due_at', 'dueAt', set.dueAt);
    if (set.choices !== undefined) change('choices', 'choices', set.choices === null ? null : JSON.stringify(set.choices), set.choices);
    if (set.choice !== undefined) change('choice', 'choice', set.choice === null ? null : JSON.stringify(set.choice), set.choice);
    const choices = set.choices !== undefined ? set.choices : current.choices;
    const choice = set.choice !== undefined ? set.choice : current.choice;
    if (choice !== null && choices === null) refuse('invalid', 'A choice needs choices to pick from.');

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

    const at = this.#now();
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
      changes.status = 'closed';
      changes.close = {
        at,
        reason: write.close.reason,
        resolution: write.close.resolution,
        duplicateOf: write.close.duplicateOf,
        by: actor.name,
        model: actor.model ?? null,
      };
    } else if (write.reopen) {
      kind = 'reopened';
      for (const column of ['closed_at', 'close_reason', 'resolution', 'duplicate_of', 'closed_by', 'closed_model']) columns[column] = null;
      change('status', 'status', set.status ?? 'open');
      changes.close = null;
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
    await this.#existing(null, write.addLinks.map((link) => link.taskId));
    const addLinks = write.addLinks.filter((link) => links.get(link.taskId) !== link.type);
    for (const link of addLinks) links.set(link.taskId, link.type);

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const gateId = write.requestApproval === null ? null : `${project.prefix}-${this.#newKey()}`;
      const taskLinks = new Map(links);
      if (gateId !== null) taskLinks.set(gateId, 'blocks');
      if (gateId !== null || addLinks.length > 0 || removeLinks.length > 0) changes.dependencies = linkList(taskLinks);
      const version = current.version + 1;
      const assignments = Object.keys(columns).map((column, index) => `${column} = ?${index + 1}`);
      const values = Object.values(columns);
      const statements: D1PreparedStatement[] = [
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
      if (gateId !== null && write.requestApproval !== null) {
        const reason = write.requestApproval.reason;
        const title = reason.split('\n')[0]!.slice(0, 512);
        statements.push(
          this.#insert('tasks', {
            id: gateId,
            project_id: projectId,
            type: 'gate',
            await_type: 'human',
            status: 'open',
            priority: current.priority,
            title,
            description: reason,
            metadata: '{}',
            filed_by: actor.name,
            filed_model: actor.model ?? null,
            version: 1,
            created_at: at,
            updated_at: at,
          }),
          this.#event({ id: gateId, projectId }, 1, 'created', actor, at, {
            id: gateId,
            projectId,
            parentId: null,
            type: 'gate',
            awaitType: 'human',
            status: 'open',
            priority: current.priority,
            title,
            description: reason,
            acceptance: '',
            assignee: null,
            assigneeModel: null,
            startedAt: null,
            deferUntil: null,
            dueAt: null,
            choices: null,
            choice: null,
            metadata: {},
            labels: [],
            dependencies: [],
            close: null,
            filedBy: actor.name,
            filedModel: actor.model ?? null,
          }),
          this.#insert('task_edges', { task_id: taskId, depends_on_id: gateId, type: 'blocks', created_at: at, created_by: actor.name }),
        );
      }
      for (const label of removeLabels) {
        statements.push(this.#db.prepare('DELETE FROM task_labels WHERE task_id = ?1 AND label = ?2').bind(taskId, label));
      }
      for (const label of addLabels) statements.push(this.#insert('task_labels', { task_id: taskId, label }));
      for (const id of removeLinks) {
        statements.push(this.#db.prepare('DELETE FROM task_edges WHERE task_id = ?1 AND depends_on_id = ?2').bind(taskId, id));
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
      if (write.comment !== null) {
        const commentId = crypto.randomUUID();
        statements.push(
          this.#insert('task_comments', { id: commentId, task_id: taskId, author: actor.name, text: write.comment, created_at: at }),
          this.#event(current, version, 'commented', actor, at, { commentId, text: write.comment }),
        );
      }
      statements.push(
        this.#event(current, version, kind, actor, at, changes),
        ...this.#receipt(retry, projectId, { taskId, created: gateId === null ? [] : [gateId] }, at),
      );
      try {
        await this.#db.batch(statements);
        return await this.#result(projectId, taskId, gateId === null ? [] : [gateId], false);
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

  async addComment(projectId: string, taskId: string, textInput: string, actorInput: Actor, retryInput?: Retry): Promise<CommentResult> {
    const actor = check.actor(actorInput);
    const retry = check.retry(retryInput);
    const text = check.text(textInput, 'comment', 4096, true);
    const [row] = await this.#reads.taskRows(projectId, [taskId]);
    if (row === undefined) refuse('not_found');
    const replayComment = async (): Promise<CommentResult | null> => {
      const recorded = await this.#recorded(retry, projectId);
      if (recorded === null) return null;
      const comment = (await this.#reads.listComments(projectId, taskId)).find((candidate) => candidate.id === recorded.commentId);
      return comment === undefined ? refuse('not_found') : { comment, replayed: true };
    };
    const replayed = await replayComment();
    if (replayed !== null) return replayed;
    const id = crypto.randomUUID();
    const at = this.#now();
    try {
      await this.#db.batch([
        this.#insert('task_comments', { id, task_id: taskId, author: actor.name, text, created_at: at }),
        this.#db
          .prepare(
            `INSERT INTO task_events (task_id, project_id, version, kind, actor, model, at, changes)
             SELECT id, project_id, version, 'commented', ?2, ?3, ?4, ?5 FROM tasks WHERE id = ?1`,
          )
          .bind(taskId, actor.name, actor.model ?? null, at, JSON.stringify({ commentId: id, text })),
        ...this.#receipt(retry, projectId, { commentId: id }, at),
      ]);
    } catch (error) {
      failureOf(error);
      return (await replayComment()) ?? refuse('retry_conflict');
    }
    return { comment: { id, taskId, author: actor.name, text, createdAt: at }, replayed: false };
  }
}
