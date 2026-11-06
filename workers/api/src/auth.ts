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

/** How far a sender may go in one project. Write includes read. */
export type ProjectAccess = 'read' | 'write';

/** A signed-in sender. */
export interface Principal {
  /** A stable identity: retry records are kept per principal. */
  readonly id: string;
  /** The name the engine records as the filer, assignee, closer or author. */
  readonly name: string;
  /** What the sender may do somewhere; `projects` says where. */
  readonly scopes: readonly string[];
  /** The projects the sender reaches: every one, as the owner does, or the
   * ones it was granted, each for reading or for writing too. */
  readonly projects: 'all' | ReadonlyMap<string, ProjectAccess>;
}

/** Whether the sender may read the project's tasks, or with `write`, change them. */
export function mayReach(principal: Principal, projectId: string, needed: ProjectAccess = 'read'): boolean {
  if (principal.projects === 'all') return true;
  const access = principal.projects.get(projectId);
  return access === 'write' || (access === 'read' && needed === 'read');
}

/** The projects of `projects` that the sender may read, in the same order. A
 * project it may not reach is answered as if it did not exist, so a sender
 * learns nothing of another's projects. */
export function reachable<T extends { readonly id: string }>(principal: Principal, projects: readonly T[]): T[] {
  return projects.filter((project) => mayReach(principal, project.id));
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
