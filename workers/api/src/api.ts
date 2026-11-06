/**
 * The API under /api: the MCP endpoint agents use and the HTTP reads the web
 * app use. The Worker signs the sender in (src/worker.ts); the task store
 * object then answers here, within the scopes the sender holds.
 */
import type { TaskEngine } from '@ntasks/domain';
import { SCOPES, type Principal } from './auth.ts';
import { HttpRefused, json } from './http/respond.ts';
import {
  boardRoute,
  capabilities,
  changesRoute,
  historyRoute,
  projects,
  taskPath,
  taskRoute,
  type ReadContext,
} from './http/tasks.ts';
import { serveMcp } from './mcp/protocol.ts';
import { taskServer } from './mcp/server.ts';
import type { Workspace } from './service.ts';

export const MCP_PATH = '/api/mcp';

export interface ApiContext {
  readonly engine: TaskEngine;
  readonly workspace: Workspace;
  /** The current time as UTC ISO 8601 text. */
  readonly now: () => string;
}

type Route = (context: ReadContext, url: URL) => Response | Promise<Response>;

/** The HTTP read routes, by path, other than a task's own. */
const READS: Readonly<Record<string, Route>> = Object.freeze({
  '/api/tasks': boardRoute,
  '/api/tasks/projects': projects,
  '/api/tasks/capabilities': capabilities,
  '/api/changes': changesRoute,
});

function routeOf(pathname: string): Route | null {
  const read = READS[pathname];
  if (read) return read;
  const task = taskPath(pathname);
  if (!task) return null;
  return task.history
    ? (context, url) => historyRoute(context, url, task.taskId)
    : (context, url) => taskRoute(context, url, task.taskId);
}

/** Whether the API serves this path. The Worker answers 404 for any other
 * before anyone signs in. */
export function isApiPath(pathname: string): boolean {
  return pathname === MCP_PATH || routeOf(pathname) !== null;
}

/** Answers one request from a signed-in sender. */
export async function serveApi(request: Request, principal: Principal, context: ApiContext): Promise<Response> {
  const url = new URL(request.url);
  const { engine, workspace, now } = context;
  if (url.pathname === MCP_PATH) {
    if (url.search) return json({ error: 'invalid_request', detail: 'the MCP endpoint takes no query' }, 400);
    return serveMcp(request, taskServer({ engine, workspace, principal, now }));
  }
  const route = routeOf(url.pathname);
  if (!route) return json({ error: 'not_found' }, 404);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, HEAD' });
  }
  if (!principal.scopes.includes(SCOPES.read)) {
    return json({ error: 'insufficient_scope', detail: `this route needs ${SCOPES.read}` }, 403);
  }
  try {
    return await route({ engine, principal, now }, url);
  } catch (error) {
    if (error instanceof HttpRefused) return error.response();
    throw error;
  }
}
