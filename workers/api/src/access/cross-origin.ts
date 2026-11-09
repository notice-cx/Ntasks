/**
 * Calls from a connected app's page in a browser: CORS for every path under
 * /api, the token endpoint included, from the origin of an enabled app's
 * redirect address alone (apps.ts). Credentials stay off: no answer carries
 * Access-Control-Allow-Credentials, so a browser lets the app read only what
 * it asked for with its bearer token, never an answer signed by the person's
 * session cookie. A request from this deployment's own origin, or with no
 * Origin header, is not a cross-origin call and passes through unchanged.
 */
import { IDEMPOTENCY_HEADER } from '../http/writes.ts';
import { API_VERSION_HEADER } from '../version.ts';
import { WORKSPACE_HEADER } from '../workspaces.ts';
import { isAppOrigin } from './apps.ts';

const API_PREFIX = '/api/';
const METHODS = 'GET, POST, PATCH';
/** The headers an app sends: its token, a JSON body, the workspace and a retry key. */
const HEADERS = `authorization, content-type, ${WORKSPACE_HEADER}, ${IDEMPOTENCY_HEADER}`;
/** The headers an app may read: a bearer challenge, when to retry, and the API's version. */
const EXPOSED = `www-authenticate, retry-after, ${API_VERSION_HEADER}`;
const PREFLIGHT_SECONDS = '600';
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `answer`, answered for a connected app's page when the request comes from one. */
export async function crossOrigin(
  request: Request,
  db: D1Database,
  answer: () => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (!url.pathname.startsWith(API_PREFIX) || origin === null || origin === url.origin) return answer();
  const allowed = await isAppOrigin(db, origin);
  if (request.method === 'OPTIONS' && request.headers.has('access-control-request-method')) {
    if (!allowed) {
      return Response.json(
        { error: 'origin_not_allowed', detail: 'no connected app runs at this origin' },
        { status: 403, headers: { 'cache-control': 'no-store', vary: 'origin' } },
      );
    }
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': METHODS,
        'access-control-allow-headers': HEADERS,
        'access-control-max-age': PREFLIGHT_SECONDS,
        vary: 'origin',
      },
    });
  }
  // A browser that kept an earlier preflight may still send a write after the
  // app is removed. A write with a bearer token is refused here unless its
  // origin is an app's now; one signed by a cookie is refused as cross-site
  // by the verifier.
  if (!allowed && !READS.has(request.method) && request.headers.has('authorization')) {
    return Response.json(
      { error: 'origin_not_allowed', detail: 'no connected app runs at this origin' },
      { status: 403, headers: { 'cache-control': 'no-store', vary: 'origin' } },
    );
  }
  const response = await answer();
  if (!allowed) return response;
  // An answer may come with headers that cannot change, such as a task store's.
  const readable = new Response(response.body, response);
  readable.headers.set('access-control-allow-origin', origin);
  readable.headers.set('access-control-expose-headers', EXPOSED);
  readable.headers.append('vary', 'origin');
  return readable;
}
