/**
 * The public workspace: at most one workspace of a deployment that anyone may
 * read without signing in, such as a product demo's, named by the optional
 * setting PUBLIC_WORKSPACE_ID. A request that carries no credential at all and
 * names that workspace in the x-ntasks-workspace header is signed in as a
 * visitor, who reads every project there and changes nothing. Any other
 * request without a credential is refused as before, so an MCP client that
 * names no workspace is still told where to sign in.
 */
import type { Workspace } from '../workspaces.ts';
import { WORKSPACE_HEADER } from '../workspaces.ts';
import { WORKSPACE_ID } from './grants.ts';
import type { VisitorPrincipal } from './principal.ts';

export interface PublicWorkspaceEnv {
  readonly DB: D1Database;
  /** The id of the workspace anyone may read. A value that is not a lowercase workspace id turns it off. */
  readonly PUBLIC_WORKSPACE_ID?: string;
}

/** The public workspace's id, or null when the deployment has none. */
export function publicWorkspaceId(env: PublicWorkspaceEnv): string | null {
  const id = env.PUBLIC_WORKSPACE_ID?.trim() ?? '';
  return WORKSPACE_ID.test(id) ? id : null;
}

/**
 * The visitor a request with no credential is, when it names the public
 * workspace and that workspace exists; null otherwise. The caller has already
 * found that the request carries no credential.
 */
export async function visitorOf(request: Request, env: PublicWorkspaceEnv): Promise<VisitorPrincipal | null> {
  const id = publicWorkspaceId(env);
  if (id === null || request.headers.get(WORKSPACE_HEADER) !== id) return null;
  const row = await env.DB.prepare('SELECT id, name FROM workspaces WHERE id = ?').bind(id).first<Workspace>();
  if (!row) return null;
  return Object.freeze({
    kind: 'visitor',
    id: 'visitor',
    name: 'anyone',
    workspace: Object.freeze({ id: row.id, name: row.name }),
  });
}
