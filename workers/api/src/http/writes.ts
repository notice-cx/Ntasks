/**
 * The HTTP writes the web app uses: filing, changing, commenting on and
 * closing a task. Each route and body has the shape NoticeOS's Tasks API
 * took (scripts/hosted-task-http.mts there), and runs the same write as the
 * MCP tool that does the same thing (task-writes.ts), checked by the same
 * rules (args.ts). An Idempotency-Key header makes a write safe to retry.
 */
import { IDEMPOTENCY_KEY, TASK_LIMITS, type TaskStatus } from '@ntasks/domain';
import {
  assigneeArg,
  cardArg,
  choiceArg,
  closingArgs,
  deferArg,
  emptyIsNone,
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
  type Args,
} from '../args.ts';
import { strictJson } from '../mcp/protocol.ts';
import { TASK_CHANGE_CLASSES } from '../noticeos-fields.ts';
import {
  closeTask,
  commentOnTask,
  createTask,
  updateTask,
  type NewTask,
  type RetryRequest,
  type TaskChange,
  type WriteContext,
} from '../task-writes.ts';
import { linksSeenBy } from '../lookup.ts';
import { commentView, webTask } from '../views.ts';
import { readBoundedJsonText } from './json-body.ts';
import { invalidRequest, json, queryOf } from './respond.ts';

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
  'addLabels',
  'removeLabels',
  'card',
  'changeClass',
]);
/** The writes this API offers. A person's decisions are not among them yet. */
export const WRITE_OPERATIONS: readonly string[] = Object.freeze(['create', 'update', 'comment', 'close']);

/** A write's body and its retry key. The body is one JSON object, with no key twice. */
async function writeOf(
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
    metadata: sourceMetadataArg(body),
    card: cardArg(body),
    changeClass: choiceArg(body, 'changeClass', TASK_CHANGE_CLASSES),
  };
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
  only(body, ['projectId', ...EDITABLE_FIELDS]);
  const projectId = projectArg(body, 'projectId', 'http');
  if (body.claim !== undefined) {
    if (body.claim !== true) refuse('invalid arguments: claim (true)');
    const others = ['assignee', 'status', 'card', 'changeClass'].filter((name) => body[name] !== undefined);
    if (others.length > 0) refuse(`invalid arguments: claim (on its own, without ${others.join(', ')})`);
  }
  const fields: TaskChange = {
    claim: body.claim === true ? true : undefined,
    status: choiceArg(body, 'status', STATUSES),
    priority: priorityArg(body),
    title: textArg(body, 'title', TASK_LIMITS.title, false),
    description: textArg(body, 'description', TASK_LIMITS.description, false, true),
    assignee: assigneeArg(body),
    parent: body.parent === '' ? null : body.parent === undefined ? undefined : taskArg(body, 'parent'),
    defer: emptyIsNone(deferArg(body)),
    acceptance: textArg(body, 'acceptance', TASK_LIMITS.acceptance, false, true),
    addLabels: labelsArg(body, 'addLabels', 1),
    removeLabels: labelsArg(body, 'removeLabels', 1),
    card: body.card === null ? null : cardArg(body),
    changeClass: body.changeClass === null ? null : choiceArg(body, 'changeClass', TASK_CHANGE_CLASSES),
  };
  const change = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as TaskChange;
  if (Object.keys(change).length === 0) refuse('invalid arguments: name at least one field to change');
  setOrTakeOff(body, ['card', 'changeClass']);
  const { result } = await updateTask(context, projectId, taskId, change, undefined, retry(body));
  return json({ task: webTask((await linksSeenBy(context)).task(result.task)) });
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

/** POST /api/tasks/:id/close: closes a task with its reason. */
export async function closeRoute(context: WriteContext, url: URL, request: Request, taskId: string): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'close_task', { task: taskId });
  only(body, ['projectId', 'reason', 'resolution', 'duplicateOf']);
  const projectId = projectArg(body, 'projectId', 'http');
  const closing = closingArgs(body, taskId, 'duplicateOf');
  const { result } = await closeTask(context, projectId, taskId, closing, undefined, retry(body));
  return json({ task: webTask((await linksSeenBy(context)).task(result.task)) });
}
