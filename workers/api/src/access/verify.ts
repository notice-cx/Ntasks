/**
 * The token verifier: who sent a request, checked against the database on
 * every call. The API and MCP layers call `verifyRequest` before anything
 * else and answer a refusal with `refusal`.
 *
 * A request signs in one of three ways:
 *
 * - **A person**: the session cookie that signing in with GitHub sets. The
 *   person's GitHub account must still be on the owner allowlist.
 * - **An AI agent**: an OAuth access token as a bearer token. The token must
 *   be unexpired and unrevoked, its client enabled, the person's consent
 *   still in place and the person still an owner. It reaches only the
 *   projects the person granted it.
 * - **A service**: a service credential as a bearer token, unrevoked. It
 *   reaches only the projects named in its grants.
 *
 * Each check is one D1 query and never builds Better Auth, to keep a call's
 * CPU time low: revoking a token, a consent, a grant or a credential cuts the
 * sender off at its next request.
 */
import { COOKIE_PREFIX } from './auth.ts';
import { signInConfig, type SignInConfig, type SignInSecrets } from './config.ts';
import { base64url, fromHex, sameBytes, sha256, verifyCookieSignature } from './crypto.ts';
import type { AgentPrincipal, PersonPrincipal, Principal, ProjectAccess, ServicePrincipal } from './principal.ts';
import { bearerChallenge, bearerToken, mcpResource, scopeAccess } from './protocol.ts';
import { parseServiceToken, SERVICE_TOKEN_PREFIX } from './service-token.ts';

export interface VerifierEnv extends SignInSecrets {
  readonly DB: D1Database;
}

export type Verification =
  | { readonly ok: true; readonly principal: Principal }
  | {
      readonly ok: false;
      /**
       * `not_configured`: the deployment has no sign-in settings, so nobody can sign in.
       * `unauthenticated`: the request carries no credential.
       * `invalid_token`: its credential is malformed, unknown, expired or revoked.
       * `cross_site`: a cookie-signed change came from another site.
       */
      readonly reason: 'not_configured' | 'unauthenticated' | 'invalid_token' | 'cross_site';
    };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function verifyRequest(request: Request, env: VerifierEnv): Promise<Verification> {
  const config = signInConfig(env);
  if (!config) return { ok: false, reason: 'not_configured' };
  const bearer = bearerToken(request.headers);
  if (bearer === false) return { ok: false, reason: 'invalid_token' };
  if (bearer !== null) {
    const principal = bearer.startsWith(`${SERVICE_TOKEN_PREFIX}.`)
      ? await verifyServiceToken(env.DB, bearer)
      : await verifyAgentToken(env.DB, config, bearer);
    return principal ? { ok: true, principal } : { ok: false, reason: 'invalid_token' };
  }
  const cookie = sessionCookie(request.headers, config);
  if (cookie === null) return { ok: false, reason: 'unauthenticated' };
  const principal = await verifySession(env.DB, config, cookie);
  if (!principal) return { ok: false, reason: 'invalid_token' };
  // A browser sends the session cookie with any request to this origin,
  // including a form another site submits; a change must come from this origin.
  if (!SAFE_METHODS.has(request.method) && request.headers.get('origin') !== config.origin) {
    return { ok: false, reason: 'cross_site' };
  }
  return { ok: true, principal };
}

/** The answer to a refused request. A bearer challenge tells an MCP client where to sign in. */
export function refusal(verification: Extract<Verification, { ok: false }>, env: SignInSecrets): Response {
  const config = signInConfig(env);
  if (verification.reason === 'not_configured' || !config) {
    return Response.json({ error: 'sign_in_not_configured' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  if (verification.reason === 'cross_site') {
    return Response.json({ error: 'cross_site_request' }, { status: 403, headers: { 'cache-control': 'no-store' } });
  }
  return bearerChallenge(config.origin, verification.reason === 'invalid_token' ? { error: 'invalid_token' } : undefined);
}

/** The session cookie's name, as Better Auth sets it for this origin. */
export function sessionCookieName(config: Pick<SignInConfig, 'secure'>): string {
  return `${config.secure ? '__Secure-' : ''}${COOKIE_PREFIX}.session_token`;
}

/** The session cookie's signed value, or null when the request has none. */
function sessionCookie(headers: Headers, config: SignInConfig): string | null {
  const header = headers.get('cookie');
  if (!header) return null;
  const name = sessionCookieName(config);
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return null;
}

/** Whether any of the person's GitHub accounts, as a JSON array of ids, is on the allowlist. */
function hasOwnerAccount(config: SignInConfig, githubIds: string | null): boolean {
  const ids = parseJson(githubIds);
  return Array.isArray(ids) && ids.some((id) => typeof id === 'string' && config.owners.has(id));
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Project grants, from a JSON array of [project id, access] pairs, lowered to `most`. */
function grantsOf(text: string | null, most: ProjectAccess | null): ReadonlyMap<string, ProjectAccess> {
  const projects = new Map<string, ProjectAccess>();
  const pairs = parseJson(text);
  if (most === null || !Array.isArray(pairs)) return projects;
  for (const pair of pairs) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
    const granted: unknown = pair[1];
    if (granted === 'write') projects.set(pair[0], most);
    else if (granted === 'read') projects.set(pair[0], 'read');
  }
  return projects;
}

async function verifySession(db: D1Database, config: SignInConfig, cookie: string): Promise<PersonPrincipal | null> {
  const dot = cookie.lastIndexOf('.');
  if (dot < 1) return null;
  const token = cookie.slice(0, dot);
  const signature = cookie.slice(dot + 1);
  if (signature.length !== 44 || !(await verifyCookieSignature(token, signature, config.secret))) return null;
  const row = await db
    .prepare(
      `SELECT s.user_id, u.name,
         (SELECT json_group_array(a.account_id) FROM auth_account a
           WHERE a.user_id = s.user_id AND a.provider_id = 'github') AS github_ids
       FROM auth_session s JOIN auth_user u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`,
    )
    .bind(token, new Date().toISOString())
    .first<{ user_id: string; name: string; github_ids: string | null }>();
  if (!row || !hasOwnerAccount(config, row.github_ids)) return null;
  return Object.freeze({ kind: 'person', id: `person:${row.user_id}`, userId: row.user_id, name: displayName(row.name, 'owner') });
}

async function verifyAgentToken(db: D1Database, config: SignInConfig, token: string): Promise<AgentPrincipal | null> {
  // Better Auth stores an opaque token as base64url(SHA-256(token)).
  const stored = base64url(await sha256(token));
  const row = await db
    .prepare(
      `SELECT t.client_id, t.user_id, t.scopes, t.resources, c.name AS client_name,
         (SELECT json_group_array(json_array(g.project_id, g.access)) FROM access_agent_grants g
           WHERE g.user_id = t.user_id AND g.client_id = t.client_id) AS grants,
         (SELECT json_group_array(a.account_id) FROM auth_account a
           WHERE a.user_id = t.user_id AND a.provider_id = 'github') AS github_ids
       FROM auth_oauth_access_token t
       JOIN auth_oauth_client c ON c.client_id = t.client_id AND coalesce(c.disabled, 0) = 0
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
      grants: string | null;
      github_ids: string | null;
    }>();
  if (!row || !hasOwnerAccount(config, row.github_ids)) return null;
  // A token names the resources it was issued for; one for another resource is refused.
  const resources = parseJson(row.resources);
  if (resources !== null && !(Array.isArray(resources) && resources.includes(mcpResource(config.origin)))) return null;
  const scopes = parseJson(row.scopes);
  const most = Array.isArray(scopes) ? scopeAccess(scopes.filter((scope) => typeof scope === 'string')) : null;
  return Object.freeze({
    kind: 'agent',
    id: `agent:${row.client_id}:${row.user_id}`,
    userId: row.user_id,
    clientId: row.client_id,
    name: displayName(row.client_name, 'agent'),
    projects: grantsOf(row.grants, most),
  });
}

async function verifyServiceToken(db: D1Database, token: string): Promise<ServicePrincipal | null> {
  const parsed = parseServiceToken(token);
  if (!parsed) return null;
  const row = await db
    .prepare(
      `SELECT c.name, c.secret_hash,
         (SELECT json_group_array(json_array(g.project_id, g.access)) FROM access_service_grants g
           WHERE g.credential_id = c.id) AS grants
       FROM access_service_credentials c WHERE c.id = ? AND c.revoked_at IS NULL`,
    )
    .bind(parsed.id)
    .first<{ name: string; secret_hash: string; grants: string | null }>();
  const expected = row ? fromHex(row.secret_hash) : null;
  if (!row || !expected || !sameBytes(expected, await sha256(parsed.secret))) return null;
  return Object.freeze({
    kind: 'service',
    id: `service:${parsed.id}`,
    credentialId: parsed.id,
    name: row.name,
    projects: grantsOf(row.grants, 'write'),
  });
}

/** An actor name for the task store: 1 to 255 characters. */
function displayName(name: string | null, fallback: string): string {
  const trimmed = name?.trim() ?? '';
  return trimmed.length === 0 ? fallback : trimmed.slice(0, 255);
}
