/**
 * Ntasks' own access records: the workspaces and their owners, the projects
 * each agent may reach in each workspace, and the named service credentials
 * of each workspace with their project grants. They are managed through the
 * routes in routes.ts.
 */
import { NTASKS_ACTOR } from '@ntasks/domain';
import { workspaceStore, type StoreBinding } from '../store/index.ts';
import type { Workspace } from '../workspaces.ts';
import { hex, randomSecret, sha256 } from './crypto.ts';
import type { ProjectAccess } from './principal.ts';
import { notAnApp } from './protocol.ts';
import { serviceToken } from './service-token.ts';

/** The bindings the grant records read projects through. */
export type ProjectSource = StoreBinding;

export interface ProjectGrant {
  readonly projectId: string;
  readonly access: ProjectAccess;
}

/** A project grant of an agent, which names the workspace it is in. */
export interface AgentGrant extends ProjectGrant {
  readonly workspaceId: string;
}

export interface ProjectSummary {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

/** Why a change to access records was refused, and the body field at fault when one is. */
export class AccessRefused extends Error {
  override name = 'AccessRefused';
  constructor(
    readonly code: 'invalid_request' | 'unknown_project' | 'name_taken' | 'not_found',
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

/** A workspace's name: one line of 1 to 128 characters, without spaces at either end. */
export function workspaceNameOf(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim() : '';
  return name.length >= 1 && name.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(name) ? name : null;
}

/** A workspace id as a request may give one: a lowercase UUID. */
export const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Creates a workspace with `userId` as its owner, in one batch. Its task store
 * is created by the first request that reaches it. False when a workspace
 * already has this id.
 */
export async function createWorkspace(db: D1Database, workspace: Workspace, userId: string): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    await db.batch([
      db
        .prepare('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)')
        .bind(workspace.id, workspace.name, userId, now),
      db
        .prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
        .bind(workspace.id, userId, now),
    ]);
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed: workspaces.id')) return false;
    throw error;
  }
  return true;
}

/**
 * Renames a workspace. The name is only shown: its task store and every
 * request name the workspace by its id, and each request reads the name
 * from this row, so nothing else keeps a copy.
 */
export async function renameWorkspace(db: D1Database, workspace: Workspace): Promise<void> {
  await db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').bind(workspace.name, workspace.id).run();
}

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;

/** Grants from untrusted input: each project once, with read or write. */
export function parseGrants(value: unknown): ProjectGrant[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new AccessRefused('invalid_request', 'grants must list 1 to 200 projects', 'grants');
  }
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    const grant = item as { projectId?: unknown; access?: unknown } | null;
    const projectId = grant?.projectId;
    const access = grant?.access;
    if (
      typeof projectId !== 'string' ||
      projectId.length === 0 ||
      projectId.length > 255 ||
      seen.has(projectId) ||
      (access !== 'read' && access !== 'write')
    ) {
      throw new AccessRefused(
        'invalid_request',
        'each grant names a project once, with access read or write',
        'grants',
      );
    }
    seen.add(projectId);
    return { projectId, access };
  });
}

/**
 * Every project of a workspace, by key, read from its task store. The
 * approval page lists them all and checks the person's choices against them,
 * so it has no limit: a project left off would be one they could not grant.
 */
export async function listProjects(env: ProjectSource, workspaceId: string): Promise<ProjectSummary[]> {
  const projects = await workspaceStore(env, workspaceId).projects();
  return projects
    .map(({ id, key, name }) => ({ id, key, name }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Fails as unknown_project unless every grant names one of `projects`. The
 * grant tables cannot reference the task store's projects, so every grant is
 * checked here before it is recorded.
 */
export function assertProjectsExist(projects: readonly ProjectSummary[], grants: readonly ProjectGrant[]): void {
  const known = new Set(projects.map((project) => project.id));
  if (!grants.every((grant) => known.has(grant.projectId))) {
    throw new AccessRefused('unknown_project', 'a grant names a project that does not exist', 'grants');
  }
}

/**
 * Replaces the projects an agent may reach for a person, in every workspace,
 * in one batch. Called when the person approves the agent, before its consent
 * is recorded, with grants already checked against each workspace's projects.
 */
export async function setAgentGrants(
  db: D1Database,
  userId: string,
  clientId: string,
  grants: readonly AgentGrant[],
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('DELETE FROM access_agent_grants WHERE user_id = ? AND client_id = ?').bind(userId, clientId),
    ...grants.map((grant) =>
      db
        // Only while the person is still a member: a removal between reading
        // the approval page and writing here leaves no grant behind.
        .prepare(
          `INSERT INTO access_agent_grants (user_id, client_id, workspace_id, project_id, access, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6
           WHERE EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ?3 AND user_id = ?1)`,
        )
        .bind(userId, clientId, grant.workspaceId, grant.projectId, grant.access, now),
    ),
  ]);
}

export interface ConnectedAgent {
  readonly clientId: string;
  readonly name: string | null;
  readonly uri: string | null;
  readonly scopes: readonly string[];
  readonly approvedAt: string;
  readonly grants: readonly AgentGrant[];
}

/** The agents a person approved and has not revoked. The connected apps they signed in to are listed with their workspace's apps (apps.ts). */
export async function listAgents(db: D1Database, userId: string): Promise<ConnectedAgent[]> {
  const { results } = await db
    .prepare(
      `SELECT k.client_id, c.name, c.uri, k.scopes, max(k.updated_at) AS approved_at,
         (SELECT json_group_array(json_object('workspaceId', g.workspace_id, 'projectId', g.project_id, 'access', g.access))
           FROM access_agent_grants g WHERE g.user_id = k.user_id AND g.client_id = k.client_id) AS grants
       FROM auth_oauth_consent k JOIN auth_oauth_client c ON c.client_id = k.client_id
       WHERE k.user_id = ? AND ${notAnApp('c.reference_id')}
       GROUP BY k.client_id ORDER BY approved_at DESC LIMIT 200`,
    )
    .bind(userId)
    .all<{
      client_id: string;
      name: string | null;
      uri: string | null;
      scopes: string;
      approved_at: string;
      grants: string;
    }>();
  return results.map((row) => ({
    clientId: row.client_id,
    name: row.name,
    uri: row.uri,
    scopes: JSON.parse(row.scopes) as string[],
    approvedAt: row.approved_at,
    grants: JSON.parse(row.grants) as AgentGrant[],
  }));
}

/**
 * Revokes an agent or a connected app for a person, in one batch: its
 * project grants and the person's consent go, and every access and refresh
 * token it holds for the person is marked revoked. Its next call is refused,
 * and its next refresh. False when the person had not allowed it.
 */
export async function revokeAgent(db: D1Database, userId: string, clientId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const [, , , consents] = await db.batch([
    db.prepare('DELETE FROM access_agent_grants WHERE user_id = ? AND client_id = ?').bind(userId, clientId),
    db
      .prepare('UPDATE auth_oauth_access_token SET revoked = ? WHERE user_id = ? AND client_id = ? AND revoked IS NULL')
      .bind(now, userId, clientId),
    db
      .prepare(
        'UPDATE auth_oauth_refresh_token SET revoked = ? WHERE user_id = ? AND client_id = ? AND revoked IS NULL',
      )
      .bind(now, userId, clientId),
    db.prepare('DELETE FROM auth_oauth_consent WHERE user_id = ? AND client_id = ?').bind(userId, clientId),
  ]);
  return (consents?.meta.changes ?? 0) > 0;
}

export interface ServiceCredential {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly grants: readonly ProjectGrant[];
  /** Whether it may read its workspace's whole store for a backup (GET /api/backup). */
  readonly backup: boolean;
  /** Whether it may load rows into its workspace's store while it is empty (POST /api/restore). */
  readonly restore: boolean;
}

/**
 * Makes a credential in a workspace and returns it with its token, which is
 * never shown again. A backup or restore credential may have no project
 * grants: it reaches the workspace's store only through the backup and
 * restore routes.
 */
export async function createServiceCredential(
  db: D1Database,
  input: {
    readonly workspaceId: string;
    readonly name: unknown;
    readonly grants: unknown;
    readonly backup?: unknown;
    readonly restore?: unknown;
    readonly createdBy: string;
    /** The workspace's projects, which every grant must name. */
    readonly projects: readonly ProjectSummary[];
  },
): Promise<ServiceCredential & { readonly token: string }> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!NAME.test(name)) {
    throw new AccessRefused(
      'invalid_request',
      'name is 1 to 64 letters, digits, spaces, dots, dashes or underscores',
      'name',
    );
  }
  // A service's actor is service:<name>, and Ntasks records its own changes as service:Ntasks (NTASKS_ACTOR).
  if (`service:${name}`.toLowerCase() === NTASKS_ACTOR.toLowerCase()) {
    throw new AccessRefused('invalid_request', `name ${name} is the one Ntasks records its own changes under`, 'name');
  }
  for (const choice of ['backup', 'restore'] as const) {
    if (input[choice] !== undefined && typeof input[choice] !== 'boolean') {
      throw new AccessRefused('invalid_request', `${choice} is true or false`, choice);
    }
  }
  const backup = input.backup === true;
  const restore = input.restore === true;
  const noGrants = input.grants === undefined || (Array.isArray(input.grants) && input.grants.length === 0);
  const grants = (backup || restore) && noGrants ? [] : parseGrants(input.grants);
  assertProjectsExist(input.projects, grants);
  const id = crypto.randomUUID();
  const secret = randomSecret(32);
  const createdAt = new Date().toISOString();
  try {
    await db.batch([
      db
        .prepare(
          'INSERT INTO access_service_credentials (id, workspace_id, name, secret_hash, created_by, created_at, backup, restore) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          id,
          input.workspaceId,
          name,
          hex(await sha256(secret)),
          input.createdBy,
          createdAt,
          backup ? 1 : 0,
          restore ? 1 : 0,
        ),
      ...grants.map((grant) =>
        db
          .prepare('INSERT INTO access_service_grants (credential_id, project_id, access) VALUES (?, ?, ?)')
          .bind(id, grant.projectId, grant.access),
      ),
    ]);
  } catch (error) {
    // The unique key is the workspace and the name: another workspace may use the same name.
    if (String(error).includes('UNIQUE constraint failed: access_service_credentials.workspace_id')) {
      throw new AccessRefused('name_taken', 'a service credential in this workspace already has this name', 'name');
    }
    throw error;
  }
  return { id, name, createdAt, revokedAt: null, grants, backup, restore, token: serviceToken(id, secret) };
}

/** A workspace's service credentials, newest first. */
export async function listServiceCredentials(db: D1Database, workspaceId: string): Promise<ServiceCredential[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.name, c.created_at, c.revoked_at, c.backup, c.restore,
         (SELECT json_group_array(json_object('projectId', g.project_id, 'access', g.access)) FROM access_service_grants g
           WHERE g.credential_id = c.id) AS grants
       FROM access_service_credentials c WHERE c.workspace_id = ? ORDER BY c.created_at DESC LIMIT 200`,
    )
    .bind(workspaceId)
    .all<{
      id: string;
      name: string;
      created_at: string;
      revoked_at: string | null;
      backup: number;
      restore: number;
      grants: string;
    }>();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    grants: JSON.parse(row.grants) as ProjectGrant[],
    backup: row.backup === 1,
    restore: row.restore === 1,
  }));
}

/** Revokes a workspace's credential: its next request is refused. False when
 * the workspace has no such unrevoked credential. */
export async function revokeServiceCredential(db: D1Database, workspaceId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      'UPDATE access_service_credentials SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL',
    )
    .bind(new Date().toISOString(), id, workspaceId)
    .run();
  return result.meta.changes === 1;
}

/**
 * At most this many agents register in one UTC day, across every Cloudflare
 * location. Each registration writes a handful of rows, so the budget keeps
 * registrations far below the free plan's 100,000 rows written a day.
 */
export const REGISTRATIONS_PER_DAY = 100;

/** The UTC day of `now`, such as 2026-11-06, which registrations are counted under. */
export function registrationDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** How many agents registered on `day`. */
export async function registrationsOn(db: D1Database, day: string): Promise<number> {
  const row = await db
    .prepare('SELECT registrations FROM access_registration_days WHERE day = ?')
    .bind(day)
    .first<{ registrations: number }>();
  return row?.registrations ?? 0;
}

/**
 * Takes one registration from `day`'s budget before the library creates the
 * client, or returns false when the budget is spent. One statement checks
 * and counts, so registrations arriving at once cannot take more than the
 * budget, and a spent budget writes nothing. A taken registration is not
 * given back if the library then refuses it: failed attempts are bounded by
 * the same budget as successful ones.
 */
export async function takeRegistration(db: D1Database, day: string): Promise<boolean> {
  const taken = await db
    .prepare(
      `INSERT INTO access_registration_days (day, registrations) VALUES (?, 1)
       ON CONFLICT (day) DO UPDATE SET registrations = registrations + 1 WHERE registrations < ?
       RETURNING registrations`,
    )
    .bind(day, REGISTRATIONS_PER_DAY)
    .first<{ registrations: number }>();
  return taken !== null;
}
