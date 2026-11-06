/**
 * How the API learns who sent a request. Sign-in supplies an Authenticator;
 * every API and MCP request goes through it before any task is read or
 * written, and the health check is the only path that does not.
 */

/** What a signed-in sender may do. */
export const SCOPES = Object.freeze({
  /** Read projects, tasks, comments, history and changes. */
  read: 'tasks:read',
  /** Create and change tasks and comments. */
  write: 'tasks:write',
});

/** A signed-in sender. */
export interface Principal {
  /** A stable identity: retry records are kept per principal. */
  readonly id: string;
  /** The name the engine records as the filer, assignee, closer or author. */
  readonly name: string;
  readonly scopes: readonly string[];
}

export interface Authenticator {
  /** The sender of `request`, or null when it carries no valid sign-in. */
  authenticate(request: Request): Promise<Principal | null>;
  /** The 401 answer for a request with no valid sign-in, including any
   * header that tells a client where to sign in. */
  challenge(request: Request): Response;
}

/** The Authenticator until sign-in exists: it signs nobody in, so every API
 * and MCP request is refused. */
export const noSignIn: Authenticator = Object.freeze({
  authenticate: async () => null,
  challenge: () =>
    Response.json({ error: 'sign_in_required' }, { status: 401, headers: { 'cache-control': 'no-store' } }),
});
