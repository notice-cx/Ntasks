/**
 * A seed: projects and tasks written by hand or by another program, such as a
 * product demo's invented tasks, each task with the dated changes it went
 * through. The seed becomes the same rows an import from Beads does, with a
 * history that rebuilds each task, so a store loaded from it reads like one
 * whose tasks were filed, claimed, commented on and closed through the API.
 * tools/migrate/README.md describes the file.
 */
import { createHash } from 'node:crypto';
import {
  isDependencyType,
  isTaskId,
  isTaskResolution,
  isTaskStatus,
  isTaskType,
  TASK_LIMITS,
  TASK_PRIORITY,
  type CommentRow,
  type DependencyType,
  type EdgeRow,
  type EventRow,
  type Json,
  type JsonObject,
  type LabelRow,
  type ProjectRow,
  type TaskResolution,
  type TaskRow,
  type TaskStatus,
  type TaskType,
} from '@ntasks/domain';
import { taskEvents, type CommentRecord, type EventRecord, type TaskHistory, type Version } from './history.ts';
import { excerpt, isJsonObject, sameJson } from './json.ts';
import { insertOrder, sequence, sortRefusals, taskRow, waitingLoops, type ImportPlan, type Refusal } from './plan.ts';
import { sortLinks, type CloseState, type LinkState, type TaskState } from './task-state.ts';

export const SEED_FORMAT = 'ntasks-seed-v1';

/** Times are UTC ISO 8601 with milliseconds, as the store keeps them. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** Whether the value is a time in that form that names a real instant: one
 * that reads back as itself, so no 30 February or 25 o'clock. */
function isTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    TIME.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
const PREFIX = /^[a-z0-9]{1,32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** The longest name the schema stores, such as an actor, a label or a model. */
const NAME_LIMIT = 255;
const TITLE_LIMIT = 1024;
const TEXT_LIMIT = 65_536;

const PROJECT_FIELDS = new Set(['id', 'key', 'name', 'prefix', 'createdAt', 'deploys']);
const TASK_FIELDS = new Set([
  'id',
  'project',
  'type',
  'title',
  'description',
  'acceptance',
  'notes',
  'design',
  'priority',
  'parent',
  'labels',
  'links',
  'metadata',
  'awaitsPerson',
  'choices',
  'dueAt',
  'createdAt',
  'createdBy',
  'createdModel',
  'changes',
  'comments',
]);
const CHANGE_FIELDS = new Set([
  'at',
  'by',
  'model',
  'status',
  'assignee',
  'priority',
  'deferUntil',
  'metadata',
  'close',
]);
const CLOSE_FIELDS = new Set(['reason', 'resolution']);
const COMMENT_FIELDS = new Set(['author', 'text', 'at']);
const LINK_FIELDS = new Set(['type', 'to']);

/** The id a seeded comment gets: a UUID, as the engine gives one, fixed by its task and place so a seed always makes the same rows. */
function commentId(taskId: string, index: number): string {
  const hex = createHash('sha256').update(`${taskId}\n${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[Number.parseInt(hex[16]!, 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The rows a seed file makes, or every reason it is refused. Nothing is
 * planned unless the whole seed maps.
 */
export function planSeed(value: unknown): { readonly plan: ImportPlan | null; readonly refusals: readonly Refusal[] } {
  const refusals: Refusal[] = [];
  const refuse = (subject: string, reason: string) => refusals.push({ subject, reason });
  if (!isJsonObject(value) || value.format !== SEED_FORMAT) {
    return { plan: null, refusals: [{ subject: 'seed', reason: `format is not ${SEED_FORMAT}` }] };
  }
  for (const key of Object.keys(value))
    if (!['format', 'projects', 'tasks'].includes(key)) refuse('seed', `${key} is not a field of a seed`);
  const projectsIn = Array.isArray(value.projects) ? value.projects : [];
  const tasksIn = Array.isArray(value.tasks) ? value.tasks : [];
  if (!Array.isArray(value.projects) || projectsIn.length === 0)
    refuse('seed', 'projects is a list of at least one project');
  if (!Array.isArray(value.tasks)) refuse('seed', 'tasks is a list');

  const projects: ProjectRow[] = [];
  const prefixOf = new Map<string, string>();
  const seen = { id: new Set<string>(), key: new Set<string>(), prefix: new Set<string>() };
  for (const [index, entry] of projectsIn.entries()) {
    const subject =
      isJsonObject(entry) && typeof entry.key === 'string' ? `project ${entry.key}` : `project ${index + 1}`;
    if (!isJsonObject(entry)) {
      refuse(subject, 'a project is an object');
      continue;
    }
    for (const key of Object.keys(entry))
      if (!PROJECT_FIELDS.has(key)) refuse(subject, `${key} is not a field of a project`);
    const { id, key, name, prefix, createdAt, deploys } = entry;
    if (typeof id !== 'string' || !UUID.test(id)) refuse(subject, 'id is a lowercase UUID');
    if (typeof key !== 'string' || key.length < 1 || key.length > 128) refuse(subject, 'key is 1 to 128 characters');
    if (typeof name !== 'string' || name.length < 1 || name.length > 128)
      refuse(subject, 'name is 1 to 128 characters');
    if (typeof prefix !== 'string' || !PREFIX.test(prefix))
      refuse(subject, 'prefix is 1 to 32 lowercase letters and digits');
    if (!isTime(createdAt)) refuse(subject, 'createdAt is a UTC time with milliseconds');
    if (deploys !== undefined && typeof deploys !== 'boolean') refuse(subject, 'deploys is true or false');
    for (const [field, held] of [
      ['id', id],
      ['key', key],
      ['prefix', prefix],
    ] as const) {
      if (typeof held !== 'string') continue;
      if (seen[field].has(held)) refuse(subject, `another project has the same ${field}, ${held}`);
      seen[field].add(held);
    }
    if (typeof id !== 'string' || typeof key !== 'string' || typeof name !== 'string') continue;
    if (typeof prefix !== 'string' || typeof createdAt !== 'string') continue;
    prefixOf.set(prefix, id);
    projects.push({ id, key, name, prefix, created_at: createdAt, ...(deploys === true ? { deploys: 1 } : {}) });
  }

  interface Seeded {
    readonly history: TaskHistory;
    readonly createdAt: string;
    readonly comments: CommentRecord[];
  }
  const seeded = new Map<string, Seeded>();
  for (const [index, entry] of tasksIn.entries()) {
    const subject = isJsonObject(entry) && typeof entry.id === 'string' ? entry.id : `task ${index + 1}`;
    const problem = (reason: string) => refuse(subject, reason);
    if (!isJsonObject(entry)) {
      problem('a task is an object');
      continue;
    }
    const task = readTask(entry, prefixOf, problem);
    if (task === null) continue;
    if (seeded.has(task.history.id)) problem('another task has the same id');
    seeded.set(task.history.id, task);
  }

  const states = new Map<string, TaskState>();
  for (const [taskId, { history }] of seeded) states.set(taskId, history.current.state!);
  for (const [taskId, state] of states) {
    const named: [string, string][] = [
      ...(state.parentId === null ? [] : [[state.parentId, 'its parent'] as [string, string]]),
      ...state.dependencies.map((link): [string, string] => [link.taskId, `its ${link.type} link`]),
    ];
    for (const [other, what] of named)
      if (!states.has(other)) refuse(taskId, `${what} names ${other}, which is not a task in the seed`);
  }
  for (const taskId of waitingLoops(states))
    refuse(taskId, 'it is in a loop of tasks that wait on each other through blocks links or parents');
  const order = insertOrder(states);
  if (order === null) refuse('seed', 'parents form a loop');
  if (refusals.length > 0 || order === null) return { plan: null, refusals: sortRefusals(refusals) };

  const tasks: TaskRow[] = [];
  const labels: LabelRow[] = [];
  const edges: EdgeRow[] = [];
  const comments: CommentRow[] = [];
  const perTask: EventRecord[][] = [];
  for (const taskId of order) {
    const { history, createdAt, comments: notes } = seeded.get(taskId)!;
    const state = history.current.state!;
    perTask.push(taskEvents(history, createdAt, notes, []));
    tasks.push(taskRow(state, history.versions.length, createdAt, history.versions.at(-1)!.at));
    for (const label of state.labels) labels.push({ task_id: taskId, label });
    for (const link of state.dependencies)
      edges.push({
        task_id: taskId,
        depends_on_id: link.taskId,
        type: link.type,
        created_at: createdAt,
        created_by: state.filedBy,
      });
    for (const comment of notes)
      comments.push({
        id: comment.id,
        task_id: taskId,
        author: comment.author,
        text: comment.text,
        created_at: comment.createdAt,
      });
  }
  const events = sequence(perTask).map((event, index): EventRow => ({
    seq: index + 1,
    task_id: event.taskId,
    project_id: event.projectId,
    version: event.version,
    kind: event.kind,
    actor: event.actor,
    model: event.model,
    at: event.at,
    changes: JSON.stringify(event.changes),
  }));
  return {
    plan: {
      projects,
      tasks,
      task_labels: labels,
      task_edges: edges,
      task_external_links: [],
      task_comments: comments,
      task_events: events,
    },
    refusals: [],
  };
}

/** Text of at most `max` characters, or undefined when it is not text. */
function textUpTo(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max && !value.includes('\u0000') ? value : undefined;
}

/** A name, such as an actor or a model: 1 to 255 characters. */
function nameOf(value: unknown): string | undefined {
  const text = textUpTo(value, NAME_LIMIT);
  return text !== undefined && text.trim().length > 0 ? text : undefined;
}

function priorityOf(value: unknown): number | undefined {
  return Number.isInteger(value) &&
    (value as number) >= TASK_PRIORITY.highest &&
    (value as number) <= TASK_PRIORITY.lowest
    ? (value as number)
    : undefined;
}

/** One task of the seed as its history: a version at its creation and one for each change, or null when it is refused. */
function readTask(
  entry: JsonObject,
  prefixOf: ReadonlyMap<string, string>,
  problem: (reason: string) => void,
): { history: TaskHistory; createdAt: string; comments: CommentRecord[] } | null {
  const before = { count: 0 };
  const fail = (reason: string) => {
    before.count += 1;
    problem(reason);
  };
  for (const key of Object.keys(entry)) if (!TASK_FIELDS.has(key)) fail(`${key} is not a field of a task`);
  const id = entry.id;
  if (typeof id !== 'string' || !isTaskId(id)) fail('id is a task id, such as web-a1b2');
  const prefix = typeof id === 'string' ? id.slice(0, id.indexOf('-')) : '';
  const projectId = prefixOf.get(prefix);
  if (entry.project !== undefined && entry.project !== prefix && entry.project !== projectId)
    fail(`project ${excerpt(entry.project as Json)} is not the project of its id's prefix, ${prefix}`);
  if (typeof id === 'string' && projectId === undefined) fail(`no project in the seed has the prefix ${prefix}`);
  const type = entry.type ?? 'task';
  if (typeof type !== 'string' || !isTaskType(type)) fail(`type ${excerpt(type as Json)} is not a task type`);
  const title = textUpTo(entry.title, TITLE_LIMIT);
  if (title === undefined || title.trim() === '') fail(`title is 1 to ${TITLE_LIMIT} characters`);
  const texts: Record<'description' | 'acceptance' | 'notes' | 'design', string> = {
    description: '',
    acceptance: '',
    notes: '',
    design: '',
  };
  for (const field of ['description', 'acceptance', 'notes', 'design'] as const) {
    const value = entry[field];
    if (value === undefined) continue;
    const text = textUpTo(value, TEXT_LIMIT);
    if (text === undefined) fail(`${field} is text of at most ${TEXT_LIMIT} characters`);
    else texts[field] = text;
  }
  const priority = entry.priority === undefined ? TASK_PRIORITY.default : priorityOf(entry.priority);
  if (priority === undefined) fail('priority is a whole number from 0 to 4');
  const parent = entry.parent ?? null;
  if (parent !== null && (typeof parent !== 'string' || !isTaskId(parent))) fail('parent is a task id');
  const labelsIn = entry.labels ?? [];
  const labels: string[] = [];
  if (!Array.isArray(labelsIn)) fail('labels is a list');
  else
    for (const label of labelsIn) {
      const text = textUpTo(label, TASK_LIMITS.label);
      if (text === undefined || text.trim() === '')
        fail(`label ${excerpt(label)} is 1 to ${TASK_LIMITS.label} characters`);
      else if (!labels.includes(text)) labels.push(text);
    }
  const linksIn = entry.links ?? [];
  const links: LinkState[] = [];
  if (!Array.isArray(linksIn)) fail('links is a list');
  else
    for (const link of linksIn) {
      if (!isJsonObject(link) || Object.keys(link).some((key) => !LINK_FIELDS.has(key))) {
        fail('a link is { "type", "to" }');
        continue;
      }
      if (typeof link.type !== 'string' || !isDependencyType(link.type))
        fail(`link type ${excerpt(link.type)} is not one of Ntasks's`);
      else if (typeof link.to !== 'string' || !isTaskId(link.to)) fail('a link names a task id in to');
      else if (link.to === id) fail('a task does not link to itself');
      else if (links.some((other) => other.taskId === link.to))
        fail(`two links name ${link.to}; a task links to another once`);
      else links.push({ taskId: link.to, type: link.type as DependencyType });
    }
  const metadata = entry.metadata ?? {};
  if (!isJsonObject(metadata)) fail('metadata is an object');
  const awaitsPerson = entry.awaitsPerson ?? false;
  if (typeof awaitsPerson !== 'boolean') fail('awaitsPerson is true or false');
  else if (awaitsPerson && type !== 'gate') fail('only a gate awaits a person');
  const choices = entry.choices ?? null;
  if (choices !== null && !isJsonObject(choices)) fail('choices is an object');
  const dueAt = entry.dueAt ?? null;
  if (dueAt !== null && !isTime(dueAt)) fail('dueAt is a UTC time with milliseconds');
  const createdAt = entry.createdAt;
  if (!isTime(createdAt)) fail('createdAt is a UTC time with milliseconds');
  const createdBy = nameOf(entry.createdBy);
  if (createdBy === undefined) fail(`createdBy is 1 to ${NAME_LIMIT} characters`);
  const createdModel = entry.createdModel === undefined ? null : (nameOf(entry.createdModel) ?? null);
  if (entry.createdModel !== undefined && createdModel === null) fail(`createdModel is 1 to ${NAME_LIMIT} characters`);
  if (before.count > 0) return null;

  const first: TaskState = {
    id: id as string,
    projectId: projectId!,
    parentId: parent as string | null,
    type: type as TaskType,
    awaitType: awaitsPerson === true ? 'human' : null,
    status: 'open',
    priority: priority!,
    title: title!,
    ...texts,
    estimateMinutes: null,
    assignee: null,
    assigneeModel: null,
    startedAt: null,
    deferUntil: null,
    dueAt: dueAt as string | null,
    choices: choices as JsonObject | null,
    choice: null,
    metadata: metadata as JsonObject,
    labels: [...labels].sort(),
    dependencies: sortLinks(links),
    externalLinks: [],
    fields: {},
    close: null,
    filedBy: createdBy!,
    filedModel: createdModel,
  };
  const versions: Version[] = [{ state: first, at: createdAt as string, committer: createdBy! }];
  const changesIn = entry.changes ?? [];
  if (!Array.isArray(changesIn)) {
    fail('changes is a list');
    return null;
  }
  for (const [index, change] of changesIn.entries()) {
    const which = `change ${index + 1}`;
    const previous = versions.at(-1)!;
    const next = applyChange(previous, change, (reason) => fail(`${which}: ${reason}`));
    if (next === null) continue;
    if (sameJson(next.state, previous.state)) fail(`${which} changes nothing`);
    else versions.push(next);
  }
  const commentsIn = entry.comments ?? [];
  const comments: CommentRecord[] = [];
  if (!Array.isArray(commentsIn)) fail('comments is a list');
  else
    for (const [index, comment] of commentsIn.entries()) {
      const which = `comment ${index + 1}`;
      if (!isJsonObject(comment) || Object.keys(comment).some((key) => !COMMENT_FIELDS.has(key))) {
        fail(`${which} is { "author", "text", "at" }`);
        continue;
      }
      const author = nameOf(comment.author);
      const text = textUpTo(comment.text, 4096);
      if (author === undefined) fail(`${which}: author is 1 to ${NAME_LIMIT} characters`);
      if (text === undefined || text.trim() === '') fail(`${which}: text is 1 to 4096 characters`);
      if (!isTime(comment.at)) fail(`${which}: at is a UTC time with milliseconds`);
      else if (comment.at < (createdAt as string)) fail(`${which}: at is before the task was created`);
      else if (author !== undefined && text !== undefined)
        comments.push({
          id: commentId(id as string, index),
          taskId: id as string,
          author,
          text,
          createdAt: comment.at,
        });
    }
  for (let index = 1; index < comments.length; index += 1)
    if (comments[index]!.createdAt < comments[index - 1]!.createdAt) fail('comments are oldest first');
  if (before.count > 0) return null;
  const current = versions.at(-1)!.state;
  return {
    history: {
      id: id as string,
      current: {
        state: current,
        createdAt: createdAt as string,
        updatedAt: versions.at(-1)!.at,
        relatedRefs: [],
        problems: [],
      },
      links: [],
      versions,
      problems: [],
    },
    createdAt: createdAt as string,
    comments,
  };
}

/** The version one change makes of the version before it, or null when the change is refused. */
function applyChange(previous: Version, change: unknown, fail: (reason: string) => void): Version | null {
  if (!isJsonObject(change)) {
    fail('a change is an object');
    return null;
  }
  let failed = false;
  const refuse = (reason: string) => {
    failed = true;
    fail(reason);
  };
  for (const key of Object.keys(change)) if (!CHANGE_FIELDS.has(key)) refuse(`${key} is not a field of a change`);
  const { at, by } = change;
  const actor = nameOf(by);
  if (!isTime(at)) refuse('at is a UTC time with milliseconds');
  else if (at < previous.at) refuse(`at is before the change before it, ${previous.at}`);
  if (actor === undefined) refuse(`by is 1 to ${NAME_LIMIT} characters`);
  const model = change.model === undefined ? null : (nameOf(change.model) ?? null);
  if (change.model !== undefined && model === null) refuse(`model is 1 to ${NAME_LIMIT} characters`);
  const state: { -readonly [K in keyof TaskState]: TaskState[K] } = { ...previous.state };
  if (change.status !== undefined) {
    if (typeof change.status !== 'string' || !isTaskStatus(change.status))
      refuse(`status ${excerpt(change.status)} is not a task status`);
    else state.status = change.status as TaskStatus;
  }
  if (change.assignee !== undefined) {
    const assignee = change.assignee === null ? null : nameOf(change.assignee);
    if (assignee === undefined) refuse(`assignee is 1 to ${NAME_LIMIT} characters, or null`);
    else {
      state.assignee = assignee;
      // A model is known for the assignee only when the assignee is the one making the change: a claim.
      state.assigneeModel = assignee !== null && assignee === actor ? model : null;
    }
  }
  if (change.priority !== undefined) {
    const priority = priorityOf(change.priority);
    if (priority === undefined) refuse('priority is a whole number from 0 to 4');
    else state.priority = priority;
  }
  if (change.deferUntil !== undefined) {
    if (change.deferUntil !== null && !isTime(change.deferUntil))
      refuse('deferUntil is a UTC time with milliseconds, or null');
    else state.deferUntil = change.deferUntil;
  }
  if (change.metadata !== undefined) {
    if (!isJsonObject(change.metadata)) refuse('metadata is an object');
    else state.metadata = change.metadata;
  }
  const closing = state.status === 'closed' && previous.state.status !== 'closed';
  if (change.close !== undefined && !closing)
    refuse('close is given only with the status closed, on a task that is not closed');
  if (closing) {
    const close = change.close;
    if (!isJsonObject(close) || Object.keys(close).some((key) => !CLOSE_FIELDS.has(key))) {
      refuse('closing takes close: { "reason", "resolution" }');
    } else {
      const reason = textUpTo(close.reason, 2048);
      const resolution = close.resolution ?? 'done';
      if (reason === undefined || reason.trim() === '') refuse('close.reason is 1 to 2048 characters');
      if (typeof resolution !== 'string' || !isTaskResolution(resolution) || resolution === 'duplicate')
        refuse(`close.resolution ${excerpt(resolution)} is a resolution other than duplicate`);
      else if (reason !== undefined && typeof at === 'string')
        state.close = {
          at,
          reason,
          resolution: resolution as TaskResolution,
          duplicateOf: null,
          by: actor ?? null,
          model,
        } satisfies CloseState;
    }
  } else if (state.status !== 'closed') {
    state.close = null;
  }
  if (state.status === 'in_progress' && state.startedAt === null && typeof at === 'string') state.startedAt = at;
  if (failed) return null;
  return { state, at: at as string, committer: actor! };
}
