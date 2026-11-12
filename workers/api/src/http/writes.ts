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
  pinsArg,
  priorityArg,
  projectArg,
  refuse,
  setOrTakeOff,
  sourceMetadataArg,
  taskArg,
  taskIdsArg,
  taskLinksArg,
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
  linkTasks,
  moveTasks,
  namedAfter,
  retireField,
  updateTask,
  type NewTask,
  type RetryRequest,
  type TaskChange,
  type WriteContext,
} from '../task-writes.ts';
import { formerIdsOf, linksSeenBy } from '../lookup.ts';
import { shippedArgs } from '../delivery.ts';
import { commentView, fieldView, webTasks } from '../views.ts';
import { readBoundedJsonText } from './json-body.ts';
import { HttpRefused, invalidRequest, json, queryOf } from './respond.ts';

/** The header a write's retry key arrives in. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
/** The task id, and the project, a write's path and body named before the API read a moved task's former id as
 * the task (api.ts): its retry is the request as sent. The API sets them, and drops any a client sends. */
export const FORMER_TASK_HEADER = 'x-ntasks-former-task';
export const FORMER_PROJECT_HEADER = 'x-ntasks-former-project';
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
  'addLinks',
  'removeLinks',
  'fields',
  'card',
  'changeClass',
]);
/** The writes this API offers any sender that may change a project. */
export const WRITE_OPERATIONS: readonly string[] = Object.freeze([
  'create',
  'update',
  'comment',
  'close',
  'move',
  'deliver',
]);
/** The decisions it offers a person signed in to the web app, in NoticeOS's names. */
export const DECISION_OPERATIONS: readonly string[] = Object.freeze([
  'respond',
  'dismiss',
  'resolve',
  'performed',
  'choose',
  'dispute',
  'step',
  'accept',
  'release',
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
  const formerTask = request.headers.get(FORMER_TASK_HEADER);
  const formerProject = request.headers.get(FORMER_PROJECT_HEADER);
  const asSent = (sent: Args): Args => ({
    ...route,
    ...sent,
    ...(formerTask !== null && route.task !== undefined ? { task: formerTask } : {}),
    ...(formerProject !== null && sent.projectId !== undefined ? { projectId: formerProject } : {}),
  });
  return {
    body: body as Args,
    // The route names the task, so a key sent again for another task is another request.
    retry: (sent) => (key === null ? undefined : { operation, key, request: asSent(sent) }),
  };
}

/** A card's kill date is the task's due date, so a write gives one of the two. */
function oneDueDate(dueAt: string | null | undefined, card: JsonObject | null | undefined): void {
  if (dueAt !== undefined && card?.kill !== undefined)
    refuse("invalid arguments: dueAt (a card's kill date is the due date; send one of them)");
}

/** A task id in a body, resolved to its current id when the sender may see it. */
export async function currentTaskArg(context: WriteContext, body: Args, name: string): Promise<string | undefined> {
  if (body[name] === undefined) return undefined;
  const id = taskArg(body, name);
  return (await formerIdsOf(context, [id])).get(id)?.taskId ?? id;
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
    parent: await currentTaskArg(context, body, 'parent'),
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
/**
 * POST /api/tasks/move: moves tasks to a project, under a task of it or none,
 * as move_tasks does. The body names `tasks`, and `projectId`, `parent` or
 * both; a former id among them names the task it moved to.
 */
export async function moveRoute(context: WriteContext, url: URL, request: Request): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'move_tasks', {});
  only(body, ['tasks', 'projectId', 'parent', 'withChildren']);
  const sent = body.tasks;
  if (!Array.isArray(sent) || sent.length < 1 || sent.length > TASK_LIMITS.move)
    refuse(`invalid arguments: tasks (1–${TASK_LIMITS.move} task ids)`);
  const named = sent.map((id: unknown, index) => taskArg({ [`tasks[${index}]`]: id }, `tasks[${index}]`));
  const parentSent = body.parent === undefined || body.parent === '' ? null : taskArg(body, 'parent');
  const now = await formerIdsOf(context, [...named, parentSent]);
  const idNow = (id: string) => now.get(id)?.taskId ?? id;
  const tasks = [...new Set(named.map(idNow))];
  const parent = parentSent === null ? null : idNow(parentSent);
  if (parent !== null && tasks.includes(parent))
    refuse('invalid arguments: parent (another task than the ones moving)');
  if (body.withChildren !== undefined && typeof body.withChildren !== 'boolean')
    refuse('invalid arguments: withChildren (true or false)');
  const { result, fieldsKept } = await moveTasks(
    context,
    {
      tasks,
      ...(body.projectId === undefined ? {} : { project: projectArg(body, 'projectId', 'http') }),
      parent,
      withChildren: body.withChildren === true,
    },
    undefined,
    retry(body),
  );
  const links = await linksSeenBy(context);
  return json({
    tasks: await webTasks(
      namedAfter(tasks, result).map((task) => links.task(task)),
      context.now(),
    ),
    moved: Object.fromEntries(result.moved.map(({ from, to }) => [from, to])),
    ...(Object.keys(fieldsKept).length === 0 ? {} : { fieldsKept }),
    ...(result.epics === undefined
      ? {}
      : { epics: result.epics.map((epic) => ({ id: epic.id, status: epic.status })) }),
  });
}

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
  if (body.addLinks !== undefined || body.removeLinks !== undefined)
    return linksRoute(context, body, projectId, taskId);
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
  only(details as Args, [...WORK_DETAILS, 'touches']);
  const fields: TaskChange = {
    ...workArgs(details as Args, 'work.', body),
    claim: body.claim === true ? true : undefined,
    status: choiceArg(body, 'status', STATUSES),
    priority: priorityArg(body),
    title: textArg(body, 'title', TASK_LIMITS.title, false),
    description: textArg(body, 'description', TASK_LIMITS.description, false, true),
    assignee: assigneeArg(body),
    parent: body.parent === '' ? null : await currentTaskArg(context, body, 'parent'),
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
  const [task] = await webTasks([(await linksSeenBy(context)).task(result.task)], context.now());
  return json({ task });
}

/**
 * PATCH /api/tasks/:id with `addLinks` or `removeLinks`, and no other field:
 * each sets or removes the one link between the task and another, as
 * link_tasks does, so the same rules hold. Removals run first, then additions,
 * in order; a refusal answers with the links before it in place. Each is
 * safe to send again, so a retry key is not needed.
 */
async function linksRoute(context: WriteContext, body: Args, projectId: string, taskId: string): Promise<Response> {
  only(body, ['projectId', 'addLinks', 'removeLinks']);
  const added = taskLinksArg(body, 'addLinks') ?? [];
  const removed = taskIdsArg(body, 'removeLinks') ?? [];
  const former = await formerIdsOf(context, [...added.map((link) => link.taskId), ...removed]);
  const current = (id: string) => former.get(id)?.taskId ?? id;
  const addLinks = added.map((link) => ({ ...link, taskId: current(link.taskId) }));
  const removeLinks = removed.map(current);
  if (
    new Set(addLinks.map((link) => link.taskId)).size !== addLinks.length ||
    new Set(removeLinks).size !== removeLinks.length
  )
    refuse('invalid arguments: addLinks and removeLinks (name each task once)');
  if (addLinks.some((link) => removeLinks.includes(link.taskId)))
    refuse('invalid arguments: addLinks and removeLinks (a task both linked and unlinked; send one)');
  if ([...addLinks.map((link) => link.taskId), ...removeLinks].includes(taskId))
    refuse('invalid arguments: addLinks and removeLinks (another task than this one)');
  for (const to of removeLinks) await linkTasks(context, projectId, taskId, to, null);
  for (const link of addLinks) await linkTasks(context, projectId, taskId, link.taskId, link.type);
  const task = await context.engine.getTask(projectId, taskId);
  if (task === null) throw new HttpRefused(404, 'not_found', `No task ${taskId}`);
  const [view] = await webTasks([(await linksSeenBy(context)).task(task)], context.now());
  return json({ task: view });
}

/** POST /api/tasks/:id/comments: adds a comment, which `pin: true` pins and
 * which unpins the task's pinned comments `unpin` names. */
export async function commentRoute(
  context: WriteContext,
  url: URL,
  request: Request,
  taskId: string,
): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'comment_on_task', { task: taskId });
  only(body, ['projectId', 'text', 'pin', 'unpin']);
  const projectId = projectArg(body, 'projectId', 'http');
  const text = textArg(body, 'text', TASK_LIMITS.comment, true)!;
  const pins = pinsArg(body);
  const { comment } = await commentOnTask(context, projectId, taskId, text, retry(body), undefined, undefined, pins);
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
  const duplicateOf = await currentTaskArg(context, body, 'duplicateOf');
  const given = closingArgs({ ...body, duplicateOf }, taskId, 'duplicateOf');
  const closing = {
    ...given,
    ...shippedArgs(body, { commit: 'commit', pr: 'pullRequest', link: 'link' }, given.resolution),
  };
  const { result } = await closeTask(context, projectId, taskId, closing, undefined, retry(body));
  const [task] = await webTasks([(await linksSeenBy(context)).task(result.task)], context.now());
  return json({ task });
}
