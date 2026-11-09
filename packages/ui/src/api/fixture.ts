/**
 * The Tasks API answered from data held in the page: the package's
 * development server (`vite --mode fixture`), its tests and a host's run
 * against it, as `@notice-cx/ntasks-ui/fixture`. Every change
 * lives until the page reloads. It keeps the rules the pages rely on: one
 * claim wins, a closed task leaves ready work, a decision closes on its
 * answer, and a task waits while anything it depends on is open. Each
 * workspace holds its own projects, members and invitations, and only an
 * owner manages them.
 */
import {
  ACCEPTED_REASON,
  criteriaOf,
  isExternalLinkKind,
  isTaskId,
  markedStep,
  PARENT_CONTEXT_LIMITS,
  PROVED_TYPES,
  TASK_LIMITS,
  type TaskResolution,
} from '@ntasks/domain';
import { fieldMatches, httpUrl, isCalendarDate } from '../lib/custom-fields';
import { ApiError, type TasksApi } from './client';
import {
  emptySeed,
  FIXTURE_ACTOR,
  FIXTURE_ACTORS,
  FIXTURE_USER,
  fixtureWorkspaces,
  type FixtureSeed,
  type FixtureTask,
  type FixtureWorkspace,
} from './fixture-data';
import type {
  ConnectedApp,
  FieldFilters,
  LiveEpic,
  LiveTask,
  ParentContext,
  TaskChange,
  TaskComment,
  TaskEdit,
  TaskField,
  TaskFieldValue,
  TaskProject,
  Workspace,
} from './types';

/** A project's prefix starts its task ids: lowercase letters and digits, as `@ntasks/domain`'s task ids take them. */
const PREFIX = /^[a-z0-9]{1,16}$/u;
/** GitHub's rule for a username: letters, digits and single hyphens between them, at most 39. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;
const NAME_LIMIT = 80;
/** A connected app's name, as the Worker takes it. */
const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;
/** A GitHub webhook's secret and deploy checks, as the Worker takes them. */
const WEBHOOK_SECRET = /^[\x21-\x7e]{32,255}$/u;
const DEPLOY_CHECKS = 20;

/** A redirect address the Worker takes: https on a public host, or http on this machine, with a path. */
function redirectAddress(value: string): boolean {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return (
      value.startsWith(`${url.origin}/`) &&
      !value.includes('#') &&
      ((url.protocol === 'https:' && !local) || (url.protocol === 'http:' && local))
    );
  } catch {
    return false;
  }
}
/** A workspace's name, as the Worker's `workspaceNameOf` takes it: one line of 1 to 128 characters, trimmed. */
const WORKSPACE_NAME_LIMIT = 128;

/** How far back a board's closed tasks reach. */
const CLOSED_DAYS = 7;
const DAY = 24 * 3_600_000;
/** The most tasks a search answers, and the longest text it takes, as the Worker's search route. */
const SEARCH_PAGE = 100;
const SEARCH_TEXT = 512;

function copy<T>(value: T): T {
  return structuredClone(value);
}

export interface FixtureOptions {
  /** The seed's clock and every change's time. */
  now?: () => number;
  /** The first workspace's projects and tasks. */
  seed?: FixtureSeed;
  /** Every workspace the sign-in reaches, `fixtureWorkspaces` unless given. The first is selected at the start. */
  workspaces?: FixtureWorkspace[];
  /** The sign-in is one of the deployment's admins, who may create workspaces. */
  deploymentAdmin?: boolean;
  /** Fails every call, as a server that cannot be reached would. */
  unreachable?: boolean;
}

export function createFixtureTasksApi({
  now = Date.now,
  seed,
  workspaces: given,
  deploymentAdmin = false,
  unreachable = false,
}: FixtureOptions = {}): TasksApi & {
  /** The selected workspace's data as it stands, for tests to read back what a press wrote. */
  readonly state: FixtureSeed;
} {
  const spaces = given ?? fixtureWorkspaces(now(), seed);
  let selected: string | null = spaces[0]?.workspaceId ?? null;
  let space: FixtureWorkspace | null = spaces[0] ?? null;
  let state = space?.seed ?? emptySeed();
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

  function reachServer(): void {
    if (unreachable) throw new ApiError('The task list: the server answered 503.', 503, null);
  }

  /** The selected workspace, or the server's refusal when none is selected or it is not one the sign-in reaches. */
  function reach(): FixtureWorkspace {
    reachServer();
    if (space !== null) return space;
    if (selected === null) throw new ApiError('Name the workspace in x-ntasks-workspace.', 400, 'workspace_required');
    throw new ApiError('No such workspace.', 404, 'not_found');
  }

  /** The selected workspace, when the sign-in owns it. */
  function owned(): FixtureWorkspace {
    const workspace = reach();
    if (workspace.role !== 'owner') throw new ApiError('Only an owner of the workspace may do that.', 403, 'forbidden');
    return workspace;
  }

  function listed({ workspaceId, name, role }: Workspace): Workspace {
    return { workspaceId, name, role };
  }

  /** A workspace's name as creating and renaming one take it, or the Worker's refusal of it. */
  function workspaceName(name: string): string {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed.length > WORKSPACE_NAME_LIMIT || /[\u0000-\u001f\u007f]/u.test(trimmed))
      throw new ApiError(`name is one line of 1 to ${WORKSPACE_NAME_LIMIT} characters`, 400, 'invalid_request', 'name');
    return trimmed;
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

  /** Records a change by the fixture's sign-in, which is the holder's activity when it holds the task. */
  function touch(task: FixtureTask): string {
    const at = new Date(now()).toISOString();
    task.updatedAt = at;
    if (task.assignee === FIXTURE_ACTOR) task.lastActivityAt = at;
    logChange(task);
    return at;
  }

  /** A release or a hand-on ends the holder's work: its helper, details and last activity go. A close keeps the activity. */
  function endWork(task: FixtureTask, closing = false): void {
    task.for = null;
    task.work = {};
    if (!closing) task.lastActivityAt = null;
  }

  /** What the task's parent holds for it, as the Worker answers it (PARENT_CONTEXT_LIMITS). */
  function parentContext(task: FixtureTask): ParentContext | null {
    const parent = task.parent === null ? undefined : state.tasks.find((row) => row.id === task.parent);
    if (parent === undefined) return null;
    const pinned = (state.comments.get(parent.id) ?? [])
      .filter((comment) => comment.pinned === true)
      .toReversed()
      .map(({ id, author, text, createdAt }) => ({ id, author, text, createdAt }));
    const closed = state.tasks
      .filter((row) => row.parent === parent.id && row.id !== task.id && row.status === 'closed')
      .toSorted((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
    return {
      id: parent.id,
      title: parent.title,
      type: parent.issueType,
      status: parent.status,
      pinned: pinned.slice(0, PARENT_CONTEXT_LIMITS.pinned),
      pinnedTotal: pinned.length,
      closedSiblings: closed.slice(0, PARENT_CONTEXT_LIMITS.closedSiblings).map((row) => ({
        id: row.id,
        title: row.title,
        resolution: row.resolution ?? 'done',
        closedAt: row.closedAt ?? '',
        closedBy: row.closedBy ?? null,
        closeReason: row.closeReason ?? null,
        commit: row.delivery?.commit ?? null,
        pullRequest: row.delivery?.pullRequest ?? null,
        closeLink: row.closeLink ?? null,
      })),
      closedSiblingsTotal: closed.length,
    };
  }

  function addComment(task: FixtureTask, text: string): void {
    const list = state.comments.get(task.id) ?? [];
    const comment: TaskComment = {
      id: `c${list.length + 1}-${task.id}`,
      author: FIXTURE_ACTOR,
      text,
      createdAt: touch(task),
      pinned: false,
    };
    state.comments.set(task.id, [...list, comment]);
  }

  function close(task: FixtureTask, reason: string, resolution: TaskResolution = 'done', duplicateOf?: string): void {
    if (task.status === 'closed') throw new ApiError(`Task ${task.id} is already closed.`, 409, 'task_refused');
    if (resolution === 'duplicate' && (duplicateOf === undefined || !isTaskId(duplicateOf))) {
      throw new ApiError('A duplicate names the other task.', 409, 'task_refused');
    }
    const at = touch(task);
    endWork(task, true);
    task.status = 'closed';
    task.closedAt = at;
    task.closeReason = reason;
    task.resolution = resolution;
    task.duplicateOf = resolution === 'duplicate' ? (duplicateOf ?? null) : null;
    // The page closes without a commit, pull request or link, so work it closes as done has no proof.
    task.proof = resolution === 'done' && (PROVED_TYPES as readonly string[]).includes(task.issueType) ? 'none' : null;
    task.closeAcceptance = null;
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

  function invalid(detail: string): never {
    throw new ApiError(detail, 400, 'invalid_request');
  }

  function fieldOf(key: string, name: string, at: string): TaskField {
    return (
      state.fields.get(key)?.find((field) => field.key === name) ??
      invalid(`${at}${name}: the project has no field ${name}`)
    );
  }

  /** A value as the API keeps it, or the API's refusal: of its field's type, and never a new value of a retired field. */
  function fieldValue(field: TaskField, value: TaskFieldValue): TaskFieldValue {
    const refuse = (rule: string): never =>
      invalid(`fields.${field.key} must be ${rule}: ${field.name} is a ${field.type} field`);
    if (field.retiredAt !== null) invalid(`fields.${field.key}: ${field.name} is retired and takes no new values`);
    const options = field.options ?? [];
    switch (field.type) {
      case 'number':
        return typeof value === 'number' && Number.isFinite(value) ? value : refuse('a number');
      case 'date':
        return typeof value === 'string' && isCalendarDate(value) ? value : refuse('a date as YYYY-MM-DD');
      case 'single-choice':
        return typeof value === 'string' && options.includes(value) ? value : refuse(`one of ${options.join(', ')}`);
      case 'multiple-choice':
        return Array.isArray(value) && value.length > 0 && value.every((option) => options.includes(option))
          ? options.filter((option) => value.includes(option))
          : refuse('a list of its options');
      case 'url':
        return (typeof value === 'string' ? httpUrl(value) : null) ?? refuse('an http or https URL');
      case 'yes-no':
        return typeof value === 'boolean' ? value : refuse('true or false');
      default:
        return typeof value === 'string' && value.trim() !== '' && value.length <= TASK_LIMITS.fieldText
          ? value
          : refuse(`text of 1 to ${TASK_LIMITS.fieldText} characters`);
    }
  }

  /** The new fields an edit sets, as `updateTask` applies them. */
  function applyFields(task: FixtureTask, edit: TaskEdit): void {
    if (edit.notes !== undefined) task.notes = edit.notes;
    if (edit.design !== undefined) task.design = edit.design;
    if (edit.estimateMinutes !== undefined) {
      const minutes = edit.estimateMinutes;
      if (minutes !== null && !(Number.isInteger(minutes) && minutes >= 0 && minutes <= TASK_LIMITS.estimateMinutes))
        invalid(`estimateMinutes must be whole minutes from 0 to ${TASK_LIMITS.estimateMinutes}`);
      task.estimateMinutes = minutes;
    }
    if (edit.dueAt !== undefined) {
      if (edit.dueAt !== null && !isCalendarDate(edit.dueAt)) invalid('dueAt must be a date as YYYY-MM-DD');
      task.dueAt = edit.dueAt === null ? null : `${edit.dueAt}T00:00:00.000Z`;
    }
    if (edit.removeExternalLinks || edit.addExternalLinks) {
      const links = new Map((task.externalLinks ?? []).map((link) => [link.url, link]));
      for (const url of edit.removeExternalLinks ?? []) links.delete(httpUrl(url) ?? url);
      for (const link of edit.addExternalLinks ?? []) {
        const url = httpUrl(link.url) ?? invalid('addExternalLinks: each url must be an http or https URL');
        const title = link.title.trim();
        if (title === '' || title.length > TASK_LIMITS.externalLinkTitle || /\n/.test(title))
          invalid(`addExternalLinks: each title is one line of 1 to ${TASK_LIMITS.externalLinkTitle} characters`);
        if (link.kind !== undefined && !isExternalLinkKind(link.kind))
          invalid('addExternalLinks: kind must be pull-request, document or other');
        links.set(url, { url, title, kind: link.kind ?? null });
      }
      if (links.size > TASK_LIMITS.externalLinks) invalid(`a task links to at most ${TASK_LIMITS.externalLinks} pages`);
      task.externalLinks = [...links.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    }
    if (edit.fields !== undefined) {
      const values = { ...task.fields };
      for (const [name, value] of Object.entries(edit.fields)) {
        const field = fieldOf(task.project, name, 'fields.');
        if (value === null) delete values[name];
        else values[name] = fieldValue(field, value);
      }
      task.fields = values;
    }
  }

  /** Whether a task holds every value a board's filter names. */
  function holds(task: FixtureTask, filters: FieldFilters): boolean {
    return Object.entries(filters).every(([name, wanted]) =>
      fieldMatches(fieldOf(task.project, name, 'field.'), task.fields?.[name], wanted),
    );
  }

  return {
    get state() {
      return state;
    },
    selectWorkspace(workspaceId) {
      // A sender who reaches exactly one workspace may leave it unnamed.
      const named = workspaceId ?? (spaces.length === 1 ? (spaces[0]?.workspaceId ?? null) : null);
      selected = named;
      space = spaces.find((workspace) => workspace.workspaceId === named) ?? null;
      state = space?.seed ?? emptySeed();
    },
    async workspaces() {
      reachServer();
      return copy(spaces.map(listed));
    },
    async account() {
      reachServer();
      return { name: FIXTURE_ACTOR, deploymentAdmin };
    },
    async createWorkspace(name, options) {
      reachServer();
      return once(options?.idempotencyKey, ['workspace', name], () => {
        if (!deploymentAdmin)
          throw new ApiError("Only the deployment's admins may create a workspace.", 403, 'forbidden');
        const created: FixtureWorkspace = {
          workspaceId: crypto.randomUUID(),
          name: workspaceName(name),
          role: 'owner',
          seed: emptySeed(),
          members: [FIXTURE_USER],
          invitations: [],
        };
        spaces.push(created);
        return listed(created);
      });
    },
    async renameWorkspace(workspaceId, name) {
      reachServer();
      const workspace = spaces.find((row) => row.workspaceId === workspaceId);
      if (!workspace) throw new ApiError('No such workspace.', 404, 'not_found');
      if (workspace.role !== 'owner')
        throw new ApiError('Only an owner of this workspace may do this.', 403, 'insufficient_scope');
      workspace.name = workspaceName(name);
      return listed(workspace);
    },
    async capabilities() {
      reach();
      return { live: true, writable: true, projectSelection: true, reason: null };
    },
    async projects() {
      reach();
      return copy(state.projects);
    },
    async board(key, _signal, fields = {}) {
      reach();
      const { prefix, logicalKey } = project(key);
      for (const name of Object.keys(fields)) fieldOf(key, name, 'field.');
      const since = now() - CLOSED_DAYS * DAY;
      const tasks = state.tasks
        .filter((task) => task.project === key)
        .filter((task) => task.status !== 'closed' || Date.parse(task.closedAt ?? '') >= since)
        .filter((task) => holds(task, fields))
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
        actors: FIXTURE_ACTORS,
      });
    },
    async delivery(key) {
      reach();
      const { prefix, logicalKey } = project(key);
      const stages: readonly (string | undefined)[] = ['built', 'merged'];
      const tasks = state.tasks
        .filter((task) => task.project === key && task.status === 'closed' && stages.includes(task.delivery?.stage))
        .map(withLinks);
      return copy({
        project: logicalKey,
        prefix,
        repo: '',
        readAt: new Date(now()).toISOString(),
        lastSeq: changes.length,
        tasks,
        epics: null,
        actors: FIXTURE_ACTORS,
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
        comments: (state.comments.get(id) ?? []).map((comment) => ({ ...comment, pinned: comment.pinned === true })),
        actors: FIXTURE_ACTORS,
        proposalVersion: task.proposalVersion ?? null,
        parent: parentContext(task),
      });
    },
    async search(text) {
      reach();
      const query = text.trim().toLowerCase();
      if (query === '' || query.length > SEARCH_TEXT)
        invalid(`q must hold 1 to ${SEARCH_TEXT} characters besides spaces`);
      const words = query.split(/\s+/u);
      const since = now() - CLOSED_DAYS * DAY;
      const named = isTaskId(query) ? state.tasks.find((task) => task.id === query) : undefined;
      const matched = state.tasks.filter((task) => {
        if (task === named || (task.status === 'closed' && !(Date.parse(task.closedAt ?? '') >= since))) return false;
        const searched = [task.id, task.title, task.description, task.acceptance, ...task.labels].join('\n');
        return words.every((word) => searched.toLowerCase().includes(word));
      });
      const found = [...(named === undefined ? [] : [named]), ...matched];
      return copy({
        readAt: new Date(now()).toISOString(),
        total: found.length,
        tasks: found.slice(0, SEARCH_PAGE).map((task) => ({ ...withLinks(task), project: task.project })),
      });
    },
    async fields(key) {
      reach();
      const { logicalKey } = project(key);
      return copy({ project: logicalKey, fields: state.fields.get(key) ?? [] });
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
          if (task.assignee !== FIXTURE_ACTOR) endWork(task);
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
        if (edit.assignee !== undefined) {
          const next = edit.assignee === '' ? null : edit.assignee;
          if (next !== task.assignee) endWork(task);
          task.assignee = next;
        }
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
        applyFields(task, edit);
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
    async accept(id, key, met, { reason, idempotencyKey } = {}) {
      reach();
      once(idempotencyKey, ['accept', id, key, [...met], reason ?? null], () => {
        const task = find(id, key);
        if (task.issueType === 'gate')
          throw new ApiError(`${id} is a request to you: approve it instead.`, 409, 'task_refused');
        const criteria = criteriaOf(task.acceptance);
        if (met.some((place) => place < 1 || place > criteria.length))
          throw new ApiError(`${id} has criteria 1 to ${criteria.length}.`, 400, 'invalid_request', 'met');
        close(task, reason ?? ACCEPTED_REASON);
        task.proof = null;
        task.closeAcceptance = {
          by: FIXTURE_ACTOR,
          criteria: criteria.map(({ text }, index) => ({ text, met: met.includes(index + 1) })),
        };
      });
    },
    async dispute(id, key) {
      reach();
      const task = find(id, key);
      const relayedAcceptance = task.closeAcceptance?.relayed !== undefined;
      if ((task.issueType !== 'gate' && !relayedAcceptance) || task.status !== 'closed')
        throw new ApiError(`Task ${id} is not an answer an agent recorded.`, 409, 'task_refused');
      task.status = 'open';
      task.closedAt = null;
      task.closeReason = null;
      task.resolution = null;
      task.closeAcceptance = null;
      task.proof = null;
      touch(task);
    },
    async resolveGate(id, key, reason, options) {
      reach();
      once(options?.idempotencyKey, ['resolve', id, key, reason ?? null], () => {
        const task = find(id, key);
        if (task.issueType !== 'gate' || (task.steps ?? null) !== null)
          throw new ApiError(`Task ${id} is not an approval.`, 409, 'task_refused');
        close(task, reason ? `Approved: ${reason}` : 'Approved');
      });
    },
    async markStep(id, key, marking, options) {
      reach();
      once(options?.idempotencyKey, ['step', id, key, marking], () => {
        const task = find(id, key);
        const steps = task.steps ?? null;
        if (steps === null) throw new ApiError(`${id} has no steps to tick.`, 409, 'task_refused');
        if (task.status === 'closed') throw new ApiError(`${id} is already closed.`, 409, 'task_refused');
        const step = steps[marking.step - 1];
        if (step === undefined)
          throw new ApiError(`${id} has steps 1 to ${steps.length}.`, 400, 'invalid_request', 'step');
        const next = markedStep(step, marking, { by: FIXTURE_ACTOR, at: new Date(now()).toISOString() });
        if (next === step) return;
        task.steps = steps.map((entry, index) => (index === marking.step - 1 ? next : entry));
        if (task.steps.every((entry) => entry.done !== null)) close(task, 'Every step done');
        else touch(task);
      });
    },
    async createProject({ name, prefix }, options) {
      const workspace = owned();
      once(options?.idempotencyKey, ['project', workspace.workspaceId, name, prefix], () => {
        const displayName = name.trim();
        if (displayName === '' || displayName.length > NAME_LIMIT)
          throw new ApiError(`Name must be 1 to ${NAME_LIMIT} characters.`, 400, 'invalid_request', 'name');
        if (!PREFIX.test(prefix))
          throw new ApiError('Prefix must be 1 to 16 lowercase letters or digits.', 400, 'invalid_request', 'prefix');
        const taken = state.projects.find((row) => row.prefix === prefix);
        if (taken)
          throw new ApiError(`Prefix ${prefix} is taken by ${taken.displayName}.`, 409, 'project_exists', 'prefix');
        state.projects.push({ projectId: `p-${prefix}`, logicalKey: prefix, displayName, prefix, deploys: false });
        state.fields.set(prefix, []);
      });
    },
    async setDeploys(key, deploys) {
      owned();
      project(key).deploys = deploys;
    },
    async members() {
      const { members, invitations } = owned();
      return copy({ members, invitations });
    },
    async invite({ githubLogin, role }, options) {
      const workspace = owned();
      once(options?.idempotencyKey, ['invite', workspace.workspaceId, githubLogin, role], () => {
        if (!GITHUB_LOGIN.test(githubLogin))
          throw new ApiError('No GitHub username has that form.', 400, 'invalid_request', 'githubLogin');
        const login = githubLogin.toLowerCase();
        if (workspace.members.some((member) => member.githubLogin?.toLowerCase() === login))
          throw new ApiError(`${githubLogin} is already a member.`, 409, 'already_member', 'githubLogin');
        if (workspace.invitations.some((invitation) => invitation.githubLogin.toLowerCase() === login))
          throw new ApiError(`${githubLogin} is already invited.`, 409, 'already_invited', 'githubLogin');
        workspace.invitations.push({
          invitationId: crypto.randomUUID(),
          githubLogin,
          role,
          createdAt: new Date(now()).toISOString(),
        });
      });
    },
    async revokeInvitation(invitationId) {
      const workspace = owned();
      const at = workspace.invitations.findIndex((invitation) => invitation.invitationId === invitationId);
      if (at < 0) throw new ApiError('The invitation: not found.', 404, 'not_found');
      workspace.invitations.splice(at, 1);
    },
    async removeMember(userId) {
      const workspace = owned();
      const member = workspace.members.find((row) => row.userId === userId);
      if (!member) throw new ApiError('The member: not found.', 404, 'not_found');
      if (member.role === 'owner' && workspace.members.filter((row) => row.role === 'owner').length === 1)
        throw new ApiError('A workspace keeps at least one owner.', 409, 'last_owner');
      workspace.members.splice(workspace.members.indexOf(member), 1);
    },
    async apps() {
      return copy(reach().apps ?? []);
    },
    async registerApp({ name, redirectUris }, options) {
      const workspace = owned();
      return once(options?.idempotencyKey, ['app', workspace.workspaceId, name, redirectUris], () => {
        const trimmed = name.trim();
        if (!APP_NAME.test(trimmed))
          throw new ApiError(
            'Name is 1 to 64 letters, digits, spaces, dots, dashes or underscores.',
            400,
            'invalid_request',
            'name',
          );
        if (redirectUris.length === 0 || !redirectUris.every(redirectAddress))
          throw new ApiError(
            'Use an https address with a path, such as https://app.example.com/callback.',
            400,
            'invalid_request',
            'redirectUris',
          );
        made += 1;
        const app: ConnectedApp = {
          clientId: `c-fixture-${made}`,
          name: trimmed,
          redirectUris: [...redirectUris],
          createdAt: new Date(now()).toISOString(),
          connectedAt: null,
        };
        workspace.apps = [app, ...(workspace.apps ?? [])];
        return copy(app);
      });
    },
    async revokeApp(clientId) {
      const app = (reach().apps ?? []).find((row) => row.clientId === clientId);
      if (!app || app.connectedAt === null)
        throw new ApiError('You are not signed in to such an app here.', 404, 'not_found');
      app.connectedAt = null;
    },
    async removeApp(clientId) {
      const workspace = owned();
      const apps = workspace.apps ?? [];
      if (!apps.some((row) => row.clientId === clientId))
        throw new ApiError('This workspace has no such app.', 404, 'not_found');
      workspace.apps = apps.filter((row) => row.clientId !== clientId);
    },
    async githubWebhook() {
      return webhookOf(owned());
    },
    /** Saves as the Worker does: the rules it checks, and settings without a secret only once one is saved. */
    async saveGitHubWebhook({ secret, deployChecks }) {
      const workspace = owned();
      if (secret !== undefined && !WEBHOOK_SECRET.test(secret))
        throw new ApiError(
          'secret is 32 to 255 letters, digits and punctuation, with no spaces, as you enter it in GitHub',
          400,
          'invalid_request',
          'secret',
        );
      const names = deployChecks?.map((name) => name.trim());
      if (names !== undefined && (names.length > DEPLOY_CHECKS || names.some((name) => name.length === 0)))
        throw new ApiError(
          `deployChecks is a list of at most ${DEPLOY_CHECKS} names`,
          400,
          'invalid_request',
          'deployChecks',
        );
      const kept = secret ?? workspace.github?.secret;
      if (kept === undefined)
        throw new ApiError(
          'save a secret first: GitHub signs every delivery with it',
          400,
          'invalid_request',
          'secret',
        );
      workspace.github = {
        secret: kept,
        deployChecks: names === undefined ? (workspace.github?.deployChecks ?? []) : [...new Set(names)],
        updatedAt: new Date(now()).toISOString(),
      };
      return webhookOf(workspace);
    },
    /** Removes the webhook, refused as the Worker refuses one when none is saved. */
    async removeGitHubWebhook() {
      const workspace = owned();
      if (workspace.github === undefined) throw new ApiError('this workspace has no GitHub webhook', 404, 'not_found');
      delete workspace.github;
    },
  };
}

/** The webhook as the Worker shows it: where GitHub sends, and never the secret. */
function webhookOf(workspace: FixtureWorkspace) {
  const origin = globalThis.location?.origin ?? 'https://ntasks.example.com';
  return {
    url: `${origin}/api/github/${workspace.workspaceId}`,
    secretSaved: workspace.github !== undefined,
    deployChecks: [...(workspace.github?.deployChecks ?? [])],
    updatedAt: workspace.github?.updatedAt ?? null,
  };
}
