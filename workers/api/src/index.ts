/**
 * The Ntasks Worker. Only the paths wrangler.jsonc lists in
 * `assets.run_worker_first` reach this handler; the web app's files are served
 * before it runs.
 */
import { createApi } from './api.ts';
import { noSignIn } from './auth.ts';
import { createEngine } from './engine/index.ts';
import { json } from './http/respond.ts';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/healthz') return health(request);
    if (!pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
    try {
      const api = createApi({
        engine: createEngine(env.DB),
        // Every API request is refused until sign-in is in place.
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
