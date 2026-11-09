/**
 * The HTTP API's version, the one copy of it. The API only adds: a route, a
 * parameter or a field of an answer is never renamed, removed or given
 * another type, so a client made for one version works with every later one.
 * API_VERSION goes up by one with each addition, which
 * test/fixtures/http-api.json records under the new version. OLDEST_API_VERSION
 * goes up only when the owner removes something, to the first version
 * without it (docs/api.md#versions).
 */
export const API_VERSION = 6;
export const OLDEST_API_VERSION = 1;

/** Every answer under /api carries API_VERSION in this header. */
export const API_VERSION_HEADER = 'x-ntasks-api-version';

/** Answers the versions before sign-in, so a client can check them before it sends a person to sign in. */
export const VERSION_PATH = '/api/version';

/** The answer with the version header, on a copy, since a redirect's headers cannot change. */
export function versioned(response: Response): Response {
  const answer = new Response(response.body, response);
  answer.headers.set(API_VERSION_HEADER, String(API_VERSION));
  return answer;
}
