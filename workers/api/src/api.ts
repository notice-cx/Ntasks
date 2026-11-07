/**
 * The API under /api: the MCP endpoint agents use and the HTTP routes the web
 * app uses. The Worker signs the sender in (src/worker.ts); the task store
 * object then answers here, within the scopes the sender holds.
 */
import type { TaskEngine } from '@ntasks/domain';
import { SCOPES, type Principal } from './auth.ts';
import { backupRoute } from './http/backup.ts';
import { HttpRefused, json } from './http/respond.ts';
import {
  agentStatsRoute,
  chooseRoute,
  dismissRoute,
  disputeRoute,
  resolveRoute,
  respondRoute,
} from './http/decisions.ts';
import {
  boardRoute,
  capabilities,
  changesRoute,
  fieldsRoute,
  gatePath,
  historyRoute,
  projects,
  taskPath,
  taskRoute,
  type ReadContext,
} from './http/tasks.ts';
import {
  closeRoute,
  commentRoute,
  createRoute,
  defineFieldRoute,
  retireFieldRoute,
  updateRoute,
} from './http/writes.ts';
import { serveMcp } from './mcp/protocol.ts';
import { notAPerson } from './owner-answers.ts';
import { taskServer } from './mcp/server.ts';
import { Refused, type RefusalKind } from './refused.ts';
import type { Workspace } from './service.ts';
import type { BackupAnswer } from './store/backup.ts';

export const MCP_PATH = '/api/mcp';
/** The largest MCP message: a create_tasks call filing many long tasks fits. */
const MCP_BYTES = 256 * 1024;

export interface ApiContext {
  readonly engine: TaskEngine;
  readonly workspace: Workspace;
  /** The current time as UTC ISO 8601 text. */
  readonly now: () => string;
  /** One page of a backup of the whole store: the first when the token is null (store/backup.ts). */
  readonly backup: (token: string | null) => Promise<BackupAnswer>;
}

export interface RouteContext extends ReadContext {
  readonly backup: ApiContext['backup'];
}

type Route = (context: RouteContext, url: URL, request: Request) => Response | Promise<Response>;
/** A path's routes by method, and the scope they need when it is not the
 * usual one: read for GET, write for a change. A route that answers GET
 * answers HEAD too. */
type Routes = Readonly<{ GET?: Route; POST?: Route; PATCH?: Route; scope?: string }>;

/** The routes by path, other than a task's own. */
const PATHS: Readonly<Record<string, Routes>> = Object.freeze({
  '/api/tasks': { GET: boardRoute, POST: createRoute },
  '/api/tasks/projects': { GET: projects },
  '/api/tasks/capabilities': { GET: capabilities },
  // Before a task's own paths: agent-stats is also the form of a task id.
  '/api/tasks/agent-stats': { GET: agentStatsRoute },
  '/api/changes': { GET: changesRoute },
  '/api/fields': { GET: fieldsRoute, POST: defineFieldRoute },
  '/api/backup': { GET: backupRoute, scope: SCOPES.backup },
});

/** POST /api/fields/:key/retire. */
const RETIRE_PATH = /^\/api\/fields\/([a-z][a-z0-9_-]{0,63})\/retire$/u;

function routesOf(pathname: string): Routes | null {
  const routes = PATHS[pathname];
  if (routes) return routes;
  const retire = RETIRE_PATH.exec(pathname);
  if (retire) return { POST: (context, url, request) => retireFieldRoute(context, url, request, retire[1]!) };
  const gateId = gatePath(pathname);
  if (gateId !== null)
    return { POST: (context, url, request) => resolveRoute(context, url, request, gateId), scope: SCOPES.decide };
  const task = taskPath(pathname);
  if (!task) return null;
  const { taskId } = task;
  switch (task.part) {
    case 'history':
      return { GET: (context, url) => historyRoute(context, url, taskId) };
    case 'comments':
      return { POST: (context, url, request) => commentRoute(context, url, request, taskId) };
    case 'close':
      return { POST: (context, url, request) => closeRoute(context, url, request, taskId) };
    case 'respond':
      return { POST: (context, url, request) => respondRoute(context, url, request, taskId), scope: SCOPES.decide };
    case 'choose':
      return { POST: (context, url, request) => chooseRoute(context, url, request, taskId), scope: SCOPES.decide };
    case 'dismiss':
      return { POST: (context, url, request) => dismissRoute(context, url, request, taskId), scope: SCOPES.decide };
    case 'dispute':
      return { POST: (context, url, request) => disputeRoute(context, url, request, taskId), scope: SCOPES.decide };
    default:
      return {
        GET: (context, url) => taskRoute(context, url, taskId),
        PATCH: (context, url, request) => updateRoute(context, url, request, taskId),
      };
  }
}

/** The methods a path answers, as an `allow` header lists them. */
function allowed(routes: Routes): string {
  return [
    ...(routes.GET ? ['GET', 'HEAD'] : []),
    ...(routes.POST ? ['POST'] : []),
    ...(routes.PATCH ? ['PATCH'] : []),
  ].join(', ');
}

/** Whether the API serves this path. The Worker answers 404 for any other
 * before anyone signs in. */
export function isApiPath(pathname: string): boolean {
  return pathname === MCP_PATH || routesOf(pathname) !== null;
}

/** The HTTP answer to a refused write: the status for its kind, and the sentence for a person. */
const REFUSALS: Readonly<Record<RefusalKind, readonly [number, string]>> = Object.freeze({
  invalid: [400, 'invalid_request'],
  not_found: [404, 'not_found'],
  forbidden: [403, 'forbidden'],
  state: [409, 'task_refused'],
  retry_conflict: [409, 'idempotency_conflict'],
  unavailable: [503, 'unavailable'],
});

/** Answers one request from a signed-in sender. */
export async function serveApi(request: Request, principal: Principal, context: ApiContext): Promise<Response> {
  const url = new URL(request.url);
  const { engine, workspace, now, backup } = context;
  if (url.pathname === MCP_PATH) {
    if (url.search) return json({ error: 'invalid_request', detail: 'the MCP endpoint takes no query' }, 400);
    return serveMcp(request, taskServer({ engine, workspace, principal, now }), { maxBytes: MCP_BYTES });
  }
  const routes = routesOf(url.pathname);
  if (!routes) return json({ error: 'not_found' }, 404);
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  const route = method === 'GET' || method === 'POST' || method === 'PATCH' ? routes[method] : undefined;
  if (!route) return json({ error: 'method_not_allowed' }, 405, { allow: allowed(routes) });
  const scope = routes.scope ?? (method === 'GET' ? SCOPES.read : SCOPES.write);
  if (!principal.scopes.includes(scope)) {
    // A client that relays a person's click, such as another service's pages, shows this sentence as it is.
    const detail = scope === SCOPES.decide ? notAPerson().detail : `this route needs ${scope}`;
    return json({ error: 'insufficient_scope', detail }, 403);
  }
  // A write from a browser comes from the web app's own pages, never another site's.
  const origin = request.headers.get('origin');
  if (method !== 'GET' && origin !== null && origin !== url.origin) {
    return json({ error: 'forbidden', detail: 'origin refused' }, 403);
  }
  try {
    return await route({ engine, principal, now, backup }, url, request);
  } catch (error) {
    if (error instanceof HttpRefused) return error.response();
    if (error instanceof Refused) {
      const [status, code] = REFUSALS[error.kind];
      return json({ error: code, detail: error.detail }, status);
    }
    throw error;
  }
}
