/**
 * The API under /api: the MCP endpoint agents use and the HTTP routes the web
 * app uses. The Worker signs the sender in and picks the request's workspace
 * (src/worker.ts); that workspace's task store then answers an HTTP route
 * here, within the scopes the sender holds there. The Worker answers the MCP
 * endpoint itself (mcp/server.ts).
 */
import type { TaskEngine } from '@ntasks/domain';
import { SCOPES, type Principal } from './auth.ts';
import { backupRoute } from './http/backup.ts';
import { deliveryRoute, projectSettingsRoute } from './http/delivery.ts';
import { loadAbortRoute, loadBeginRoute, loadCommitRoute, loadRowsRoute } from './http/load.ts';
import { HttpRefused, json } from './http/respond.ts';
import {
  acceptRoute,
  agentStatsRoute,
  chooseRoute,
  dismissRoute,
  disputeRoute,
  releaseRoute,
  resolveRoute,
  respondRoute,
  stepRoute,
} from './http/decisions.ts';
import {
  boardRoute,
  capabilities,
  changesRoute,
  fieldsRoute,
  gatePath,
  historyRoute,
  projects,
  searchRoute,
  taskPath,
  taskRoute,
  winsRoute,
  type ReadContext,
} from './http/tasks.ts';
import {
  closeRoute,
  commentRoute,
  createProjectRoute,
  createRoute,
  defineFieldRoute,
  retireFieldRoute,
  updateRoute,
} from './http/writes.ts';
import { notAPerson } from './owner-answers.ts';
import { Refused, type RefusalKind } from './refused.ts';
import type { BackupAnswer } from './store/backup.ts';
import type { abortLoad, beginLoad, commitLoad, stageRows } from './store/load.ts';

export const MCP_PATH = '/api/mcp';

export interface ApiContext {
  readonly engine: TaskEngine;
  /** The current time as UTC ISO 8601 text. */
  readonly now: () => string;
  /** One page of a backup of the whole store: the first when the token is null (store/backup.ts). */
  readonly backup: (token: string | null) => Promise<BackupAnswer>;
  /** A load into the empty store, page by page (store/load.ts). */
  readonly load: LoadPort;
}

export interface LoadPort {
  begin(migrations: unknown, by: string): Promise<ReturnType<typeof beginLoad>>;
  rows(load: unknown, table: unknown, rows: unknown): Promise<ReturnType<typeof stageRows>>;
  commit(load: unknown, counts: unknown): Promise<ReturnType<typeof commitLoad>>;
  abort(load: unknown): Promise<ReturnType<typeof abortLoad>>;
}

export interface RouteContext extends ReadContext {
  readonly backup: ApiContext['backup'];
  readonly load: LoadPort;
}

type Route = (context: RouteContext, url: URL, request: Request) => Response | Promise<Response>;
type Method = 'GET' | 'POST' | 'PATCH';
/** A path's routes by method, and the scope they need when it is not the
 * usual one: read for GET, write for a change. `scope` names one for every
 * method of the path, or one for each method that needs another. A route
 * that answers GET answers HEAD too. */
type Routes = Readonly<{ GET?: Route; POST?: Route; PATCH?: Route; scope?: string | Partial<Record<Method, string>> }>;

/** The routes by path, other than a task's own. */
const PATHS: Readonly<Record<string, Routes>> = Object.freeze({
  '/api/tasks': { GET: boardRoute, POST: createRoute },
  '/api/tasks/projects': {
    GET: projects,
    POST: createProjectRoute,
    PATCH: projectSettingsRoute,
    scope: { POST: SCOPES.manage, PATCH: SCOPES.manage },
  },
  '/api/tasks/capabilities': { GET: capabilities },
  '/api/tasks/search': { GET: searchRoute },
  // Before a task's own paths: agent-stats is also the form of a task id.
  '/api/tasks/agent-stats': { GET: agentStatsRoute },
  '/api/tasks/wins': { GET: winsRoute },
  '/api/changes': { GET: changesRoute },
  '/api/fields': { GET: fieldsRoute, POST: defineFieldRoute },
  '/api/delivery': { POST: deliveryRoute },
  '/api/backup': { GET: backupRoute, scope: SCOPES.backup },
  '/api/restore': { POST: loadBeginRoute, scope: SCOPES.restore },
  '/api/restore/rows': { POST: loadRowsRoute, scope: SCOPES.restore },
  '/api/restore/commit': { POST: loadCommitRoute, scope: SCOPES.restore },
  '/api/restore/abort': { POST: loadAbortRoute, scope: SCOPES.restore },
});

/** POST /api/fields/:key/retire. */
const RETIRE_PATH = /^\/api\/fields\/([a-z][a-z0-9_-]{0,63})\/retire$/u;

function routesOf(pathname: string): Routes | null {
  const routes = PATHS[pathname];
  if (routes) return routes;
  const retire = RETIRE_PATH.exec(pathname);
  if (retire) return { POST: (context, url, request) => retireFieldRoute(context, url, request, retire[1]!) };
  const gate = gatePath(pathname);
  if (gate !== null) {
    const { gateId } = gate;
    const route = gate.part === 'steps' ? stepRoute : resolveRoute;
    return { POST: (context, url, request) => route(context, url, request, gateId), scope: SCOPES.decide };
  }
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
    case 'accept':
      return { POST: (context, url, request) => acceptRoute(context, url, request, taskId), scope: SCOPES.decide };
    case 'release':
      return { POST: (context, url, request) => releaseRoute(context, url, request, taskId), scope: SCOPES.decide };
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

/** The scope a method of a path needs. */
function scopeOf(routes: Routes, method: Method): string {
  const named = typeof routes.scope === 'string' ? routes.scope : routes.scope?.[method];
  return named ?? (method === 'GET' ? SCOPES.read : SCOPES.write);
}

/** Why a sender without `scope` is refused, as a sentence a person can read. */
export function lacking(scope: string): string {
  // A client that relays a person's click, such as another service's pages, shows this sentence as it is.
  if (scope === SCOPES.decide) return notAPerson().detail;
  if (scope === SCOPES.manage) return 'only an owner of this workspace may do this';
  return `this route needs ${scope}`;
}

/** Answers one HTTP request from a signed-in sender, in one workspace's store. */
export async function serveApi(request: Request, principal: Principal, context: ApiContext): Promise<Response> {
  const url = new URL(request.url);
  const { engine, now, backup, load } = context;
  const routes = routesOf(url.pathname);
  if (!routes) return json({ error: 'not_found' }, 404);
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  const route = method === 'GET' || method === 'POST' || method === 'PATCH' ? routes[method] : undefined;
  if (!route) return json({ error: 'method_not_allowed' }, 405, { allow: allowed(routes) });
  const scope = scopeOf(routes, method as Method);
  if (!principal.scopes.includes(scope)) return json({ error: 'insufficient_scope', detail: lacking(scope) }, 403);
  // A write from a browser comes from the web app's own pages, never another
  // site's, or from a connected app's page, whose bearer token no other site holds.
  const origin = request.headers.get('origin');
  if (method !== 'GET' && origin !== null && origin !== url.origin && principal.app === undefined) {
    return json({ error: 'forbidden', detail: 'origin refused' }, 403);
  }
  try {
    return await route({ engine, principal, now, backup, load }, url, request);
  } catch (error) {
    if (error instanceof HttpRefused) return error.response();
    if (error instanceof Refused) {
      const [status, code] = REFUSALS[error.kind];
      return json(
        { error: code, detail: error.detail, ...(error.field === undefined ? {} : { field: error.field }) },
        status,
      );
    }
    throw error;
  }
}
