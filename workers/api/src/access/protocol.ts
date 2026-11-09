/**
 * The protocol facts of signing in to Ntasks: the paths, the scopes an AI
 * agent may hold and what each allows, the OAuth discovery documents MCP
 * clients read, and the bearer challenge a refused call answers with. MCP's
 * authorization specification (modelcontextprotocol.io) defines the flow:
 * the MCP endpoint is the protected resource, and this Worker is also its
 * authorization server.
 */
import { MCP_PATH } from '../api.ts';
import { SCOPES } from '../auth.ts';
import type { ProjectAccess } from './principal.ts';

/** Better Auth's routes live under this path; the OAuth issuer is the origin plus it. */
export const AUTH_BASE_PATH = '/api/auth';
/** The MCP endpoint, the one protected resource agents get tokens for. */
export { MCP_PATH };
/** The sign-in page, which is also the OAuth login page, and the agent approval page. */
export { AGENT_ACCESS_PAGE, SIGN_IN_PAGE } from './pages.ts';
/** RFC 8414 discovery, at the issuer's path and at the root for older MCP clients. */
export const AUTHORIZATION_SERVER_METADATA_PATHS: readonly string[] = [
  `/.well-known/oauth-authorization-server${AUTH_BASE_PATH}`,
  '/.well-known/oauth-authorization-server',
];
/** RFC 9728 discovery for the MCP endpoint. */
export const PROTECTED_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;
export const RESOURCE_NAME = 'Ntasks';

/**
 * The scopes an agent may ask for, and the most each lets it do in a project
 * it was granted. Write includes read. No scope lets an agent answer a
 * decision as the owner: that is a person's own session (see `mayDecide`).
 */
export const AGENT_SCOPES: Readonly<Record<string, ProjectAccess>> = Object.freeze({
  'tasks:read': 'read',
  'tasks:write': 'write',
});
/**
 * The scopes a connected app may ask for: an agent's, and a person's
 * decisions. A connected app acts as the person who signs in to it, so its
 * token may carry `tasks:decide`; a client that registered itself never
 * holds that scope (auth.ts), and an agent's token never decides whatever it
 * carries (verify.ts).
 */
export const APP_SCOPES: readonly string[] = Object.freeze([...Object.keys(AGENT_SCOPES), SCOPES.decide]);
/** Asked for by clients that want a refresh token. It allows nothing by itself. */
export const OFFLINE_ACCESS = 'offline_access';

/**
 * A connected app's OAuth client carries `ntasks-app:<workspace id>` as its
 * reference id. Only Ntasks writes the column: the library never takes it
 * from a registration request, so a client that registered itself cannot
 * claim to be a connected app.
 */
const APP_REFERENCE = 'ntasks-app:';

/** The reference id of a connected app of this workspace. */
export function appReference(workspaceId: string): string {
  return APP_REFERENCE + workspaceId;
}

/** The workspace a client's reference id makes it a connected app of, or null for any other client. */
export function appWorkspaceOf(reference: string | null): string | null {
  return reference?.startsWith(APP_REFERENCE) ? reference.slice(APP_REFERENCE.length) : null;
}

/** An SQL condition that holds for a client that is not a connected app, given its reference id column. */
export function notAnApp(column: string): string {
  return `(${column} IS NULL OR substr(${column}, 1, ${APP_REFERENCE.length}) <> '${APP_REFERENCE}')`;
}
export const AGENT_ACCESS_TOKEN_SECONDS = 3600;
export const AGENT_REFRESH_TOKEN_SECONDS = 30 * 86_400;

/**
 * The Better Auth routes a browser or an MCP client may call, with their
 * methods. Every other route of the library, such as client administration
 * or get-session (whose answer holds the session token that the cookie keeps
 * from scripts), answers 404. `GET /api/access/me` says who is signed in.
 */
export const PUBLIC_AUTH_ROUTES: Readonly<Record<string, 'GET' | 'POST'>> = Object.freeze({
  [`${AUTH_BASE_PATH}/oauth2/authorize`]: 'GET',
  [`${AUTH_BASE_PATH}/oauth2/token`]: 'POST',
  [`${AUTH_BASE_PATH}/oauth2/register`]: 'POST',
  [`${AUTH_BASE_PATH}/oauth2/revoke`]: 'POST',
  [`${AUTH_BASE_PATH}/callback/github`]: 'GET',
  [`${AUTH_BASE_PATH}/sign-out`]: 'POST',
});

/** The most an agent's scopes let it do in any project, or null for nothing. */
export function scopeAccess(scopes: readonly string[]): ProjectAccess | null {
  let access: ProjectAccess | null = null;
  for (const scope of scopes) {
    const granted = AGENT_SCOPES[scope];
    if (granted === 'write') return 'write';
    if (granted === 'read') access = 'read';
  }
  return access;
}

export function issuer(origin: string): string {
  return origin + AUTH_BASE_PATH;
}

export function mcpResource(origin: string): string {
  return origin + MCP_PATH;
}

export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: mcpResource(origin),
    authorization_servers: [issuer(origin)],
    scopes_supported: Object.keys(AGENT_SCOPES),
    bearer_methods_supported: ['header'],
    resource_name: RESOURCE_NAME,
  };
}

/**
 * The bearer token a request carries: null when it has no Authorization
 * header, or false when the header is malformed. A malformed header is
 * refused, never ignored in favour of a cookie.
 */
export function bearerToken(headers: Headers): string | null | false {
  const value = headers.get('authorization');
  if (value === null) return null;
  const match = /^Bearer ([A-Za-z0-9\-._~+/]{16,4096}=*)$/iu.exec(value);
  return match?.[1] ?? false;
}

function quoted(value: string): string {
  return `"${value.replace(/["\\]/gu, '')}"`;
}

/**
 * RFC 6750 section 3 and MCP's scope challenge: 401 when the token is missing
 * or invalid, 403 when it lacks a scope. MCP clients read the header to find
 * the resource metadata and start signing in; the JSON body is for people.
 */
export function bearerChallenge(
  origin: string,
  failure?: { readonly error: 'invalid_token' | 'insufficient_scope'; readonly scopes?: readonly string[] },
): Response {
  const scope = (failure?.scopes ?? Object.keys(AGENT_SCOPES)).join(' ');
  const parts = [
    ...(failure ? [`error=${quoted(failure.error)}`] : []),
    `resource_metadata=${quoted(origin + PROTECTED_RESOURCE_METADATA_PATH)}`,
    `scope=${quoted(scope)}`,
  ];
  return Response.json(
    { error: failure?.error ?? 'unauthorized' },
    {
      status: failure?.error === 'insufficient_scope' ? 403 : 401,
      headers: { 'cache-control': 'no-store', 'www-authenticate': `Bearer ${parts.join(', ')}` },
    },
  );
}
