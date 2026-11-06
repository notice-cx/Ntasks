/**
 * The Worker: it answers the health check, signs each API request in, and
 * hands the request with its sender to the task store object, which holds
 * the tasks and answers it.
 */
import { isApiPath } from './api.ts';
import type { Authenticator } from './auth.ts';
import { json } from './http/respond.ts';
import { STORE_NAME } from './store/index.ts';

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
        const principal = await signedIn(authenticator, request);
        if (!principal) return authenticator.challenge(request);
        return await env.TASK_STORE.getByName(STORE_NAME).serve(request, principal);
      } catch {
        // A fault's message can carry storage internals: only the path is logged.
        console.error('request failed', pathname);
        return json({ error: 'internal_error' }, 500);
      }
    },
  } satisfies ExportedHandler<Env>;
}

async function signedIn(authenticator: Authenticator, request: Request) {
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
