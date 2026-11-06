/**
 * The Tasks API answered from data held in the page: the app's development
 * server (`vite --mode fixture`) and its tests run against it. Every change
 * lives until the page reloads. It keeps the rules the pages rely on: one
 * claim wins, a closed task leaves ready work, a decision closes on its
 * answer, and a task waits while anything it depends on is open.
 */
import { isTaskId, type TaskResolution } from '@ntasks/domain';
import { ApiError, type TasksApi } from './client';
import { FIXTURE_ACTOR, fixtureSeed, type FixtureSeed, type FixtureTask } from './fixture-data';
import type { LiveEpic, LiveTask, TaskChange, TaskComment, TaskProject } from './types';

/** How far back a board's closed tasks reach. */
const CLOSED_DAYS = 7;
const DAY = 24 * 3_600_000;

function copy<T>(value: T): T {
  return structuredClone(value);
}

export interface FixtureOptions {
  /** The seed's clock and every change's time. */
  now?: () => number;
  seed?: FixtureSeed;
  /** Fails every call, as a server that cannot be reached would. */
  unreachable?: boolean;
}

export function createFixtureTasksApi({ now = Date.now, seed, unreachable = false }: FixtureOptions = {}): TasksApi & {
  /** The data as it stands, for tests to read back what a press wrote. */
  readonly state: FixtureSeed;
} {
  const state = seed ?? fixtureSeed(now());
  let made = 0;
  /** Each retry key's write and its answer: the same write again gets the
   * answer without being applied twice, and a different write is refused. */
  const receipts = new Map<string, { write: string; answer: unknown }>();

  /** The recorded answer to this write, or undefined when the key is new. */
  function receipt(key: string | undefined, write: unknown): { answer: unknown } | undefined {
    if (key === undefined) return undefined;
    const found = receipts.get(key);
    if (found === undefined) return undefined;
    if (found.write !== JSON.stringify(write)) {
      throw new ApiError('This retry key was used for a different change.', 409, 'idempotency_conflict');
    }
    return { answer: found.answer };
  }

  function record(key: string | undefined, write: unknown, answer: unknown): void {
    if (key !== undefined) receipts.set(key, { write: JSON.stringify(write), answer });
  }

  /** Applies a write once per retry key: the same write sent again gets the
   * first answer without being applied again. A refused write records nothing. */
  function once<T>(key: string | undefined, write: unknown, apply: () => T): T {
    const replay = receipt(key, write);
    if (replay !== undefined) return replay.answer as T;
    const answer = apply();
    record(key, write, answer);
    return answer;
  }

  function reach(): void {
    if (unreachable) throw new ApiError('The task list: the server answered 503.', 503, null);
  }

  function project(key: string): TaskProject {
    const found = state.projects.find((row) => row.logicalKey === key);
    if (!found) throw new ApiError(`No project named ${key}.`, 404, 'unknown_project');
    return found;
  }

  function find(id: string, key: string): FixtureTask {
    project(key);
    const task = state.tasks.find((row) => row.id === id && row.project === key);
    if (!task) throw new ApiError(`Task ${id}: not found.`, 404, null);
    return task;
  }

  /** Ready, as the server works it out: open, and every task it depends on closed. */
  function ready(task: FixtureTask): boolean {
    if (task.status !== 'open') return false;
    return task.dependencies.every(
      (edge) => edge.type !== 'blocks' || state.tasks.find((row) => row.id === edge.id)?.status === 'closed',
    );
  }

  function withLinks(task: FixtureTask): LiveTask {
    const { project: _key, ...row } = task;
    return {
      ...row,
      ready: ready(task),
      comments: state.comments.get(task.id)?.length ?? 0,
      dependencies: task.dependencies.map((edge) => {
        const other = state.tasks.find((candidate) => candidate.id === edge.id);
        return { ...edge, title: other?.title ?? null, status: other?.status ?? null };
      }),
    };
  }

  function epics(key: string): LiveEpic[] {
    return state.tasks
      .filter((task) => task.project === key && task.issueType === 'epic')
      .map((epic) => {
        const children = state.tasks.filter((task) => task.parent === epic.id);
        const closed = children.filter((task) => task.status === 'closed').length;
        return {
          id: epic.id,
          title: epic.title,
          status: epic.status,
          priority: epic.priority,
          total: children.length,
          closed,
          eligibleForClose: epic.status !== 'closed' && children.length > 0 && closed === children.length,
        };
      });
  }

  /** Every change, in order, as the change feed lists it. */
  const changes: TaskChange[] = [];

  function logChange(task: FixtureTask): void {
    const projectId = state.projects.find((row) => row.logicalKey === task.project)?.projectId ?? task.project;
    changes.push({ seq: changes.length + 1, projectId, taskId: task.id });
  }

  function touch(task: FixtureTask): string {
    const at = new Date(now()).toISOString();
    task.updatedAt = at;
    logChange(task);
    return at;
  }

  function addComment(task: FixtureTask, text: string): void {
    const list = state.comments.get(task.id) ?? [];
    const comment: TaskComment = {
      id: `c${list.length + 1}-${task.id}`,
      author: FIXTURE_ACTOR,
      text,
      createdAt: touch(task),
    };
    state.comments.set(task.id, [...list, comment]);
  }

  function close(task: FixtureTask, reason: string, resolution: TaskResolution = 'done', duplicateOf?: string): void {
    if (task.status === 'closed') throw new ApiError(`Task ${task.id} is already closed.`, 409, 'task_refused');
    if (resolution === 'duplicate' && (duplicateOf === undefined || !isTaskId(duplicateOf))) {
      throw new ApiError('A duplicate names the other task.', 409, 'task_refused');
    }
    const at = touch(task);
    task.status = 'closed';
    task.closedAt = at;
    task.closeReason = reason;
    task.resolution = resolution;
    task.duplicateOf = resolution === 'duplicate' ? (duplicateOf ?? null) : null;
    task.metadata = { ...task.metadata, noticeos_closed_by: FIXTURE_ACTOR, noticeos_closed_at: at };
  }

  /** An answered question goes back to ready work without its `human` label. */
  function handBack(task: FixtureTask): void {
    task.labels = task.labels.filter((label) => label !== 'human');
    touch(task);
  }

  function waitsOnPerson(task: FixtureTask): void {
    const asked = task.issueType === 'gate' || task.labels.includes('human');
    if (!asked || task.status === 'closed')
      throw new ApiError(`Task ${task.id} is not waiting on a person.`, 409, 'task_refused');
  }

  return {
    state,
    async capabilities() {
      reach();
      return { live: true, writable: true, projectSelection: true, reason: null };
    },
    async projects() {
      reach();
      return copy(state.projects);
    },
    async board(key) {
      reach();
      const { prefix, logicalKey } = project(key);
      const since = now() - CLOSED_DAYS * DAY;
      const tasks = state.tasks
        .filter((task) => task.project === key)
        .filter((task) => task.status !== 'closed' || Date.parse(task.closedAt ?? '') >= since)
        .map(withLinks);
      return copy({
        project: logicalKey,
        prefix,
        repo: '',
        readAt: new Date(now()).toISOString(),
        closedSince: new Date(since).toISOString(),
        lastSeq: changes.length,
        tasks,
        epics: epics(key),
      });
    },
    async changes(after) {
      reach();
      const events = changes.filter((change) => change.seq > after).slice(0, 100);
      return copy({ events, lastSeq: events.at(-1)?.seq ?? after });
    },
    async task(id, key) {
      reach();
      const task = find(id, key);
      const { prefix, logicalKey } = project(key);
      return copy({
        project: logicalKey,
        prefix,
        repo: '',
        readAt: new Date(now()).toISOString(),
        task: withLinks(task),
        comments: state.comments.get(id) ?? [],
      });
    },
    async createTask(input, options) {
      reach();
      return once(options?.idempotencyKey, ['create', input], () => {
        const { prefix } = project(input.project);
        const title = input.title.trim();
        if (title === '') throw new ApiError('A task needs a title.', 400, 'invalid');
        let id: string;
        if (input.parent) {
          const parent = find(input.parent, input.project);
          const children = state.tasks.filter((task) => task.parent === parent.id).length;
          id = `${parent.id}.${children + 1}`;
        } else {
          made += 1;
          id = `${prefix}-n${made.toString(36)}${(now() % 1296).toString(36).padStart(2, '0')}`;
        }
        const at = new Date(now()).toISOString();
        state.tasks.push({
          project: input.project,
          id,
          title,
          status: 'open',
          priority: input.priority ?? 2,
          issueType: input.type ?? 'task',
          assignee: null,
          updatedAt: at,
          closedAt: null,
          createdAt: at,
          parent: input.parent ?? null,
          deferUntil: null,
          choices: null,
          choice: null,
          resolution: null,
          duplicateOf: null,
          description: input.description ?? '',
          acceptance: input.acceptance ?? '',
          labels: input.labels ?? [],
          ready: true,
          dependencies: [],
          comments: 0,
          metadata: { ...input.metadata, noticeos_filed_by: FIXTURE_ACTOR },
          startedAt: null,
          closeReason: null,
          awaitType: null,
        });
        const filed = state.tasks.at(-1);
        if (filed) logChange(filed);
        return { id, project: input.project };
      });
    },
    async updateTask(id, key, edit, options) {
      reach();
      once(options?.idempotencyKey, ['update', id, key, edit], () => {
        const task = find(id, key);
        if (edit.claim) {
          if (task.status === 'closed') throw new ApiError(`Task ${id} is closed.`, 409, 'task_refused');
          if (task.assignee !== null && task.assignee !== FIXTURE_ACTOR) {
            throw new ApiError(`Task ${id} is held by ${task.assignee}.`, 409, 'task_refused');
          }
          task.assignee = FIXTURE_ACTOR;
          task.status = 'in_progress';
          task.startedAt ??= new Date(now()).toISOString();
        }
        if (edit.status !== undefined) {
          if (edit.status === 'closed')
            throw new ApiError('Close a task with Close, which records why.', 409, 'task_refused');
          task.status = edit.status;
          if (edit.status !== 'deferred') task.deferUntil = null;
        }
        if (edit.priority !== undefined) task.priority = edit.priority;
        if (edit.assignee !== undefined) task.assignee = edit.assignee === '' ? null : edit.assignee;
        if (edit.parent !== undefined) task.parent = edit.parent === '' ? null : edit.parent;
        if (edit.defer !== undefined) {
          task.deferUntil = edit.defer === '' ? null : edit.defer;
          if (edit.defer === '' && task.status === 'deferred') task.status = 'open';
          if (edit.defer !== '') task.status = 'deferred';
        }
        if (edit.title !== undefined) task.title = edit.title;
        if (edit.description !== undefined) task.description = edit.description;
        if (edit.acceptance !== undefined) task.acceptance = edit.acceptance;
        if (edit.addLabels) task.labels = [...new Set([...task.labels, ...edit.addLabels])];
        if (edit.removeLabels) task.labels = task.labels.filter((label) => !edit.removeLabels?.includes(label));
        touch(task);
      });
    },
    async closeTask(id, key, reason, { resolution, duplicateOf, idempotencyKey } = {}) {
      reach();
      once(idempotencyKey, ['close', id, key, reason, resolution ?? 'done', duplicateOf ?? null], () => {
        if (reason.trim() === '') throw new ApiError('A close needs its reason.', 409, 'task_refused');
        close(find(id, key), reason, resolution, duplicateOf);
      });
    },
    async comment(id, key, text, options) {
      reach();
      once(options?.idempotencyKey, ['comment', id, key, text], () => addComment(find(id, key), text));
    },
    async respond(id, key, response, options) {
      reach();
      once(options?.idempotencyKey, ['respond', id, key, response], () => {
        const task = find(id, key);
        waitsOnPerson(task);
        addComment(task, response);
        if (task.issueType === 'decision') close(task, response);
        else handBack(task);
      });
    },
    async choose(id, key, option, note, options) {
      reach();
      once(options?.idempotencyKey, ['choose', id, key, option, note ?? null], () => {
        const task = find(id, key);
        waitsOnPerson(task);
        const picked = task.choices?.options.find((entry) => entry.key === option);
        if (!picked) throw new ApiError(`Task ${id} offers no option ${option}.`, 409, 'task_refused');
        task.choice = {
          option,
          label: picked.label,
          by: FIXTURE_ACTOR,
          at: new Date(now()).toISOString(),
          ...(note ? { note } : {}),
        };
        if (task.issueType === 'decision') close(task, `Chose (${option}) ${picked.label}`);
        else handBack(task);
      });
    },
    async dismiss(id, key, reason, { resolution = 'wont-do', duplicateOf, idempotencyKey } = {}) {
      reach();
      once(idempotencyKey, ['dismiss', id, key, reason ?? null, resolution, duplicateOf ?? null], () => {
        const task = find(id, key);
        waitsOnPerson(task);
        close(task, reason ? `Dismissed: ${reason}` : 'Dismissed', resolution, duplicateOf);
      });
    },
    async dispute(id, key) {
      reach();
      const task = find(id, key);
      if (task.issueType !== 'gate' || task.status !== 'closed')
        throw new ApiError(`Task ${id} is not an answered approval.`, 409, 'task_refused');
      task.status = 'open';
      task.closedAt = null;
      task.closeReason = null;
      task.resolution = null;
      touch(task);
    },
    async resolveGate(id, key, reason, options) {
      reach();
      once(options?.idempotencyKey, ['resolve', id, key, reason ?? null], () => {
        const task = find(id, key);
        if (task.issueType !== 'gate') throw new ApiError(`Task ${id} is not an approval.`, 409, 'task_refused');
        close(task, reason ? `Approved: ${reason}` : 'Approved');
      });
    },
  };
}
