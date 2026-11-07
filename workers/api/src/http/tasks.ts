/**
 * The HTTP reads the web app uses. Each route and answer has the shape
 * NoticeOS's task pages read, so its board and task pages work against Ntasks
 * unchanged; docs/api.md lists them.
 */
import {
  isTaskId,
  isTaskStatus,
  TASK_LIMITS,
  TASK_STATUSES,
  type EpicProgress,
  type Project,
  type TaskEngine,
  type TaskStatus,
} from '@ntasks/domain';
import { mayReach, reachable, SCOPES, type Principal } from '../auth.ts';
import { linksSeenBy } from '../lookup.ts';
import { allEvents, board, CLOSED_DAYS, CLOSED_HISTORY_DAYS } from '../service.ts';
import { fieldFiltersOf } from '../task-writes.ts';
import { commentView, fieldView, historyView, proposalOf, webTask } from '../views.ts';
import { invalidRequest, json, notFound, queryOf, wholeOf } from './respond.ts';
import { EDITABLE_FIELDS, WRITE_OPERATIONS } from './writes.ts';

export interface ReadContext {
  readonly engine: TaskEngine;
  /** The signed-in sender, who sees only the projects it reaches. */
  readonly principal: Principal;
  readonly now: () => string;
}

/** The project a request names, among those the sender reaches. */
async function projectOf({ engine, principal }: ReadContext, projectId: string | undefined): Promise<Project> {
  if (!projectId) invalidRequest('project is required: a projectId from /api/tasks/projects');
  const project = reachable(principal, await engine.listProjects()).find((candidate) => candidate.id === projectId);
  return project ?? notFound(`no project ${projectId}; /api/tasks/projects lists them`);
}

/** An epic as the board shows it: how many of its children are closed. */
function epicView(epic: EpicProgress) {
  return {
    id: epic.id,
    title: epic.title,
    status: epic.status,
    priority: epic.priority,
    total: epic.children,
    closed: epic.closedChildren,
    eligibleForClose: epic.eligibleForClose,
  };
}

/** GET /api/tasks/projects */
export async function projects({ engine, principal }: ReadContext, url: URL): Promise<Response> {
  queryOf(url, []);
  return json({
    projects: reachable(principal, await engine.listProjects()).map((project) => ({
      projectId: project.id,
      logicalKey: project.key,
      displayName: project.name,
      prefix: project.prefix,
    })),
  });
}

/** GET /api/tasks/capabilities: what the web app may offer this sender. It
 * may write when it holds the write scope and may change some project. */
export function capabilities({ principal }: ReadContext, url: URL): Response {
  queryOf(url, []);
  const writable =
    principal.scopes.includes(SCOPES.write) &&
    (principal.projects === 'all' || [...principal.projects.values()].includes('write'));
  return json({
    live: true,
    writable,
    projectSelection: true,
    operations: writable ? WRITE_OPERATIONS : [],
    editableFields: writable ? EDITABLE_FIELDS : [],
  });
}

/** The most tasks one page of a label read returns when `limit` is left out. */
const LABEL_PAGE = 100;

/**
 * GET /api/tasks?project=…&label=…&limit=…&after=…: every task of the project
 * carrying the label, in every status and closed of any age, by id. `after`
 * is the previous page's `next`, which is null on the last page.
 */
async function labelRoute(context: ReadContext, query: Readonly<Record<string, string>>): Promise<Response> {
  const { engine, now } = context;
  if (query.status !== undefined || query.closedDays !== undefined)
    invalidRequest('a label read reads every status and every close: leave out status and closedDays');
  const label = query.label!;
  if (label.length < 1 || label.length > TASK_LIMITS.label)
    invalidRequest(`label must be 1 to ${TASK_LIMITS.label} characters`);
  const limit = wholeOf(query, 'limit', 1, TASK_LIMITS.page, LABEL_PAGE);
  if (query.after !== undefined && !isTaskId(query.after))
    invalidRequest('after must be a task id: the next of the page before');
  const project = await projectOf(context, query.project);
  const [page, links] = await Promise.all([
    engine.listLabelled(project.id, { label, limit, ...(query.after === undefined ? {} : { after: query.after }) }),
    linksSeenBy(context),
  ]);
  return json({
    project: project.key,
    prefix: project.prefix,
    repo: '',
    readAt: now(),
    label,
    tasks: page.tasks.map((task) => webTask(links.task(task))),
    next: page.next,
  });
}

/**
 * GET /api/tasks?project=…&status=…&closedDays=…: a project's board. `status`
 * is a comma-separated list (every status when left out). `closedDays`
 * reaches further back than the board's week, and only on a read of closed
 * tasks alone, so the board itself stays a small read. With `label` it is
 * the label read above instead.
 */
export async function boardRoute(context: ReadContext, url: URL): Promise<Response> {
  const { engine, now } = context;
  const fieldNames = [...url.searchParams.keys()].filter((name) => name.startsWith(FIELD_PARAM));
  const query = queryOf(url, ['project', 'status', 'closedDays', 'label', 'limit', 'after', ...fieldNames]);
  if (query.label !== undefined) {
    if (fieldNames.length > 0) invalidRequest('a label read reads every task carrying the label: leave out field.');
    return labelRoute(context, query);
  }
  if (query.limit !== undefined || query.after !== undefined)
    invalidRequest('limit and after page a label read: label=');
  const statuses = query.status === undefined ? [...TASK_STATUSES] : query.status.split(',');
  if (
    statuses.length < 1 ||
    new Set(statuses).size !== statuses.length ||
    statuses.some((status) => !isTaskStatus(status))
  ) {
    invalidRequest(`status must be a comma-separated list of ${TASK_STATUSES.join(', ')}`);
  }
  if (query.closedDays !== undefined && statuses.join(',') !== 'closed')
    invalidRequest('closedDays is for a read of closed tasks alone: status=closed');
  const closedDays = wholeOf(query, 'closedDays', 1, CLOSED_HISTORY_DAYS, CLOSED_DAYS);
  const project = await projectOf(context, query.project);
  const fields = await fieldParams(context, project, query);
  const active = statuses.some((status) => status !== 'closed');
  // Read before the board, so a change the board misses is after it in the feed.
  const lastSeq = await engine.latestChange();
  const [found, epics, links] = await Promise.all([
    board(engine, project.id, statuses as TaskStatus[], closedDays, fields === undefined ? {} : { fields }, now),
    active ? engine.listEpics(project.id) : null,
    linksSeenBy(context),
  ]);
  return json({
    project: project.key,
    prefix: project.prefix,
    repo: '',
    readAt: found.readAt,
    closedSince: found.closedSince,
    tasks: found.tasks.map((task) => webTask(links.task(task))),
    epics: epics?.map(epicView) ?? null,
    actors: [],
    lastSeq,
  });
}

/** The parameter prefix of a board's filter by custom field: `field.severity=high`. */
const FIELD_PARAM = 'field.';

/** The board's filters by custom field, each value read as its field's type
 * takes it: a number, true or false, or text. */
async function fieldParams(
  context: ReadContext,
  project: Project,
  query: Readonly<Record<string, string>>,
): Promise<Record<string, string | number | boolean> | undefined> {
  const given = Object.entries(query).filter(([name]) => name.startsWith(FIELD_PARAM));
  if (given.length === 0) return undefined;
  const fields = await context.engine.listFields(project.id);
  const values = Object.fromEntries(
    given.map(([name, text]) => {
      const key = name.slice(FIELD_PARAM.length);
      const type = fields.find((field) => field.key === key)?.type;
      if (type === 'number' && text.trim() !== '' && Number.isFinite(Number(text))) return [key, Number(text)];
      if (type === 'yes-no' && (text === 'true' || text === 'false')) return [key, text === 'true'];
      return [key, text];
    }),
  );
  return fieldFiltersOf(context, project, values, FIELD_PARAM, fields);
}

/** GET /api/fields?project=…: the project's custom fields, retired ones included. */
export async function fieldsRoute(context: ReadContext, url: URL): Promise<Response> {
  const query = queryOf(url, ['project']);
  const project = await projectOf(context, query.project);
  const fields = await context.engine.listFields(project.id);
  return json({ project: project.key, fields: fields.map(fieldView) });
}

async function taskIn(engine: TaskEngine, project: Project, taskId: string) {
  return (await engine.getTask(project.id, taskId)) ?? notFound(`no task ${taskId} in project ${project.id}`);
}

/** GET /api/tasks/:id?project=… */
export async function taskRoute(context: ReadContext, url: URL, taskId: string): Promise<Response> {
  const { engine, now } = context;
  const query = queryOf(url, ['project']);
  const project = await projectOf(context, query.project);
  const [task, comments, links] = await Promise.all([
    taskIn(engine, project, taskId),
    engine.listComments(project.id, taskId),
    linksSeenBy(context),
  ]);
  return json({
    project: project.key,
    prefix: project.prefix,
    repo: '',
    readAt: now(),
    task: webTask(links.task(task)),
    comments: comments.map(commentView),
    actors: [],
    proposal: proposalOf(task),
  });
}

/** GET /api/tasks/:id/history?project=…&limit=…: the task's changes, newest first. */
export async function historyRoute(context: ReadContext, url: URL, taskId: string): Promise<Response> {
  const { engine } = context;
  const query = queryOf(url, ['project', 'limit']);
  const limit = wholeOf(query, 'limit', 1, TASK_LIMITS.page, 100);
  const project = await projectOf(context, query.project);
  const [, events, links] = await Promise.all([
    taskIn(engine, project, taskId),
    allEvents(engine, project.id, taskId),
    linksSeenBy(context),
  ]);
  return json({ changes: historyView(events.map(links.event), limit, false) });
}

/**
 * GET /api/changes?after=…&limit=…&project=…: every change after sequence
 * number `after`, oldest first, for a client that keeps its own copy. It asks
 * again with `after` set to the answer's `lastSeq`.
 */
export async function changesRoute(context: ReadContext, url: URL): Promise<Response> {
  const { engine, principal } = context;
  const query = queryOf(url, ['after', 'limit', 'project']);
  const after = wholeOf(query, 'after', 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = wholeOf(query, 'limit', 1, TASK_LIMITS.page, 100);
  const projectId = query.project === undefined ? undefined : (await projectOf(context, query.project)).id;
  const page = await engine.listChanges({ after, limit, ...(projectId === undefined ? {} : { projectId }) });
  const links = await linksSeenBy(context);
  // lastSeq still moves past events the sender cannot see, so it asks after them next.
  return json({
    events: page.events.filter((event) => mayReach(principal, event.projectId)).map(links.event),
    lastSeq: page.lastSeq,
  });
}

/** The task id in /api/tasks/:id and the part of the task a path under it
 * names (its history, comments or close), or null for another path. */
export function taskPath(
  pathname: string,
): { readonly taskId: string; readonly part: 'history' | 'comments' | 'close' | null } | null {
  const match = /^\/api\/tasks\/([^/]+)(?:\/(history|comments|close))?$/u.exec(pathname);
  if (!match || !isTaskId(match[1])) return null;
  return { taskId: match[1]!, part: (match[2] as 'history' | 'comments' | 'close' | undefined) ?? null };
}
