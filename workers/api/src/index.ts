/**
 * The Ntasks Worker. Only the paths wrangler.jsonc lists in
 * `assets.run_worker_first` reach this handler; the web app's files are served
 * before it runs.
 */
import { handleAccess } from './access/index.ts';
import { createApi } from './api.ts';
import { noSignIn } from './auth.ts';
import { createEngine } from './engine/index.ts';
import { json } from './http/respond.ts';

export default {
  /** The health check, then the sign-in paths, then the API; any other path that reaches the Worker is a JSON 404. */
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/healthz') return health(request);
    const access = await handleAccess(request, env);
    if (access) return access;
    if (!pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
    try {
      const api = createApi({
        engine: createEngine(env.DB),
        // noSignIn refuses every API request. Sign-in's authenticator
        // (access/index.ts) does not replace it yet: the API's Principal
        // carries no project limits, and an agent or a service may reach only
        // the projects it was granted.
        authenticator: noSignIn,
        workspace: { id: env.WORKSPACE_ID, name: env.WORKSPACE_NAME },
      });
      return await api.fetch(request);
    } catch {
      // A fault's message can carry storage internals: only the path is logged.
      console.error('request failed', pathname);
      return json({ error: 'internal_error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/** Liveness only: it answers from the Worker itself and reads no binding. */
function health(request: Request): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, HEAD' });
  }
  return json({ ok: true }, 200);
}
