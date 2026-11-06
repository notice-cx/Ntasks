/**
 * The Ntasks Worker. Only the paths wrangler.jsonc lists in
 * `assets.run_worker_first` reach this handler; the web app's files are served
 * before it runs.
 */
export default {
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/healthz') return health(request);
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

/** Each answer holds the state at the time of its request; `no-store` keeps caches from serving it again. */
function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...headers, 'cache-control': 'no-store' } });
}
