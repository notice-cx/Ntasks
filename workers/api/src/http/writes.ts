/**
 * The HTTP writes the web app uses: filing, changing, commenting on and
 * closing a task. Each route and body has the shape NoticeOS's Tasks API
 * took (scripts/hosted-task-http.mts there), and runs the same write as the
 * MCP tool that does the same thing (task-writes.ts), checked by the same
 * rules (args.ts). An Idempotency-Key header makes a write safe to retry.
 */
import {
  IDEMPOTENCY_KEY,
  TASK_LIMITS,
  TaskRefused,
  WORK_DETAILS,
  type DefineFieldInput,
  type JsonObject,
  type Project,
  type TaskStatus,
} from '@ntasks/domain';
import {
  addsOrRemoves,
  assigneeArg,
  cardArg,
  choiceArg,
  closingArgs,
  deferArg,
  emptyIsNone,
  estimateArg,
  externalLinksArg,
  fieldsArg,
  instantArg,
  labelsArg,
  only,
  priorityArg,
  projectArg,
  refuse,
  setOrTakeOff,
  sourceMetadataArg,
  taskArg,
  textArg,
  typeArg,
  urlsArg,
  workArgs,
  type Args,
} from '../args.ts';
import { strictJson } from '../mcp/protocol.ts';
import { TASK_CHANGE_CLASSES } from '../noticeos-fields.ts';
import {
  closeTask,
  commentOnTask,
  createTask,
  defineField,
  retireField,
  updateTask,
  type NewTask,
  type RetryRequest,
  type TaskChange,
  type WriteContext,
} from '../task-writes.ts';
import { linksSeenBy } from '../lookup.ts';
import { shippedArgs } from '../delivery.ts';
import { commentView, fieldView, webTasks } from '../views.ts';
import { readBoundedJsonText } from './json-body.ts';
import { HttpRefused, invalidRequest, json, queryOf } from './respond.ts';

/** The header a write's retry key arrives in. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
/** The largest body a write takes. */
const BODY_BYTES = 32 * 1024;
const STATUSES: readonly Exclude<TaskStatus, 'closed'>[] = ['open', 'in_progress', 'blocked', 'deferred'];

/** The fields an update may change, as the capabilities route lists them. */
export const EDITABLE_FIELDS: readonly string[] = Object.freeze([
  'status',
  'priority',
  'title',
  'description',
  'claim',
  'assignee',
  'parent',
  'defer',
  'acceptance',
  'notes',
  'design',
  'estimateMinutes',
  'dueAt',
  'addLabels',
  'removeLabels',
  'addExternalLinks',
  'removeExternalLinks',
  'fields',
  'card',
  'changeClass',
]);
/** The writes this API offers any sender that may change a project. */
export const WRITE_OPERATIONS: readonly string[] = Object.freeze(['create', 'update', 'comment', 'close']);
/** The decisions it offers a person signed in to the web app, in NoticeOS's names. */
export const DECISION_OPERATIONS: readonly string[] = Object.freeze([
  'respond',
  'dismiss',
  'resolve',
  'choose',
  'dispute',
]);

/** A write's body and its retry key. The body is one JSON object, with no key twice. */
export async function writeOf(
  request: Request,
  url: URL,
  operation: string,
  route: Args,
): Promise<{ readonly body: Args; readonly retry: (body: Args) => RetryRequest | undefined }> {
  queryOf(url, []);
  const key = request.headers.get(IDEMPOTENCY_HEADER);
  if (key !== null && !IDEMPOTENCY_KEY.test(key))
    invalidRequest(
      `the ${IDEMPOTENCY_HEADER} header must be 8 to 128 letters, digits, dots, underscores, colons or hyphens`,
    );
  let body: unknown;
  try {
    body = strictJson(await readBoundedJsonText(request, BODY_BYTES));
  } catch {
    invalidRequest(`the body must be one JSON object of at most ${BODY_BYTES / 1024} KB, sent as application/json`);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    invalidRequest('the body must be one JSON object');
  return {
    body: body as Args,
    // The route names the task, so a key sent again for another task is another request.
    retry: (sent) => (key === null ? undefined : { operation, key, request: { ...route, ...sent } }),
  };
}

/** A card's kill date is the task's due date, so a write gives one of the two. */
function oneDueDate(dueAt: string | null | undefined, card: JsonObject | null | undefined): void {
  if (dueAt !== undefined && card?.kill !== undefined)
    refuse("invalid arguments: dueAt (a card's kill date is the due date; send one of them)");
}

/** POST /api/tasks: files a task. Answers its id and its project's key. */
export async function createRoute(context: WriteContext, url: URL, request: Request): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'create_task', {});
  only(body, [
    'projectId',
    'title',
    'description',
    'type',
    'priority',
    'labels',
    'parent',
    'acceptance',
    'notes',
    'design',
    'estimateMinutes',
    'dueAt',
    'externalLinks',
    'fields',
    'metadata',
    'card',
    'changeClass',
  ]);
  const projectId = projectArg(body, 'projectId', 'http');
  const fields = {
    title: textArg(body, 'title', TASK_LIMITS.title, true)!,
    description: textArg(body, 'description', TASK_LIMITS.description, false, true),
    type: typeArg(body, 'type', 'http'),
    priority: priorityArg(body),
    labels: labelsArg(body, 'labels'),
    parent: body.parent === undefined ? undefined : taskArg(body, 'parent'),
    acceptance: textArg(body, 'acceptance', TASK_LIMITS.acceptance, false, true),
    notes: textArg(body, 'notes', TASK_LIMITS.notes, false, true),
    design: textArg(body, 'design', TASK_LIMITS.design, false, true),
    estimateMinutes: estimateArg(body, 'estimateMinutes'),
    dueAt: instantArg(body, 'dueAt'),
    externalLinks: externalLinksArg(body, 'externalLinks'),
    fields: fieldsArg(body, 'fields'),
    metadata: sourceMetadataArg(body),
    card: cardArg(body),
    changeClass: choiceArg(body, 'changeClass', TASK_CHANGE_CLASSES),
  };
  oneDueDate(fields.dueAt, fields.card);
  const task = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as unknown as NewTask;
  const { project, result } = await createTask(context, projectId, task, undefined, retry(body));
  return json({ id: result.task.id, project: project.key });
}

/** PATCH /api/tasks/:id: changes a task's fields, or with `claim`, takes it. */
export async function updateRoute(
  context: WriteContext,
  url: URL,
  request: Request,
  taskId: string,
): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'update_task', { task: taskId });
  // A claim also takes the helper the sender works through and its work details.
  only(body, ['projectId', ...EDITABLE_FIELDS, 'for', 'work']);
  const projectId = projectArg(body, 'projectId', 'http');
  if (body.claim !== undefined) {
    if (body.claim !== true) refuse('invalid arguments: claim (true)');
    const others = ['assignee', 'status', 'card', 'changeClass'].filter((name) => body[name] !== undefined);
    if (others.length > 0) refuse(`invalid arguments: claim (on its own, without ${others.join(', ')})`);
  } else if (body.for !== undefined || body.work !== undefined) {
    refuse('invalid arguments: for and work (with claim: true; they describe the claim)');
  }
  // Only a left-out work is none: null is not an object of work details, and is refused.
  const details = body.work === undefined ? {} : body.work;
  if (details === null || typeof details !== 'object' || Array.isArray(details))
    refuse('invalid arguments: work (an object of work details)');
  only(details as Args, WORK_DETAILS);
  const fields: TaskChange = {
    ...workArgs(details as Args, 'work.', body),
    claim: body.claim === true ? true : undefined,
    status: choiceArg(body, 'status', STATUSES),
    priority: priorityArg(body),
    title: textArg(body, 'title', TASK_LIMITS.title, false),
    description: textArg(body, 'description', TASK_LIMITS.description, false, true),
    assignee: assigneeArg(body),
    parent: body.parent === '' ? null : body.parent === undefined ? undefined : taskArg(body, 'parent'),
    defer: emptyIsNone(deferArg(body)),
    acceptance: textArg(body, 'acceptance', TASK_LIMITS.acceptance, false, true),
    notes: textArg(body, 'notes', TASK_LIMITS.notes, false, true),
    design: textArg(body, 'design', TASK_LIMITS.design, false, true),
    estimateMinutes: estimateArg(body, 'estimateMinutes', true),
    dueAt: body.dueAt === null ? null : instantArg(body, 'dueAt'),
    addLabels: labelsArg(body, 'addLabels', 1),
    removeLabels: labelsArg(body, 'removeLabels', 1),
    addExternalLinks: externalLinksArg(body, 'addExternalLinks', 1),
    removeExternalLinks: urlsArg(body, 'removeExternalLinks'),
    fields: fieldsArg(body, 'fields', true),
    card: body.card === null ? null : cardArg(body),
    changeClass: body.changeClass === null ? null : choiceArg(body, 'changeClass', TASK_CHANGE_CLASSES),
  };
  const change = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as TaskChange;
  if (Object.keys(change).length === 0) refuse('invalid arguments: name at least one field to change');
  setOrTakeOff(body, ['card', 'changeClass']);
  oneDueDate(change.dueAt, change.card);
  addsOrRemoves(change.addExternalLinks, change.removeExternalLinks, 'addExternalLinks and removeExternalLinks');
  const { result } = await updateTask(context, projectId, taskId, change, undefined, retry(body));
  const [task] = await webTasks([(await linksSeenBy(context)).task(result.task)]);
  return json({ task });
}

/** POST /api/tasks/:id/comments: adds a comment. */
export async function commentRoute(
  context: WriteContext,
  url: URL,
  request: Request,
  taskId: string,
): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'comment_on_task', { task: taskId });
  only(body, ['projectId', 'text']);
  const projectId = projectArg(body, 'projectId', 'http');
  const text = textArg(body, 'text', TASK_LIMITS.comment, true)!;
  const { comment } = await commentOnTask(context, projectId, taskId, text, retry(body));
  return json({ comment: commentView(comment) });
}

/** POST /api/fields: defines a custom field in a project. */
export async function defineFieldRoute(context: WriteContext, url: URL, request: Request): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'define_field', {});
  only(body, ['projectId', 'key', 'name', 'type', 'options']);
  const projectId = projectArg(body, 'projectId', 'http');
  // The engine checks each part and names the one at fault.
  const input = {
    key: body.key,
    name: body.name,
    type: body.type,
    ...(body.options === undefined ? {} : { options: body.options }),
  } as DefineFieldInput;
  const { field } = await defineField(context, projectId, input, retry(body));
  return json({ field: fieldView(field) });
}

/** POST /api/fields/:key/retire: retires a custom field, which then takes no new values. */
export async function retireFieldRoute(
  context: WriteContext,
  url: URL,
  request: Request,
  key: string,
): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'retire_field', { field: key });
  only(body, ['projectId']);
  const projectId = projectArg(body, 'projectId', 'http');
  const { field } = await retireField(context, projectId, key, retry(body));
  return json({ field: fieldView(field) });
}

/** Whether text is a project's name or key: one line of 1 to 128 characters, as the engine keeps them. */
function oneLine(text: string): boolean {
  return text.length >= 1 && text.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(text);
}

/**
 * POST /api/tasks/projects: creates a project in the workspace, from its
 * `name` and `prefix`, and optionally the `key` people know it by, which is
 * the prefix when left out. A field at fault is named in the refusal. It
 * keeps no retry record: sent again with an idempotency key, it answers the
 * project that already has exactly this name, prefix and key.
 */
export async function createProjectRoute(context: WriteContext, url: URL, request: Request): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'create_project', {});
  only(body, ['name', 'prefix', 'key']);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!oneLine(name)) throw new HttpRefused(400, 'invalid_request', 'name is one line of 1 to 128 characters', 'name');
  const prefix = typeof body.prefix === 'string' ? body.prefix : '';
  if (!/^[a-z0-9]{1,32}$/u.test(prefix)) {
    const detail = 'prefix is 1 to 32 lowercase letters or digits, with no hyphen; it starts every task id';
    throw new HttpRefused(400, 'invalid_request', detail, 'prefix');
  }
  const key = body.key === undefined ? prefix : typeof body.key === 'string' ? body.key.trim() : '';
  if (!oneLine(key)) throw new HttpRefused(400, 'invalid_request', 'key is one line of 1 to 128 characters', 'key');
  const taken = (which: 'prefix' | 'key') =>
    new HttpRefused(409, 'project_exists', `another project in this workspace uses this ${which}`, which);
  const answer = (made: Project, replayed: boolean) =>
    json(
      {
        project: { projectId: made.id, logicalKey: made.key, displayName: made.name, prefix: made.prefix },
        ...(replayed ? { replayed: true } : {}),
      },
      201,
    );
  const clash = (projects: readonly Project[]): Project | 'prefix' | 'key' | null => {
    const same = projects.find((row) => row.prefix === prefix);
    if (same && retry({}) !== undefined && same.key === key && same.name === name) return same;
    if (same) return 'prefix';
    return projects.some((row) => row.key === key) ? 'key' : null;
  };
  const found = clash(await context.engine.listProjects());
  if (typeof found === 'string') throw taken(found);
  if (found !== null) return answer(found, true);
  let project: Project;
  try {
    project = await context.engine.createProject({ id: crypto.randomUUID(), key, name, prefix });
  } catch (error) {
    if (!(error instanceof TaskRefused && error.refusal === 'invalid')) throw error;
    // Another request may have made a project with this prefix or key since the check above.
    const since = clash(await context.engine.listProjects());
    if (since === null) throw error;
    if (typeof since === 'string') throw taken(since);
    return answer(since, true);
  }
  return answer(project, false);
}

/** POST /api/tasks/:id/close: closes a task with its reason, and with
 * `commit`, `pullRequest` or `link` records what proves it. */
export async function closeRoute(context: WriteContext, url: URL, request: Request, taskId: string): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'close_task', { task: taskId });
  only(body, ['projectId', 'reason', 'resolution', 'duplicateOf', 'commit', 'pullRequest', 'link']);
  const projectId = projectArg(body, 'projectId', 'http');
  const given = closingArgs(body, taskId, 'duplicateOf');
  const closing = {
    ...given,
    ...shippedArgs(body, { commit: 'commit', pr: 'pullRequest', link: 'link' }, given.resolution),
  };
  const { result } = await closeTask(context, projectId, taskId, closing, undefined, retry(body));
  const [task] = await webTasks([(await linksSeenBy(context)).task(result.task)]);
  return json({ task });
}
