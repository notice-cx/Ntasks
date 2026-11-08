/**
 * The token verifier: who sent a request, checked against the database on
 * every call. The API and MCP layers call `verifyRequest` before anything
 * else and answer a refusal with `refusal`.
 *
 * A request signs in one of three ways:
 *
 * - **A person**: the session cookie that signing in with GitHub sets. The
 *   person must still be a deployment admin or a member of a workspace. They
 *   reach the workspaces they are members of.
 * - **An AI agent**: an OAuth access token as a bearer token. The token must
 *   be unexpired and unrevoked, its client enabled, the person's consent
 *   still in place and the person still an admin or a member. It reaches
 *   only the projects the person granted it, in workspaces the person still
 *   belongs to.
 * - **A service**: a service credential as a bearer token, unrevoked. It
 *   reaches its credential's one workspace: the projects named in its grants,
 *   the whole store for a backup when its owner made it a backup credential,
 *   and loads into an empty store when its owner made it a restore credential.
 *
 * Each check is one D1 query, which also reads the sender's workspaces, and
 * never builds Better Auth, to keep a call's CPU time low: revoking a token, a
 * consent, a grant, a membership or a credential cuts the sender off at its
 * next request.
 */
import { COOKIE_PREFIX } from './auth.ts';
import { isSecure, originOf, signInSecrets, storedOrigin, type Secrets, type SignInSecrets } from './config.ts';
import { base64url, fromHex, sameBytes, sha256, verifyCookieSignature } from './crypto.ts';
import type {
  AgentPrincipal,
  Membership,
  PersonPrincipal,
  Principal,
  ProjectAccess,
  ServicePrincipal,
  WorkspaceGrants,
} from './principal.ts';
import { bearerChallenge, bearerToken, mcpResource, scopeAccess } from './protocol.ts';
import { parseServiceToken, SERVICE_TOKEN_PREFIX } from './service-token.ts';

export interface VerifierEnv extends SignInSecrets {
  readonly DB: D1Database;
}

export type Verification =
  | { readonly ok: true; readonly principal: Principal }
  /** The deployment has no sign-in settings, or no origin because its setup has not run, so nobody can sign in. */
  | { readonly ok: false; readonly reason: 'not_configured' }
  | {
      readonly ok: false;
      /**
       * `unauthenticated`: the request carries no credential.
       * `invalid_token`: its credential is malformed, unknown, expired or revoked.
       * `cross_site`: a cookie-signed change came from another site.
       */
      readonly reason: 'unauthenticated' | 'invalid_token' | 'cross_site';
      /** The deployment's origin, which the refusal's bearer challenge names. */
      readonly origin: string;
    };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Who sent the request, checked against the database, or why it is refused.
 * A bearer token is checked before a session cookie; a malformed
 * Authorization header is refused, never passed over for the cookie.
 */
export async function verifyRequest(request: Request, env: VerifierEnv): Promise<Verification> {
  const secrets = signInSecrets(env);
  if (!secrets) return { ok: false, reason: 'not_configured' };
  const bearer = bearerToken(request.headers);
  if (bearer === false) return refused(env.DB, secrets, 'invalid_token');
  if (bearer !== null) {
    const principal = bearer.startsWith(`${SERVICE_TOKEN_PREFIX}.`)
      ? await verifyServiceToken(env.DB, bearer)
      : await verifyAgentToken(env.DB, secrets, bearer);
    return principal ? { ok: true, principal } : refused(env.DB, secrets, 'invalid_token');
  }
  const cookie = sessionCookie(request.headers);
  if (cookie === null) return refused(env.DB, secrets, 'unauthenticated');
  const session = await verifySession(env.DB, secrets, cookie);
  if (!session) return refused(env.DB, secrets, 'invalid_token');
  // A browser sends the session cookie with any request to this origin,
  // including a form another site submits; a change must come from this origin.
  if (!SAFE_METHODS.has(request.method) && request.headers.get('origin') !== session.origin) {
    return { ok: false, reason: 'cross_site', origin: session.origin };
  }
  return { ok: true, principal: session.principal };
}

/**
 * A refusal, with the deployment's origin for its challenge: the one the
 * secrets name, else the stored app's, which costs a D1 query that only a
 * refused request makes. With neither, nobody can sign in yet.
 */
async function refused(
  db: D1Database,
  secrets: Secrets,
  reason: 'unauthenticated' | 'invalid_token',
): Promise<Verification> {
  const origin = secrets.app?.origin ?? (await storedOrigin(db));
  return origin === null ? { ok: false, reason: 'not_configured' } : { ok: false, reason, origin };
}

/** The answer while sign-in is off, with a sentence saying what turns it on: the setup page, or the secrets. */
export function notConfigured(env: SignInSecrets): Response {
  const detail = signInSecrets(env)
    ? 'Sign-in is not set up yet. Open /sign-in on this deployment to set it up.'
    : 'Sign-in is off: AUTH_SECRET or another sign-in secret is missing or malformed.';
  return Response.json(
    { error: 'sign_in_not_configured', detail },
    { status: 503, headers: { 'cache-control': 'no-store' } },
  );
}

/** The answer to a refused request. A bearer challenge tells an MCP client where to sign in. */
export function refusal(verification: Extract<Verification, { ok: false }>, env: SignInSecrets): Response {
  if (verification.reason === 'not_configured') return notConfigured(env);
  if (verification.reason === 'cross_site') {
    return Response.json({ error: 'cross_site_request' }, { status: 403, headers: { 'cache-control': 'no-store' } });
  }
  return bearerChallenge(
    verification.origin,
    verification.reason === 'invalid_token' ? { error: 'invalid_token' } : undefined,
  );
}

/** The session cookie's name, as Better Auth sets it: with `__Secure-` in front unless the origin is a local http one. */
export function sessionCookieName(secure: boolean): string {
  return `${secure ? '__Secure-' : ''}${COOKIE_PREFIX}.session_token`;
}

interface SessionCookie {
  /** The signed value. */
  readonly value: string;
  /** Whether it came under the `__Secure-` name, which a browser accepts only from an https origin. */
  readonly secure: boolean;
}

/**
 * The session cookie, or null when the request has none. The origin may be
 * stored in D1, so its name is checked against the origin after the session
 * query has read it.
 */
function sessionCookie(headers: Headers): SessionCookie | null {
  const header = headers.get('cookie');
  if (!header) return null;
  for (const secure of [true, false]) {
    const name = sessionCookieName(secure);
    for (const part of header.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
      try {
        return { value: decodeURIComponent(part.slice(separator + 1).trim()), secure };
      } catch {
        return { value: '', secure };
      }
    }
  }
  return null;
}

/**
 * Whether the person is a deployment admin: the setup page recorded one of
 * their GitHub accounts (`recorded`, as the query read it), or one of them,
 * in a JSON array of ids, is in OWNER_GITHUB_IDS.
 */
function isAdmin(secrets: Secrets, recorded: number, githubIds: string | null): boolean {
  if (recorded === 1) return true;
  const ids = parseJson(githubIds);
  return Array.isArray(ids) && ids.some((id) => typeof id === 'string' && secrets.owners.has(id));
}

/**
 * The columns the session and token queries read for the person whose user
 * id is the column `user`: their GitHub ids, whether the setup page recorded
 * one of them as an admin, and the stored app's origin. Each check stays one
 * query.
 */
function personColumns(user: string): string {
  return `(SELECT json_group_array(a.account_id) FROM auth_account a
           WHERE a.user_id = ${user} AND a.provider_id = 'github') AS github_ids,
         EXISTS (SELECT 1 FROM auth_account a JOIN access_github_app g ON g.admin_github_id = a.account_id
           WHERE a.user_id = ${user} AND a.provider_id = 'github') AS recorded_admin,
         (SELECT origin FROM access_github_app) AS stored_origin`;
}

/** The deployment's origin: the one the secrets name, else the stored app's as a query read it. */
function originFrom(secrets: Secrets, stored: string | null): string | null {
  return secrets.app?.origin ?? originOf(stored);
}

/** The parsed value, or null when the text is null or not JSON. */
function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Project grants, from an array of [project id, access] pairs, lowered to `most`. */
function grantsOf(pairs: unknown, most: ProjectAccess | null): ReadonlyMap<string, ProjectAccess> {
  const projects = new Map<string, ProjectAccess>();
  if (most === null || !Array.isArray(pairs)) return projects;
  for (const pair of pairs) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
    const granted: unknown = pair[1];
    if (granted === 'write') projects.set(pair[0], most);
    else if (granted === 'read') projects.set(pair[0], 'read');
  }
  return projects;
}

/** A person's memberships, from a JSON array of [workspace id, workspace name, role] rows. */
function membershipsOf(text: string | null): Membership[] {
  const rows = parseJson(text);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: unknown): Membership[] => {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string') return [];
    const role: unknown = row[2];
    if (role !== 'owner' && role !== 'member') return [];
    return [{ workspace: { id: row[0], name: row[1] }, role }];
  });
}

/** An agent's grants by workspace, from a JSON array of [workspace id,
 * workspace name, project id, access] rows, lowered to `most`. */
function workspaceGrantsOf(text: string | null, most: ProjectAccess | null): WorkspaceGrants[] {
  const rows = parseJson(text);
  if (most === null || !Array.isArray(rows)) return [];
  const byWorkspace = new Map<string, { readonly name: string; readonly pairs: unknown[][] }>();
  for (const row of rows) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string') continue;
    const entry = byWorkspace.get(row[0]) ?? { name: row[1], pairs: [] };
    entry.pairs.push([row[2], row[3]]);
    byWorkspace.set(row[0], entry);
  }
  return [...byWorkspace].map(([id, { name, pairs }]) => ({
    workspace: { id, name },
    projects: grantsOf(pairs, most),
  }));
}

/** The person a signed session cookie belongs to, with their workspaces, and
 * the deployment's origin; null when its signature fails, it expired, its
 * cookie's name does not match the origin, or the person is neither a
 * deployment admin nor a member of any workspace any more. */
async function verifySession(
  db: D1Database,
  secrets: Secrets,
  cookie: SessionCookie,
): Promise<{ readonly principal: PersonPrincipal; readonly origin: string } | null> {
  const dot = cookie.value.lastIndexOf('.');
  if (dot < 1) return null;
  const token = cookie.value.slice(0, dot);
  const signature = cookie.value.slice(dot + 1);
  if (signature.length !== 44 || !(await verifyCookieSignature(token, signature, secrets.secret))) return null;
  const row = await db
    .prepare(
      `SELECT s.user_id, u.name, ${personColumns('s.user_id')},
         (SELECT json_group_array(json_array(m.workspace_id, w.name, m.role))
           FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
           WHERE m.user_id = s.user_id) AS memberships
       FROM auth_session s JOIN auth_user u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`,
    )
    .bind(token, new Date().toISOString())
    .first<{
      user_id: string;
      name: string;
      github_ids: string | null;
      recorded_admin: number;
      stored_origin: string | null;
      memberships: string | null;
    }>();
  if (!row) return null;
  const origin = originFrom(secrets, row.stored_origin);
  if (origin === null || cookie.secure !== isSecure(origin)) return null;
  const admin = isAdmin(secrets, row.recorded_admin, row.github_ids);
  const memberships = membershipsOf(row.memberships);
  if (!admin && memberships.length === 0) return null;
  const principal: PersonPrincipal = Object.freeze({
    kind: 'person',
    id: `person:${row.user_id}`,
    userId: row.user_id,
    name: displayName(row.name, 'owner'),
    admin,
    memberships,
  });
  return { principal, origin };
}

/**
 * The agent an access token belongs to; null when the token is unknown,
 * expired, revoked or for another resource, its client is disabled, the
 * consent is gone, or its person is neither a deployment admin nor a member
 * of any workspace any more.
 */
async function verifyAgentToken(db: D1Database, secrets: Secrets, token: string): Promise<AgentPrincipal | null> {
  // Better Auth stores an opaque token as base64url(SHA-256(token)).
  const stored = base64url(await sha256(token));
  const row = await db
    .prepare(
      `SELECT t.client_id, t.user_id, t.scopes, t.resources, c.name AS client_name, u.name AS person_name,
         (SELECT json_group_array(json_array(g.workspace_id, w.name, g.project_id, g.access))
           FROM access_agent_grants g
           JOIN workspace_members m ON m.workspace_id = g.workspace_id AND m.user_id = g.user_id
           JOIN workspaces w ON w.id = g.workspace_id
           WHERE g.user_id = t.user_id AND g.client_id = t.client_id) AS grants,
         ${personColumns('t.user_id')},
         EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = t.user_id) AS member
       FROM auth_oauth_access_token t
       JOIN auth_oauth_client c ON c.client_id = t.client_id AND coalesce(c.disabled, 0) = 0
       JOIN auth_user u ON u.id = t.user_id
       WHERE t.token = ? AND t.revoked IS NULL AND t.expires_at > ? AND t.user_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM auth_oauth_consent k WHERE k.client_id = t.client_id AND k.user_id = t.user_id)`,
    )
    .bind(stored, new Date().toISOString())
    .first<{
      client_id: string;
      user_id: string;
      scopes: string;
      resources: string | null;
      client_name: string | null;
      person_name: string | null;
      grants: string | null;
      github_ids: string | null;
      recorded_admin: number;
      stored_origin: string | null;
      member: number;
    }>();
  if (!row || (row.member !== 1 && !isAdmin(secrets, row.recorded_admin, row.github_ids))) return null;
  const origin = originFrom(secrets, row.stored_origin);
  if (origin === null) return null;
  // A token names the resources it was issued for; one for another resource is refused.
  const resources = parseJson(row.resources);
  if (resources !== null && !(Array.isArray(resources) && resources.includes(mcpResource(origin)))) return null;
  const scopes = parseJson(row.scopes);
  const most = Array.isArray(scopes) ? scopeAccess(scopes.filter((scope) => typeof scope === 'string')) : null;
  return Object.freeze({
    kind: 'agent',
    id: `agent:${row.client_id}:${row.user_id}`,
    userId: row.user_id,
    personName: displayName(row.person_name, 'owner'),
    clientId: row.client_id,
    name: displayName(row.client_name, 'agent'),
    workspaces: workspaceGrantsOf(row.grants, most),
  });
}

/** The service a credential belongs to; null when it is unknown, revoked or its secret does not match. */
async function verifyServiceToken(db: D1Database, token: string): Promise<ServicePrincipal | null> {
  const parsed = parseServiceToken(token);
  if (!parsed) return null;
  const row = await db
    .prepare(
      `SELECT c.name, c.secret_hash, c.backup, c.restore, c.workspace_id, w.name AS workspace_name,
         (SELECT json_group_array(json_array(g.project_id, g.access)) FROM access_service_grants g
           WHERE g.credential_id = c.id) AS grants
       FROM access_service_credentials c JOIN workspaces w ON w.id = c.workspace_id
       WHERE c.id = ? AND c.revoked_at IS NULL`,
    )
    .bind(parsed.id)
    .first<{
      name: string;
      secret_hash: string;
      backup: number;
      restore: number;
      workspace_id: string;
      workspace_name: string;
      grants: string | null;
    }>();
  const expected = row ? fromHex(row.secret_hash) : null;
  if (!row || !expected || !sameBytes(expected, await sha256(parsed.secret))) return null;
  return Object.freeze({
    kind: 'service',
    id: `service:${parsed.id}`,
    credentialId: parsed.id,
    name: row.name,
    workspace: Object.freeze({ id: row.workspace_id, name: row.workspace_name }),
    projects: grantsOf(parseJson(row.grants), 'write'),
    backup: row.backup === 1,
    restore: row.restore === 1,
  });
}

/** An actor name for the task store: 1 to 255 characters. */
function displayName(name: string | null, fallback: string): string {
  const trimmed = name?.trim() ?? '';
  return trimmed.length === 0 ? fallback : trimmed.slice(0, 255);
}
