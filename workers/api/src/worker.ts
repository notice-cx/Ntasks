/**
 * The Worker: it answers the health check, signs each API request in, and
 * picks the workspace the request reaches before any task store is called. An
 * HTTP route goes to that workspace's store with the sender scoped to it; the
 * MCP endpoint is answered here, and each of its tool calls goes to the store
 * of the workspace its `workspace` argument names.
 */
import { isApiPath, MCP_PATH } from './api.ts';
import type { Authenticator } from './auth.ts';
import { json } from './http/respond.ts';
import { serveTaskMcp } from './mcp/server.ts';
import { workspaceStore } from './store/index.ts';
import { chooseWorkspace, scopedTo, WORKSPACE_HEADER, type Sender } from './workspaces.ts';

export interface WorkerOptions {
  /** How this deployment signs a request in. */
  readonly authenticator: (env: Env) => Authenticator;
}

export function createWorker(options: WorkerOptions) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname === '/healthz') return health(request);
      if (!isApiPath(pathname)) return json({ error: 'not_found' }, 404);
      try {
        const authenticator = options.authenticator(env);
        const sender = await signedIn(authenticator, request);
        if (!sender) return authenticator.challenge(request);
        if (pathname === MCP_PATH) {
          return await serveTaskMcp(request, sender.workspaces, (reach, name, args) =>
            workspaceStore(env, reach.workspace.id).callTool(name, args, scopedTo(sender, reach), reach.workspace),
          );
        }
        const chosen = chooseWorkspace(sender.workspaces, request.headers.get(WORKSPACE_HEADER));
        if ('refused' in chosen) return chosen.refused;
        return await workspaceStore(env, chosen.reach.workspace.id).serve(request, scopedTo(sender, chosen.reach));
      } catch {
        // A fault's message can carry storage internals: only the path is logged.
        console.error('request failed', pathname);
        return json({ error: 'internal_error' }, 500);
      }
    },
  } satisfies ExportedHandler<Env>;
}

async function signedIn(authenticator: Authenticator, request: Request): Promise<Sender | null> {
  try {
    return await authenticator.authenticate(request);
  } catch {
    // A sign-in that fails is a sign-in refused; the reason stays in the server log.
    console.error('sign-in failed');
    return null;
  }
}

/** Liveness only: it answers from the Worker itself and reads no binding. */
function health(request: Request): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, HEAD' });
  }
  return json({ ok: true }, 200);
}
