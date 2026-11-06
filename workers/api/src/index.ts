/**
 * The Ntasks Worker. Only the paths wrangler.jsonc lists in
 * `assets.run_worker_first` reach this handler; the web app's files are served
 * before it runs.
 */
import { handleAccess } from './access/index.ts';
import { json } from './http.ts';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/healthz') return health(request);
    const access = await handleAccess(request, env);
    if (access) return access;
    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<Env>;

/** Liveness only: it answers from the Worker itself and reads no binding. */
function health(request: Request): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, HEAD' });
  }
  return json({ ok: true }, 200);
}
