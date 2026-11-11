import { createHttpTasksApi, SIGN_IN_PATH, type TasksApi } from './client';

/**
 * The version of the Ntasks HTTP API these pages are made for. An Ntasks
 * names its own in the `x-ntasks-api-version` header of every answer and in
 * `GET /api/version` (docs/api.md, "Versions"); one whose version is lower
 * lacks something these pages read.
 */
export const API_VERSION = 20;

/** How the pages' requests say who is asking. */
export interface TokenSource {
  /**
   * The bearer token for the next request, or null to send none. It is asked
   * before every request, so it answers from memory and refreshes its token
   * itself; a write sent while the page closes waits for it.
   */
  token(): string | null | Promise<string | null>;
  /** What Sign in does after a request answers that nobody is signed in: an address to open, or a function to call. */
  signIn: string | (() => void);
}

/**
 * `apiOrigin` as an origin, such as `https://tasks.example.com`. An address
 * that is none, or that is not on the web (`data:`, `file:`), is refused by
 * name.
 */
export function originOf(apiOrigin: string): string {
  let url: URL | null = null;
  try {
    url = new URL(apiOrigin);
  } catch {
    url = null;
  }
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new Error(`apiOrigin must be an origin such as https://tasks.example.com, not ${JSON.stringify(apiOrigin)}.`);
  }
  return url.origin;
}

/**
 * The Ntasks session cookie: the default, for pages served by the Ntasks
 * Worker itself. It sends no token, since the browser sends the cookie to its
 * own origin, and Sign in opens the Worker's sign-in page.
 */
export function sessionCookie(apiOrigin?: string): TokenSource {
  return { token: () => null, signIn: apiOrigin === undefined ? SIGN_IN_PATH : new URL(SIGN_IN_PATH, apiOrigin).href };
}

/**
 * The Tasks API at `apiOrigin`, each request carrying the token `source()`
 * names when it is sent. Left out, `apiOrigin` is the page's own origin.
 */
export function connect(apiOrigin: string | undefined, source: () => TokenSource): TasksApi {
  return createHttpTasksApi(async (input, init = {}) => {
    const token = await source().token();
    const headers = new Headers(init.headers);
    if (token !== null) headers.set('authorization', `Bearer ${token}`);
    const address = apiOrigin === undefined ? input : new URL(input, apiOrigin).href;
    return fetch(address, { ...init, headers, credentials: 'same-origin' });
  });
}
