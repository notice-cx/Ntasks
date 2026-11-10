/**
 * The HTTP API's version. The API only adds: a route, a parameter or a field
 * of an answer is never renamed, removed or given another type, so a client
 * made for one version works with every later one. Each addition is one file
 * in ../api-versions/, which records the fields it added, and API_VERSION is
 * how many files there are; scripts/api-versions.ts lists them in
 * api-versions.generated.json. OLDEST_API_VERSION goes up only when the owner
 * removes something, to the first version without it (docs/api.md#versions).
 */
import API_VERSIONS from './api-versions.generated.json';

export const API_VERSION = API_VERSIONS.length;
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
