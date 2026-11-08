/**
 * How the API learns who sent a request. Sign-in supplies an Authenticator;
 * every API and MCP request goes through it before any task is read or
 * written, and the health check is the only path that does not. The sender it
 * gives reaches some workspaces (workspaces.ts); a workspace's store sees the
 * sender as a Principal scoped to that workspace.
 */
import type { Sender } from './workspaces.ts';

/** What a signed-in sender may do. */
export const SCOPES = Object.freeze({
  /** Read projects, tasks, comments, history and changes. */
  read: 'tasks:read',
  /** Create and change tasks and comments. */
  write: 'tasks:write',
  /** Read every row of the store for a backup, whatever projects the sender reaches (GET /api/backup). */
  backup: 'tasks:backup',
  /** Load rows into the store while it is empty, such as an import or a backup (POST /api/restore). */
  restore: 'tasks:restore',
  /** Answer a decision, approve an approval or dispute one an agent recorded:
   * a person's own act. Only a person signed in to the web app holds it; no
   * agent or service does, whatever it was granted. */
  decide: 'tasks:decide',
  /** Create projects in the workspace: an owner's act. No agent or service holds it. */
  manage: 'workspace:manage',
});

/** How far a sender may go in one project. Write includes read. */
export type ProjectAccess = 'read' | 'write';

/** A signed-in sender, as one workspace's store sees it. */
export interface Principal {
  /** A stable identity: retry records are kept per principal. */
  readonly id: string;
  /** The name the engine records as the filer, assignee, closer or author. */
  readonly name: string;
  /** What the sender may do in the workspace; `projects` says where. */
  readonly scopes: readonly string[];
  /** The projects of the workspace the sender reaches: every one, as a
   * person does, or the ones it was granted, each for reading or for writing too. */
  readonly projects: 'all' | ReadonlyMap<string, ProjectAccess>;
  /** The actor name of the person the sender is, or acts for: a pick the
   * sender relays records them as the one who chose. Absent for a service. */
  readonly person?: string;
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
  /** The sender of `request`, with the workspaces it reaches, or null when it carries no valid sign-in. */
  authenticate(request: Request): Promise<Sender | null>;
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
