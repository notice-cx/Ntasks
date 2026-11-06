/**
 * The API under /api: the MCP endpoint agents use and the HTTP reads the web
 * app uses. Every route signs its sender in first and answers only within the
 * scopes they hold.
 */
import type { TaskEngine } from '@ntasks/domain';
import { SCOPES, type Authenticator, type Principal } from './auth.ts';
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

export interface ApiOptions {
  readonly engine: TaskEngine;
  readonly authenticator: Authenticator;
  readonly workspace: Workspace;
  /** The current time as UTC ISO 8601 text. Tests set it; the Worker leaves it out. */
  readonly now?: () => string;
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

export function createApi(options: ApiOptions): { fetch(request: Request): Promise<Response> } {
  const now = options.now ?? (() => new Date().toISOString());
  const { engine, authenticator, workspace } = options;

  async function signedIn(request: Request): Promise<Principal | null> {
    try {
      return await authenticator.authenticate(request);
    } catch {
      // A sign-in that fails is a sign-in refused; the reason stays in the server log.
      console.error('sign-in failed');
      return null;
    }
  }

  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === MCP_PATH) {
        const principal = await signedIn(request);
        if (!principal) return authenticator.challenge(request);
        if (url.search) return json({ error: 'invalid_request', detail: 'the MCP endpoint takes no query' }, 400);
        return serveMcp(request, taskServer({ engine, workspace, principal, now }));
      }
      const route = routeOf(url.pathname);
      if (!route) return json({ error: 'not_found' }, 404);
      const principal = await signedIn(request);
      if (!principal) return authenticator.challenge(request);
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, HEAD' });
      if (!principal.scopes.includes(SCOPES.read))
        return json({ error: 'insufficient_scope', detail: `this route needs ${SCOPES.read}` }, 403);
      try {
        return await route({ engine, now }, url);
      } catch (error) {
        if (error instanceof HttpRefused) return error.response();
        throw error;
      }
    },
  });
}
