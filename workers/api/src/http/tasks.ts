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
import { mayReach, reachable, type Principal } from '../auth.ts';
import { allEvents, board, CLOSED_DAYS, CLOSED_HISTORY_DAYS } from '../service.ts';
import { commentView, historyView, proposalOf, webTask } from '../views.ts';
import { invalidRequest, json, notFound, queryOf, wholeOf } from './respond.ts';

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

/** GET /api/tasks/capabilities: what the web app may offer. Writes arrive in a later release. */
export function capabilities(_context: ReadContext, url: URL): Response {
  queryOf(url, []);
  return json({ live: true, writable: false, projectSelection: true, operations: [], editableFields: [] });
}

/**
 * GET /api/tasks?project=…&status=…&closedDays=…: a project's board. `status`
 * is a comma-separated list (every status when left out). `closedDays`
 * reaches further back than the board's week, and only on a read of closed
 * tasks alone, so the board itself stays a small read.
 */
export async function boardRoute(context: ReadContext, url: URL): Promise<Response> {
  const { engine, now } = context;
  const query = queryOf(url, ['project', 'status', 'closedDays']);
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
  const active = statuses.some((status) => status !== 'closed');
  const [found, epics] = await Promise.all([
    board(engine, project.id, statuses as TaskStatus[], closedDays, {}, now),
    active ? engine.listEpics(project.id) : null,
  ]);
  return json({
    project: project.key,
    prefix: project.prefix,
    repo: '',
    readAt: found.readAt,
    closedSince: found.closedSince,
    tasks: found.tasks.map(webTask),
    epics: epics?.map(epicView) ?? null,
    actors: [],
  });
}

async function taskIn(engine: TaskEngine, project: Project, taskId: string) {
  return (await engine.getTask(project.id, taskId)) ?? notFound(`no task ${taskId} in project ${project.id}`);
}

/** GET /api/tasks/:id?project=… */
export async function taskRoute(context: ReadContext, url: URL, taskId: string): Promise<Response> {
  const { engine, now } = context;
  const query = queryOf(url, ['project']);
  const project = await projectOf(context, query.project);
  const [task, comments] = await Promise.all([
    taskIn(engine, project, taskId),
    engine.listComments(project.id, taskId),
  ]);
  return json({
    project: project.key,
    prefix: project.prefix,
    repo: '',
    readAt: now(),
    task: webTask(task),
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
  const [, events] = await Promise.all([taskIn(engine, project, taskId), allEvents(engine, project.id, taskId)]);
  return json({ changes: historyView(events, limit, false) });
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
  // lastSeq still moves past events the sender cannot see, so it asks after them next.
  return json({ events: page.events.filter((event) => mayReach(principal, event.projectId)), lastSeq: page.lastSeq });
}

/** The task id in /api/tasks/:id and /api/tasks/:id/history, or null for another path. */
export function taskPath(pathname: string): { readonly taskId: string; readonly history: boolean } | null {
  const match = /^\/api\/tasks\/([^/]+)(\/history)?$/u.exec(pathname);
  if (!match || !isTaskId(match[1])) return null;
  return { taskId: match[1]!, history: match[2] !== undefined };
}
