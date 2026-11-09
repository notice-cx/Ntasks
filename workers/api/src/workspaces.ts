/**
 * Workspaces: one deployment holds several, and each keeps its tasks in its
 * own task store. Sign-in gives each sender the workspaces it reaches, with
 * what it may do in each; the Worker picks the one a request names and hands
 * the request to that workspace's store with a sender scoped to it, so a
 * store never sees another workspace's grants.
 */
import type { Principal, ProjectAccess } from './auth.ts';
import { json } from './http/respond.ts';

/** A workspace, as the task tools and the API name it. Its id is a UUID. */
export interface Workspace {
  readonly id: string;
  readonly name: string;
}

/** A person's role in a workspace. Both read, write and decide; an owner also
 * manages its members, invitations, projects and service credentials. */
export type WorkspaceRole = 'owner' | 'member';

/** One workspace a sender reaches, and what it may do there. */
export interface WorkspaceReach {
  readonly workspace: Workspace;
  /** A person's role from their membership; null for an agent or a service, which hold grants instead. */
  readonly role: WorkspaceRole | null;
  readonly scopes: readonly string[];
  /** Every project of the workspace, as a person reaches them, or the ones granted. */
  readonly projects: 'all' | ReadonlyMap<string, ProjectAccess>;
}

/** A signed-in sender, before the request has picked a workspace. */
export interface Sender {
  /** A stable identity: retry records are kept per principal. */
  readonly id: string;
  /** The name the engine records as the filer, assignee, closer or author. */
  readonly name: string;
  /** The actor name of the person the sender is, or acts for. Absent for a service. */
  readonly person?: string;
  /** The client id of the connected app the person acts through. */
  readonly app?: string;
  /** Every workspace the sender reaches, ordered by name. A service reaches
   * exactly the one its credential belongs to. */
  readonly workspaces: readonly WorkspaceReach[];
}

/** The header a person or an agent names a request's workspace in. MCP tool
 * calls name it in their `workspace` argument instead. */
export const WORKSPACE_HEADER = 'x-ntasks-workspace';

/** The name of a workspace's task store. */
export function storeName(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

/** The sender as one workspace's store sees it: that workspace's scopes and
 * projects, and nothing of any other workspace. */
export function scopedTo(sender: Sender, reach: WorkspaceReach): Principal {
  return Object.freeze({
    id: sender.id,
    name: sender.name,
    scopes: reach.scopes,
    projects: reach.projects,
    ...(sender.person === undefined ? {} : { person: sender.person }),
    ...(sender.app === undefined ? {} : { app: sender.app }),
  });
}

/** Workspaces by name, then id, so every list of them reads the same. */
export function byName(a: WorkspaceReach, b: WorkspaceReach): number {
  const [x, y] = [a.workspace, b.workspace];
  return x.name < y.name ? -1 : x.name > y.name ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}

/**
 * The workspace a request reaches: the one its header names, or the only one
 * the sender reaches when it names none. A workspace the sender does not
 * reach is answered as if it did not exist, so a sender learns nothing of
 * other workspaces.
 */
export function chooseWorkspace(
  workspaces: readonly WorkspaceReach[],
  named: string | null,
): { readonly reach: WorkspaceReach } | { readonly refused: Response } {
  if (named !== null) {
    const reach = workspaces.find((candidate) => candidate.workspace.id === named);
    return reach
      ? { reach }
      : { refused: json({ error: 'not_found', detail: 'no such workspace; GET /api/workspaces lists yours' }, 404) };
  }
  const [only] = workspaces;
  if (only && workspaces.length === 1) return { reach: only };
  if (!only) {
    return {
      refused: json({ error: 'not_found', detail: 'you reach no workspace; GET /api/workspaces lists yours' }, 404),
    };
  }
  return {
    refused: json(
      {
        error: 'workspace_required',
        detail: `you reach several workspaces; name one in the ${WORKSPACE_HEADER} header. GET /api/workspaces lists them`,
      },
      400,
    ),
  };
}
