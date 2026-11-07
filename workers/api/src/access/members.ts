/**
 * A workspace's people: its members, and the GitHub logins invited to join
 * it. An owner manages both through the routes in routes.ts. Sign-in
 * (auth.ts) admits a GitHub account only when it is a deployment admin, a
 * member of a workspace or invited to one, and turns its invitations into
 * memberships bound to its user, never to its login, which GitHub lets its
 * holder rename.
 */
import type { WorkspaceRole } from '../workspaces.ts';

export interface Member {
  readonly userId: string;
  readonly name: string;
  /** The GitHub login the member was invited under; null for one who joined
   * without an invitation, such as the workspace's creator. */
  readonly githubLogin: string | null;
  readonly role: WorkspaceRole;
}

/** An invitation nobody has accepted and no owner has revoked. */
export interface Invitation {
  readonly invitationId: string;
  readonly githubLogin: string;
  readonly role: WorkspaceRole;
  readonly createdAt: string;
  /** After this time the invitation admits nobody (INVITATION_DAYS). */
  readonly expiresAt: string;
}

/** How long an invitation admits its login. A login can be renamed and then
 * taken by someone else, so an invitation does not wait for ever. */
export const INVITATION_DAYS = 7;

/** A GitHub account as sign-in sees it, from the profile GitHub returned. */
export interface GitHubAccount {
  /** The numeric id, which never changes. */
  readonly id: string;
  /** The login, which its holder may rename and someone else may then take. */
  readonly login: string;
}

/**
 * A GitHub login as an owner types it: letters, digits and hyphens, at most
 * 39, starting with a letter or a digit. GitHub's own rule is stricter for new
 * accounts; older logins may end in a hyphen or hold two in a row.
 */
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;

/** The login an owner typed, without spaces or a leading @, or null when it cannot be a GitHub login. */
export function githubLoginOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const login = value.trim().replace(/^@/u, '');
  return GITHUB_LOGIN.test(login) ? login : null;
}

/** The id and login of a GitHub profile, or null when it holds neither as GitHub sends them. */
export function githubAccountOf(profile: Record<string, unknown> | undefined): GitHubAccount | null {
  const id = profile?.id;
  const login = profile?.login;
  if ((typeof id !== 'number' && typeof id !== 'string') || typeof login !== 'string') return null;
  return { id: String(id), login };
}

/** Matches the open, unexpired invitations of login `?` at time `?`, the
 * login compared without case, as the index workspace_invitations_by_login
 * holds them. */
const OPEN_FOR_LOGIN =
  'lower(github_login) = lower(?) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?';

/**
 * Whether a GitHub account that is not a deployment admin may sign in: it is
 * already a member of a workspace, found through its GitHub id, or its login
 * holds an open invitation.
 */
export async function mayJoin(db: D1Database, account: GitHubAccount): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM auth_account a JOIN workspace_members m ON m.user_id = a.user_id
           WHERE a.provider_id = 'github' AND a.account_id = ?) AS member,
         EXISTS (SELECT 1 FROM workspace_invitations WHERE ${OPEN_FOR_LOGIN}) AS invited`,
    )
    .bind(account.id, account.login, new Date().toISOString())
    .first<{ member: number; invited: number }>();
  return row !== null && (row.member === 1 || row.invited === 1);
}

/**
 * Turns every open invitation of `login` into a membership of `userId`, in
 * one batch, and records who accepted each and when. A person who is already
 * a member keeps their membership; an invitation as owner makes them one.
 */
export async function acceptInvitations(db: D1Database, userId: string, login: string): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         SELECT workspace_id, ?, role, ? FROM workspace_invitations WHERE ${OPEN_FOR_LOGIN}
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner' WHERE excluded.role = 'owner'`,
      )
      .bind(userId, now, login, now),
    db
      .prepare(`UPDATE workspace_invitations SET accepted_by = ?, accepted_at = ? WHERE ${OPEN_FOR_LOGIN}`)
      .bind(userId, now, login, now),
  ]);
}

/** Whether the setup page recorded this GitHub account, by its numeric id, as a deployment admin. */
export async function isRecordedAdmin(db: D1Database, githubId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS found FROM access_deployment_admins WHERE github_id = ?')
    .bind(githubId)
    .first();
  return row !== null;
}

/** Whether the user is a member of any workspace. */
export async function isMember(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS found FROM workspace_members WHERE user_id = ? LIMIT 1')
    .bind(userId)
    .first();
  return row !== null;
}

/** A workspace's members, by name, and its open, unexpired invitations, newest first. */
export async function listMembers(
  db: D1Database,
  workspaceId: string,
): Promise<{ readonly members: Member[]; readonly invitations: Invitation[] }> {
  const [members, invitations] = await db.batch([
    db
      .prepare(
        `SELECT m.user_id, u.name, m.role,
           (SELECT i.github_login FROM workspace_invitations i
             WHERE i.workspace_id = m.workspace_id AND i.accepted_by = m.user_id
             ORDER BY i.accepted_at DESC LIMIT 1) AS github_login
         FROM workspace_members m JOIN auth_user u ON u.id = m.user_id
         WHERE m.workspace_id = ? ORDER BY u.name, m.user_id`,
      )
      .bind(workspaceId),
    db
      .prepare(
        `SELECT id, github_login, role, created_at, expires_at FROM workspace_invitations
         WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC, id`,
      )
      .bind(workspaceId, new Date().toISOString()),
  ]);
  return {
    members: (members?.results ?? []).map((row) => {
      const member = row as { user_id: string; name: string; role: WorkspaceRole; github_login: string | null };
      return { userId: member.user_id, name: member.name, githubLogin: member.github_login, role: member.role };
    }),
    invitations: (invitations?.results ?? []).map((row) => {
      const invitation = row as {
        id: string;
        github_login: string;
        role: WorkspaceRole;
        created_at: string;
        expires_at: string;
      };
      return {
        invitationId: invitation.id,
        githubLogin: invitation.github_login,
        role: invitation.role,
        createdAt: invitation.created_at,
        expiresAt: invitation.expires_at,
      };
    }),
  };
}

/** Invites a GitHub login to a workspace; null when the login already has an
 * open, unexpired invitation there. An expired one is set aside first. */
export async function createInvitation(
  db: D1Database,
  input: {
    readonly workspaceId: string;
    readonly githubLogin: string;
    readonly role: WorkspaceRole;
    readonly createdBy: string;
  },
): Promise<Invitation | null> {
  const id = crypto.randomUUID();
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + INVITATION_DAYS * 86_400_000).toISOString();
  const [, inserted] = await db.batch<{ id: string }>([
    // An expired invitation still holds the one open place per login, which
    // the unique index keeps; it is revoked so the new one can take it.
    db
      .prepare(
        `UPDATE workspace_invitations SET revoked_at = ?
         WHERE workspace_id = ? AND lower(github_login) = lower(?)
           AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= ?`,
      )
      .bind(createdAt, input.workspaceId, input.githubLogin, createdAt),
    // The only unique key besides the id is one open invitation per login in a workspace.
    db
      .prepare(
        `INSERT INTO workspace_invitations (id, workspace_id, github_login, role, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
      )
      .bind(id, input.workspaceId, input.githubLogin, input.role, input.createdBy, createdAt, expiresAt),
  ]);
  if ((inserted?.results ?? []).length === 0) return null;
  return { invitationId: id, githubLogin: input.githubLogin, role: input.role, createdAt, expiresAt };
}

/** Revokes an open invitation of a workspace. False when it has no such open invitation. */
export async function revokeInvitation(db: D1Database, workspaceId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE workspace_invitations SET revoked_at = ?1
       WHERE id = ?2 AND workspace_id = ?3 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?1`,
    )
    .bind(new Date().toISOString(), id, workspaceId)
    .run();
  return result.meta.changes === 1;
}

/**
 * Removes a member from a workspace, with the project grants their agents
 * hold there, in one batch. The sign-in checks read memberships on every
 * request, so the person's session and their agents stop reaching the
 * workspace at their next request; the grants go too, so inviting the
 * person again does not give their agents the workspace back unasked.
 *
 * `last_owner` when the member is the workspace's only owner: a workspace
 * keeps at least one. The check is part of the statement that removes, so
 * two owners removing each other at once cannot leave none.
 */
export async function removeMember(
  db: D1Database,
  workspaceId: string,
  userId: string,
): Promise<'removed' | 'last_owner' | 'not_found'> {
  const now = new Date().toISOString();
  const [removed] = await db.batch([
    db
      .prepare(
        `DELETE FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2
         AND (role = 'member' OR EXISTS (SELECT 1 FROM workspace_members o
           WHERE o.workspace_id = ?1 AND o.role = 'owner' AND o.user_id <> ?2))`,
      )
      .bind(workspaceId, userId),
    db
      .prepare(
        `DELETE FROM access_agent_grants WHERE workspace_id = ?1 AND user_id = ?2
         AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2)`,
      )
      .bind(workspaceId, userId),
    // Nothing the person made or was offered here may bring them, or someone
    // they control, back in: invitations they sent, invitations still open for
    // a login they joined under, and the service credentials they hold the
    // token of. Each runs only once the membership is gone.
    db
      .prepare(
        `UPDATE workspace_invitations SET revoked_at = ?3
         WHERE workspace_id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL
           AND (created_by = ?2 OR lower(github_login) IN (SELECT lower(github_login) FROM workspace_invitations
             WHERE workspace_id = ?1 AND accepted_by = ?2))
           AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2)`,
      )
      .bind(workspaceId, userId, now),
    db
      .prepare(
        `UPDATE access_service_credentials SET revoked_at = ?3
         WHERE workspace_id = ?1 AND created_by = ?2 AND revoked_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2)`,
      )
      .bind(workspaceId, userId, now),
    // An agent left with no grant anywhere loses its approval too, so asking
    // again shows the approval page instead of a token that reaches nothing.
    db
      .prepare(
        `DELETE FROM auth_oauth_consent WHERE user_id = ?2
           AND client_id NOT IN (SELECT client_id FROM access_agent_grants WHERE user_id = ?2)
           AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2)`,
      )
      .bind(workspaceId, userId),
  ]);
  if ((removed?.meta.changes ?? 0) > 0) return 'removed';
  const still = await db
    .prepare('SELECT 1 AS found FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .bind(workspaceId, userId)
    .first<{ found: number }>();
  return still === null ? 'not_found' : 'last_owner';
}
