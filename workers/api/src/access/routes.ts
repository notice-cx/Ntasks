/**
 * Every sign-in path the Worker answers: OAuth discovery, the Better Auth
 * routes MCP clients and browsers use, the sign-in and agent approval pages,
 * and the owner's routes for listing and revoking agents and service
 * credentials. Every path here is in wrangler.jsonc's run_worker_first.
 */
import { oauthProviderAuthServerMetadata, verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { json } from '../http.ts';
import { createAuth, type Auth } from './auth.ts';
import { signInConfig, type SignInConfig } from './config.ts';
import {
  AccessRefused,
  createServiceCredential,
  listAgents,
  listProjects,
  listServiceCredentials,
  revokeAgent,
  revokeServiceCredential,
  setAgentGrants,
} from './grants.ts';
import { agentAccessPage, expiredPage, signInPage } from './pages.ts';
import type { PersonPrincipal, Principal } from './principal.ts';
import {
  AGENT_ACCESS_PAGE,
  AUTH_BASE_PATH,
  AUTHORIZATION_SERVER_METADATA_PATHS,
  PROTECTED_RESOURCE_METADATA_PATH,
  PUBLIC_AUTH_ROUTES,
  SIGN_IN_PAGE,
  protectedResourceMetadata,
  scopeAccess,
} from './protocol.ts';
import { refusal, verifyRequest, type Verification, type VerifierEnv } from './verify.ts';

export interface AccessEnv extends VerifierEnv {
  /** Limits sign-in requests per client address (wrangler.jsonc `ratelimits`). */
  readonly SIGN_IN_LIMIT: RateLimit;
}

const ACCESS_API = '/api/access';
/** Sign-in requests are small; a larger body is refused before it is read. */
const BODY_BYTES = 16 * 1024;

/** Whether the Worker answers this path here. */
export function isAccessPath(pathname: string): boolean {
  return (
    pathname === PROTECTED_RESOURCE_METADATA_PATH ||
    AUTHORIZATION_SERVER_METADATA_PATHS.includes(pathname) ||
    pathname.startsWith(`${AUTH_BASE_PATH}/`) ||
    pathname === SIGN_IN_PAGE ||
    pathname === AGENT_ACCESS_PAGE ||
    pathname === ACCESS_API ||
    pathname.startsWith(`${ACCESS_API}/`)
  );
}

/** Answers a sign-in path, or returns null when the path is not one. */
export async function handleAccess(request: Request, env: AccessEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isAccessPath(url.pathname)) return null;
  const config = signInConfig(env);
  if (!config) return json({ error: 'sign_in_not_configured' }, 503);
  if (url.pathname === PROTECTED_RESOURCE_METADATA_PATH) {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
    return Response.json(protectedResourceMetadata(config.origin), { headers: { 'cache-control': 'public, max-age=300' } });
  }
  const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.SIGN_IN_LIMIT.limit({ key: address });
  if (!success) return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
  try {
    if (AUTHORIZATION_SERVER_METADATA_PATHS.includes(url.pathname)) return await serverMetadata(request, env, config);
    if (url.pathname.startsWith(`${AUTH_BASE_PATH}/`)) return await library(request, env, config, url);
    if (url.pathname === SIGN_IN_PAGE) return await signIn(request, env, config, url);
    if (url.pathname === AGENT_ACCESS_PAGE) return await agentAccess(request, env, config, url);
    return await accessApi(request, env, url);
  } catch (error) {
    if (error instanceof AccessRefused) {
      const status = error.code === 'not_found' ? 404 : error.code === 'name_taken' ? 409 : 400;
      return json({ error: error.code, message: error.message }, status);
    }
    if (error instanceof BodyTooLarge) return json({ error: 'body_too_large' }, 413);
    throw error;
  }
}

class BodyTooLarge extends Error {}

/** The request body as text, refused above BODY_BYTES. */
async function boundedText(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > BODY_BYTES) throw new BodyTooLarge();
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > BODY_BYTES) throw new BodyTooLarge();
  return new TextDecoder().decode(bytes);
}

async function serverMetadata(request: Request, env: AccessEnv, config: SignInConfig): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
  return oauthProviderAuthServerMetadata(createAuth(env.DB, config))(request);
}

/** A Better Auth route, if it is one a browser or an MCP client may call. */
async function library(request: Request, env: AccessEnv, config: SignInConfig, url: URL): Promise<Response> {
  const method = PUBLIC_AUTH_ROUTES[url.pathname];
  if (!method) return json({ error: 'not_found' }, 404);
  if (request.method !== method) return json({ error: 'method_not_allowed' }, 405, { allow: method });
  const forwarded = method === 'POST'
    ? new Request(request.url, { method, headers: request.headers, body: await boundedText(request) })
    : request;
  return createAuth(env.DB, config).handler(forwarded);
}

/** Calls a Better Auth endpoint for one of this Worker's pages, as the browser that submitted the page. */
async function callLibrary(auth: Auth, config: SignInConfig, request: Request, path: string, body: unknown): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json', origin: config.origin });
  for (const name of ['cookie', 'user-agent', 'cf-connecting-ip']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return auth.handler(new Request(config.origin + path, { method: 'POST', headers, body: JSON.stringify(body) }));
}

/** Sends the browser on to `location` with the cookies the library set. */
function redirectWithCookies(location: string, from: Response): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of from.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

/** The `url` of a library answer that tells the browser where to go next. */
async function nextUrl(response: Response): Promise<string | null> {
  if (response.status !== 200) return null;
  const body: unknown = await response.json().catch(() => null);
  const url = body && typeof body === 'object' && 'url' in body ? body.url : null;
  return typeof url === 'string' ? url : null;
}

/** A signed OAuth query from the library, or null when the query has none or its signature or time fails. */
async function signedQuery(query: string, config: SignInConfig): Promise<string | null> {
  if (query.length === 0 || query.length > 8192 || !new URLSearchParams(query).has('sig')) return null;
  return (await verifyOAuthQueryParams(query, config.secret)) ? query : null;
}

function personOf(verification: Verification): PersonPrincipal | null {
  return verification.ok && verification.principal.kind === 'person' ? verification.principal : null;
}

/** A form post from one of this Worker's pages must come from this origin. */
function fromThisOrigin(request: Request, config: SignInConfig): boolean {
  return request.headers.get('origin') === config.origin;
}

async function signIn(request: Request, env: AccessEnv, config: SignInConfig, url: URL): Promise<Response> {
  if (request.method === 'GET') {
    const query = url.search.slice(1);
    const oauthQuery = await signedQuery(query, config);
    if (new URLSearchParams(query).has('sig') && oauthQuery === null) return expiredPage();
    const person = personOf(await verifyRequest(request, env));
    return signInPage({ signedInAs: person?.name ?? null, oauthQuery, error: url.searchParams.get('error') });
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' });
  if (!fromThisOrigin(request, config)) return json({ error: 'cross_site_request' }, 403);
  const form = new URLSearchParams(await boundedText(request));
  if (form.get('action') === 'sign-out') {
    const signedOut = await callLibrary(createAuth(env.DB, config), config, request, `${AUTH_BASE_PATH}/sign-out`, {});
    return redirectWithCookies(SIGN_IN_PAGE, signedOut);
  }
  const rawQuery = form.get('oauth_query');
  const oauthQuery = rawQuery === null ? null : await signedQuery(rawQuery, config);
  if (rawQuery !== null && oauthQuery === null) return expiredPage();
  // With an OAuth query, the library resumes the agent's authorization once
  // GitHub sends the browser back, and callbackURL is not used.
  const response = await callLibrary(createAuth(env.DB, config), config, request, `${AUTH_BASE_PATH}/sign-in/social`, {
    provider: 'github',
    callbackURL: '/',
    errorCallbackURL: SIGN_IN_PAGE,
    ...(oauthQuery === null ? {} : { oauth_query: oauthQuery }),
  });
  const location = await nextUrl(response);
  if (location === null) return json({ error: 'sign_in_failed' }, 502);
  return redirectWithCookies(location, response);
}

async function agentAccess(request: Request, env: AccessEnv, config: SignInConfig, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' });
  const form = request.method === 'POST' ? new URLSearchParams(await boundedText(request)) : null;
  const oauthQuery = await signedQuery(form ? (form.get('oauth_query') ?? '') : url.search.slice(1), config);
  if (oauthQuery === null) return expiredPage();
  const verification = await verifyRequest(request, env);
  if (!verification.ok && verification.reason === 'cross_site') return refusal(verification, env);
  const person = personOf(verification);
  if (!person) return new Response(null, { status: 303, headers: { location: `${SIGN_IN_PAGE}?${oauthQuery}`, 'cache-control': 'no-store' } });
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get('client_id') ?? '';
  const client = await env.DB
    .prepare('SELECT name, uri FROM auth_oauth_client WHERE client_id = ? AND coalesce(disabled, 0) = 0')
    .bind(clientId)
    .first<{ name: string | null; uri: string | null }>();
  if (!client) return expiredPage();
  const access = scopeAccess((params.get('scope') ?? '').split(' '));
  const projects = await listProjects(env.DB);
  const show = (error: string | null) =>
    agentAccessPage({
      personName: person.name,
      client: { name: client.name ?? clientId, uri: client.uri },
      access,
      projects,
      oauthQuery,
      error,
    });
  if (!form) return show(null);
  if (form.get('decision') === 'allow') {
    if (access === null) return show('This agent asks for no access to tasks.');
    const chosen = form.getAll('project');
    const known = new Set(projects.map((project) => project.id));
    if (chosen.length === 0) return show('Choose at least one project.');
    if (!chosen.every((id) => known.has(id))) return show('A chosen project no longer exists. Choose again.');
    // Grants first: a consent without grants would let the agent reach nothing.
    await setAgentGrants(env.DB, person.userId, clientId, chosen.map((projectId) => ({ projectId, access })));
  } else if (form.get('decision') !== 'deny') {
    return show('Choose Allow or Deny.');
  }
  // Built only once it is used: building starts database reads that must
  // finish before the response does.
  const response = await callLibrary(createAuth(env.DB, config), config, request, `${AUTH_BASE_PATH}/oauth2/consent`, {
    accept: form.get('decision') === 'allow',
    oauth_query: oauthQuery,
  });
  const location = await nextUrl(response);
  if (location === null) return expiredPage();
  return redirectWithCookies(location, response);
}

/** The owner's JSON routes under /api/access. */
async function accessApi(request: Request, env: AccessEnv, url: URL): Promise<Response> {
  const verification = await verifyRequest(request, env);
  if (!verification.ok) return refusal(verification, env);
  const principal = verification.principal;
  const path = url.pathname.slice(ACCESS_API.length);
  if (path === '/me') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
    return json(describe(principal), 200);
  }
  // Managing access is the owner's own act, never an agent's or a service's.
  if (principal.kind !== 'person') return json({ error: 'owner_only' }, 403);
  if (path === '/agents' && request.method === 'GET') return json({ agents: await listAgents(env.DB, principal.userId) }, 200);
  const agent = /^\/agents\/([A-Za-z0-9_-]{1,255})\/revoke$/u.exec(path);
  if (agent?.[1] && request.method === 'POST') {
    if (!(await revokeAgent(env.DB, principal.userId, agent[1]))) throw new AccessRefused('not_found', 'no such connected agent');
    return json({ revoked: true }, 200);
  }
  if (path === '/services' && request.method === 'GET') return json({ services: await listServiceCredentials(env.DB) }, 200);
  if (path === '/services' && request.method === 'POST') {
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
      throw new AccessRefused('invalid_request', 'send the credential as application/json');
    }
    let body: { name?: unknown; grants?: unknown };
    try {
      body = JSON.parse(await boundedText(request)) as { name?: unknown; grants?: unknown };
    } catch (error) {
      if (error instanceof BodyTooLarge) throw error;
      throw new AccessRefused('invalid_request', 'the body is not JSON');
    }
    const created = await createServiceCredential(env.DB, { name: body?.name, grants: body?.grants, createdBy: principal.userId });
    return json({ service: created }, 201);
  }
  const service = /^\/services\/([0-9a-f-]{36})\/revoke$/u.exec(path);
  if (service?.[1] && request.method === 'POST') {
    if (!(await revokeServiceCredential(env.DB, service[1]))) throw new AccessRefused('not_found', 'no such unrevoked service credential');
    return json({ revoked: true }, 200);
  }
  return json({ error: 'not_found' }, 404);
}

function describe(principal: Principal): Record<string, unknown> {
  const projects = principal.kind === 'person'
    ? 'all'
    : [...principal.projects].map(([projectId, access]) => ({ projectId, access }));
  return { kind: principal.kind, name: principal.name, projects };
}
