/**
 * Every sign-in path the Worker answers: OAuth discovery, the Better Auth
 * routes MCP clients and browsers use, the setup, sign-in and approval
 * pages, a person's routes for listing and revoking their agents and
 * connected apps, an owner's routes for a workspace's members, invitations,
 * service credentials, connected apps and GitHub webhook, and
 * the workspace routes, which read and write D1 beside sign-in. Every path
 * here is in wrangler.jsonc's run_worker_first.
 */
import { oauthProviderAuthServerMetadata, verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { isTimeZone } from '@ntasks/domain';
import { lacking } from '../api.ts';
import { SCOPES } from '../auth.ts';
import { json } from '../http/respond.ts';
import { chooseWorkspace, WORKSPACE_HEADER, type WorkspaceReach } from '../workspaces.ts';
import { createAuth, type Auth } from './auth.ts';
import { reachesOf } from './authenticator.ts';
import { loadSignIn, originOf, signInSecrets, storeGitHubApp, type SignIn, type SignInConfig } from './config.ts';
import { randomSecret, sameBytes, sha256 } from './crypto.ts';
import {
  AccessRefused,
  createServiceCredential,
  createWorkspace,
  registrationDay,
  takeRegistration,
  listAgents,
  listProjects,
  type AgentGrant,
  type ProjectSource,
  listServiceCredentials,
  renameWorkspace,
  revokeAgent,
  revokeServiceCredential,
  setAgentGrants,
  WORKSPACE_ID,
  workspaceNameOf,
} from './grants.ts';
import {
  convertGitHubApp,
  endGitHubAppCookie,
  githubAppLinks,
  githubAppView,
  gitHubAppStateOf,
  githubIdOf,
  removeGitHubApp,
  saveGitHubApp,
  setDeployCheck,
  SETTINGS_PAGE,
  startGitHubApp,
} from './github-app.ts';
import {
  githubWebhookSettingsOf,
  githubWebhookView,
  removeGitHubWebhook,
  saveGitHubWebhook,
} from './github-webhook.ts';
import { createInvitation, githubLoginOf, listMembers, removeMember, revokeInvitation } from './members.ts';
import {
  addressState,
  allowAddress,
  APP_RETURN_PATH,
  appAddress,
  namesReturnPage,
  appRegistrationOf,
  clientOf,
  isAppOf,
  isHomeNetworkHttp,
  libraryAddress,
  libraryRegistration,
  listApps,
  markApp,
  registeredApp,
  removeApp,
  serviceAppRegistrationOf,
} from './apps.ts';
import {
  addressHeldPage,
  agentAccessPage,
  appAccessPage,
  AUTH_SECRET_FIELD,
  expiredPage,
  manifestPage,
  SETUP_ACTION,
  setupEndPage,
  setupPage,
  signInPage,
  type WorkspaceProjects,
} from './pages.ts';
import { ownSession, type PersonPrincipal, type Principal } from './principal.ts';
import {
  AGENT_ACCESS_PAGE,
  APP_SCOPES,
  AUTH_BASE_PATH,
  OFFLINE_ACCESS,
  AUTHORIZATION_SERVER_METADATA_PATHS,
  PROTECTED_RESOURCE_METADATA_PATH,
  PUBLIC_AUTH_ROUTES,
  SIGN_IN_PAGE,
  bearerToken,
  protectedResourceMetadata,
  scopeAccess,
} from './protocol.ts';
import { parseServiceToken } from './service-token.ts';
import {
  convertManifest,
  endSetupCookie,
  GITHUB_NEW_APP,
  manifestFor,
  setupStateHolds,
  startSetupState,
} from './setup.ts';
import { notConfigured, refusal, verifyRequest, type Verification, type VerifierEnv } from './verify.ts';

export interface AccessEnv extends VerifierEnv, ProjectSource {
  /** Limits sign-in requests per client address (wrangler.jsonc `ratelimits`). */
  readonly SIGN_IN_LIMIT: RateLimit;
  /** Limits agent registrations from one address, and, under its own keys, setup attempts from one address. */
  readonly REGISTER_ADDRESS_LIMIT: RateLimit;
  /** Limits agent registrations from all addresses together, and, under its own key, setup attempts. */
  readonly REGISTER_LIMIT: RateLimit;
}

const REGISTER_PATH = `${AUTH_BASE_PATH}/oauth2/register`;

const ACCESS_API = '/api/access';
/** The workspaces the sender reaches, and where a deployment admin creates one. */
const WORKSPACES_API = '/api/workspaces';
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
    pathname.startsWith(`${ACCESS_API}/`) ||
    pathname === WORKSPACES_API
  );
}

/** Answers a sign-in path, or returns null when the path is not one. */
export async function handleAccess(request: Request, env: AccessEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isAccessPath(url.pathname)) return null;
  if (url.pathname === PROTECTED_RESOURCE_METADATA_PATH) {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
    const signIn = await loadSignIn(env);
    if (signIn.state !== 'on') return notConfigured(env);
    return Response.json(protectedResourceMetadata(signIn.config.origin), {
      headers: { 'cache-control': 'public, max-age=300' },
    });
  }
  const address = addressKey(request.headers.get('cf-connecting-ip') ?? 'unknown');
  const { success } = await env.SIGN_IN_LIMIT.limit({ key: address });
  if (!success) return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
  try {
    // The token verifier answers for these when sign-in is off.
    if (url.pathname === WORKSPACES_API) return await workspacesApi(request, env);
    if (url.pathname === APP_RETURN_PATH) return await appReturn(request, env, url);
    if (url.pathname === ACCESS_API || url.pathname.startsWith(`${ACCESS_API}/`)) {
      return await accessApi(request, env, url);
    }
    const signIn = await loadSignIn(env);
    if (url.pathname === SIGN_IN_PAGE) return await signInPath(request, env, signIn, url, address);
    if (signIn.state !== 'on') return notConfigured(env);
    const config = signIn.config;
    // Anyone may register an agent, from any number of addresses, and each
    // registration writes to D1, so one key for every caller caps them all.
    // Each address is limited first, and a registration it is refused does not
    // count toward the shared cap, so one address cannot use all of it.
    // Those limits count separately in each Cloudflare location; the daily
    // budget is counted in D1, which every location shares.
    if (url.pathname === REGISTER_PATH && request.method === 'POST') {
      const service = serviceTokenOf(request);
      if (service !== null) return await serviceRegistration(request, env, config, service);
      const fromAddress = await env.REGISTER_ADDRESS_LIMIT.limit({ key: address });
      if (!fromAddress.success) return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
      const fromAll = await env.REGISTER_LIMIT.limit({ key: 'registrations' });
      if (!fromAll.success) return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
      if (!(await takeRegistration(env.DB, registrationDay()))) {
        return json({ error: 'registration_budget_spent' }, 429, { 'retry-after': String(secondsToNextUtcDay()) });
      }
    }
    if (AUTHORIZATION_SERVER_METADATA_PATHS.includes(url.pathname)) return await serverMetadata(request, env, config);
    if (url.pathname.startsWith(`${AUTH_BASE_PATH}/`)) return await library(request, env, config, url);
    return await agentAccess(request, env, config, url);
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

/**
 * The key a client address is rate-limited under: an IPv4 address as it is,
 * and an IPv6 address by its /64 block, since one client is commonly given a
 * whole /64 and could otherwise use a new address for each request.
 */
function addressKey(address: string): string {
  if (!address.includes(':')) return address;
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return address;
  const [front, back] = halves.map((half) => (half === '' ? [] : half.split(':')));
  const missing = 8 - (front?.length ?? 0) - (back?.length ?? 0);
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return address;
  const groups = [...(front ?? []), ...Array.from({ length: missing }, () => '0'), ...(back ?? [])];
  // An IPv4 address written into IPv6 holds dots, and stays whole.
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/u.test(group))) return address;
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

/** Seconds until 00:00 UTC, when the registration budget starts again. */
function secondsToNextUtcDay(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * The request body as text, refused above BODY_BYTES. It reads the body a
 * chunk at a time and stops at the limit, so a body sent without a
 * Content-Length is never held in memory whole.
 */
async function boundedText(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > BODY_BYTES) throw new BodyTooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_BYTES) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The service credential a request carries as its bearer token, or null for any other request. */
function serviceTokenOf(request: Request): string | null {
  const token = bearerToken(request.headers);
  return typeof token === 'string' && parseServiceToken(token) !== null ? token : null;
}

/** A registration refused as RFC 7591 section 3.2.2 words it. */
function registrationRefused(status: number, error: string, description: string): Response {
  return json({ error, error_description: description }, status, { 'cache-control': 'no-store' });
}

/**
 * POST /api/auth/oauth2/register with a service credential as RFC 7591's
 * initial access token: registers a connected app of the credential's
 * workspace, such as a NoticeOS Tower's page, from client metadata for a
 * public PKCE client. The same name and redirect addresses again answer the
 * app already registered. Each person still allows the app on the approval
 * page before it acts as them; the credential itself never acts as a person.
 */
async function serviceRegistration(
  request: Request,
  env: AccessEnv,
  config: SignInConfig,
  token: string,
): Promise<Response> {
  const verification = await verifyRequest(request, env);
  if (!verification.ok || verification.principal.kind !== 'service') {
    return registrationRefused(401, 'invalid_token', 'the service credential is unknown or revoked');
  }
  const workspaceId = verification.principal.workspace.id;
  const body = await jsonBody(request, 'client metadata');
  if (typeof body === 'string') return registrationRefused(400, 'invalid_client_metadata', body);
  const registration = serviceAppRegistrationOf(body);
  if ('detail' in registration) {
    const error = registration.field === 'redirectUris' ? 'invalid_redirect_uri' : 'invalid_client_metadata';
    return registrationRefused(400, error, registration.detail);
  }
  const registered = await registeredApp(env.DB, workspaceId, registration);
  if (registered) return json(registered, 200, { 'cache-control': 'no-store' });
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  });
  const library = libraryRegistration(config.origin, registration);
  if ('detail' in library) return registrationRefused(400, 'invalid_redirect_uri', library.detail);
  const metadata = {
    client_name: registration.name,
    redirect_uris: library.redirectUris,
    application_type: library.applicationType,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: registration.scope.join(' '),
  };
  const created = await createAuth(env.DB, config, {
    appRegistration: { token, workspaceId, scopes: registration.scope },
  }).handler(new Request(config.origin + REGISTER_PATH, { method: 'POST', headers, body: JSON.stringify(metadata) }));
  if (created.status !== 201) return created;
  // Answered in Ntasks's own recorded shape, not the library's, which may grow on an upgrade.
  const answer: unknown = await created.json().catch(() => null);
  const newId = isRecord(answer) && typeof answer.client_id === 'string' ? answer.client_id : null;
  if (newId === null) return json({ error: 'server_error' }, 500);
  await markApp(env.DB, newId, registration.redirectUris);
  const app = await registeredApp(env.DB, workspaceId, registration);
  return app ? json(app, 201, { 'cache-control': 'no-store' }) : json({ error: 'server_error' }, 500);
}

/** RFC 8414 metadata from the OAuth provider, the same at the root and at the issuer's path. */
async function serverMetadata(request: Request, env: AccessEnv, config: SignInConfig): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
  return oauthProviderAuthServerMetadata(createAuth(env.DB, config))(request);
}

/** A Better Auth route, if it is one a browser or an MCP client may call. */
async function library(request: Request, env: AccessEnv, config: SignInConfig, url: URL): Promise<Response> {
  const method = PUBLIC_AUTH_ROUTES[url.pathname];
  if (!method) return json({ error: 'not_found' }, 404);
  if (request.method !== method) return json({ error: 'method_not_allowed' }, 405, { allow: method });
  if (url.pathname === AUTHORIZE_PATH) {
    const authorization = await libraryAuthorization(request, env, config, url);
    return authorization instanceof Response ? authorization : createAuth(env.DB, config).handler(authorization);
  }
  if (method === 'GET') return createAuth(env.DB, config).handler(request);
  const text = await boundedText(request);
  const body = url.pathname === TOKEN_PATH ? libraryTokenBody(text, request.headers, config.origin) : text;
  if (url.pathname === REGISTER_PATH && namesReturnAddress(text, config.origin)) {
    return registrationRefused(400, 'invalid_redirect_uri', `${APP_RETURN_PATH} is not a redirect address`);
  }
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return createAuth(env.DB, config).handler(new Request(request.url, { method, headers, body }));
}

const AUTHORIZE_PATH = `${AUTH_BASE_PATH}/oauth2/authorize`;
const TOKEN_PATH = `${AUTH_BASE_PATH}/oauth2/token`;

/**
 * An authorization request as the library takes it. A home-network redirect
 * address, whether the request names it or its library form, reaches the
 * library in its library form. Until an owner allows the address, the
 * request asks for consent even from a person who allowed the app before, so
 * the approval page, where an owner allows it, is never skipped; one that
 * asks for no page at all is answered consent_required at that address,
 * which the app registered.
 */
async function libraryAuthorization(
  request: Request,
  env: AccessEnv,
  config: SignInConfig,
  url: URL,
): Promise<Request | Response> {
  const given = url.searchParams.get('redirect_uri');
  if (given === null) return request;
  const address = appAddress(config.origin, given);
  if (!isHomeNetworkHttp(address)) return request;
  const target = new URL(url);
  target.searchParams.set('redirect_uri', libraryAddress(config.origin, address));
  const state = await addressState(env.DB, address, url.searchParams.get('client_id') ?? '');
  if (state === 'held') {
    const prompt = new Set((url.searchParams.get('prompt') ?? '').split(' ').filter(Boolean));
    if (prompt.has('none')) {
      const refused = new URL(address);
      refused.searchParams.set('error', 'consent_required');
      refused.searchParams.set('error_description', 'a workspace owner has not allowed this address yet');
      const appState = url.searchParams.get('state');
      if (appState !== null) refused.searchParams.set('state', appState);
      refused.searchParams.set('iss', config.origin + AUTH_BASE_PATH);
      return new Response(null, {
        status: 302,
        headers: { location: refused.toString(), 'cache-control': 'no-store' },
      });
    }
    target.searchParams.set('prompt', [...prompt, 'consent'].join(' '));
  }
  return new Request(target, request);
}

/** A token request's body with a home-network redirect address in its library form, as the code was issued for it. */
function libraryTokenBody(text: string, headers: Headers, origin: string): string {
  const type = headers.get('content-type')?.split(';')[0]?.trim();
  if (type === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams(text);
    const address = form.get('redirect_uri');
    if (address === null || !isHomeNetworkHttp(address)) return text;
    form.set('redirect_uri', libraryAddress(origin, address));
    return form.toString();
  }
  if (type !== 'application/json') return text;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isRecord(body) || typeof body.redirect_uri !== 'string' || !isHomeNetworkHttp(body.redirect_uri)) return text;
  return JSON.stringify({ ...body, redirect_uri: libraryAddress(origin, body.redirect_uri) });
}

/** Whether an agent's registration body names APP_RETURN_PATH as a redirect address: only Ntasks gives the library that page. */
function namesReturnAddress(text: string, origin: string): boolean {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  return isRecord(body) && Array.isArray(body.redirect_uris) && namesReturnPage(origin, body.redirect_uris);
}

/**
 * GET APP_RETURN_PATH: the library's answer for a home-network redirect
 * address, passed on to that address. An answer with a code goes only to an
 * address an owner allowed; one without, such as a refusal, goes to any
 * enabled connected app's address.
 */
async function appReturn(request: Request, env: AccessEnv, url: URL): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
  const to = url.searchParams.get('to') ?? '';
  const state = isHomeNetworkHttp(to) ? await addressState(env.DB, to) : 'unknown';
  if (state === 'unknown') return expiredPage();
  const target = new URL(to);
  if (state === 'held' && url.searchParams.has('code')) return addressHeldPage({ address: target.origin });
  for (const [name, value] of url.searchParams) if (name !== 'to') target.searchParams.append(name, value);
  return new Response(null, {
    status: 303,
    headers: { location: target.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
}

/** Calls a Better Auth endpoint for one of this Worker's pages, as the browser that submitted the page. */
async function callLibrary(
  auth: Auth,
  config: SignInConfig,
  request: Request,
  path: string,
  body: unknown,
): Promise<Response> {
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json',
    origin: config.origin,
  });
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

/** The person, when their own browser session signed the request in; null for
 * a connected app, an agent, a service or a refusal. */
function personOf(verification: Verification): PersonPrincipal | null {
  return verification.ok && ownSession(verification.principal) ? verification.principal : null;
}

/** A form post from one of this Worker's pages must come from this origin. */
function fromThisOrigin(request: Request, config: SignInConfig): boolean {
  return request.headers.get('origin') === config.origin;
}

/**
 * /sign-in: the setup page until the deployment can sign in with GitHub
 * (setupPath), then the sign-in page.
 */
async function signInPath(
  request: Request,
  env: AccessEnv,
  signIn: SignIn,
  url: URL,
  address: string,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' });
  }
  const form = request.method === 'POST' ? new URLSearchParams(await boundedText(request)) : null;
  const setup = await setupPath(request, env, signIn, url, form, address);
  if (setup) return setup;
  if (signIn.state !== 'on') return notConfigured(env);
  return form ? signInPost(request, env, signIn.config, form) : signInGet(request, env, signIn.config, url);
}

/**
 * The setup's steps, or null for a request that is not one. Until the
 * deployment can sign in, GET shows the setup page. A POST with the setup
 * action checks AUTH_SECRET and answers with the form that posts the app's
 * manifest to GitHub. GitHub's return, a GET with `code` and `state`, stores
 * the app and signs the deployer in through it. Once sign-in exists, each
 * step is refused.
 */
async function setupPath(
  request: Request,
  env: AccessEnv,
  signIn: SignIn,
  url: URL,
  form: URLSearchParams | null,
  address: string,
): Promise<Response | null> {
  const starting = form?.get('action') === SETUP_ACTION;
  const returning = !form && url.searchParams.has('code') && url.searchParams.has('state');
  const showing = !form && !returning && signIn.state === 'setup';
  if (!starting && !returning && !showing) return null;
  // The setup binds sign-in to the origin it runs at, and AUTH_SECRET, its
  // cookie and GitHub's code must not travel in the clear: over http, other
  // than locally, the page is never shown, and every step goes to https.
  const origin = originOf(url.origin);
  if (origin === null) {
    return new Response(null, {
      status: 303,
      headers: { location: `https://${url.host}${SIGN_IN_PAGE}`, 'cache-control': 'no-store' },
    });
  }
  if (showing) return setupPage({ error: null });
  if (returning) {
    const answer = await finishSetup(request, env, signIn, url, origin);
    answer.headers.append('set-cookie', endSetupCookie(origin));
    return answer;
  }
  if (request.headers.get('origin') !== origin) return json({ error: 'cross_site_request' }, 403);
  if (signIn.state === 'off') return notConfigured(env);
  if (signIn.state === 'on') return alreadySetUp();
  // Each address is limited first, and an attempt it is refused does not
  // count toward the deployment's limit, which bounds guesses of AUTH_SECRET
  // from any number of addresses. Every attempt counts, since only one
  // succeeds.
  const fromAddress = await env.REGISTER_ADDRESS_LIMIT.limit({ key: `setup:${address}` });
  if (!fromAddress.success) return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
  const fromAll = await env.REGISTER_LIMIT.limit({ key: 'setup' });
  if (!fromAll.success) return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
  // AUTH_SECRET proves the request comes from whoever made the deployment.
  const given = await sha256(form?.get(AUTH_SECRET_FIELD) ?? '');
  if (!sameBytes(given, await sha256(signIn.secrets.secret))) {
    return setupPage({ error: 'That is not this deployment’s AUTH_SECRET.', status: 403 });
  }
  const { state, cookie } = await startSetupState(signIn.secrets.secret, origin);
  const nonce = randomSecret(16);
  const page = manifestPage(
    { action: `${GITHUB_NEW_APP}?state=${encodeURIComponent(state)}`, manifest: manifestFor(origin) },
    nonce,
  );
  page.headers.append('set-cookie', cookie);
  return page;
}

/** The page every setup step answers once sign-in exists. */
function alreadySetUp(): Response {
  return setupEndPage({
    status: 409,
    heading: 'Sign-in is already set up',
    words: 'This deployment signs in with GitHub. Setup runs only once.',
    next: 'Sign in',
  });
}

/**
 * GitHub's return from the manifest flow: checks the state against this
 * browser's setup cookie, exchanges the code for the app's credentials,
 * stores them with the app's owner as a deployment admin, and starts the
 * owner's sign-in through the new app. The caller ends the setup cookie.
 */
async function finishSetup(
  request: Request,
  env: AccessEnv,
  signIn: SignIn,
  url: URL,
  origin: string,
): Promise<Response> {
  if (signIn.state === 'off') return notConfigured(env);
  if (signIn.state === 'on') return alreadySetUp();
  const state = url.searchParams.get('state') ?? '';
  if (!(await setupStateHolds(signIn.secrets.secret, origin, state, request.headers))) {
    return setupEndPage({
      status: 400,
      heading: 'Setup did not finish',
      words: 'This setup link has expired, was used already, or was started in another browser.',
      next: 'Start again',
    });
  }
  const app = await convertManifest(url.searchParams.get('code') ?? '');
  if (!app) {
    return setupEndPage({
      status: 502,
      heading: 'Setup did not finish',
      words: 'GitHub did not return the new app.',
      next: 'Start again',
    });
  }
  const stored = await storeGitHubApp(
    env.DB,
    signIn.secrets,
    { origin, github: app.github, adminGithubId: app.ownerId },
    signIn.stale,
  );
  if (!stored) return alreadySetUp();
  const now = await loadSignIn(env);
  if (now.state !== 'on') return notConfigured(env);
  return startGitHubSignIn(request, env, now.config, null);
}

/**
 * Starts a sign-in with GitHub for the browser that sent `request`, and
 * sends it to GitHub. With an OAuth query, the library resumes the agent's
 * authorization once GitHub sends the browser back, and callbackURL is not
 * used.
 */
async function startGitHubSignIn(
  request: Request,
  env: AccessEnv,
  config: SignInConfig,
  oauthQuery: string | null,
): Promise<Response> {
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

/** The sign-in page. A changed or expired OAuth query shows the expired page. */
async function signInGet(request: Request, env: AccessEnv, config: SignInConfig, url: URL): Promise<Response> {
  const query = url.search.slice(1);
  const oauthQuery = await signedQuery(query, config);
  if (new URLSearchParams(query).has('sig') && oauthQuery === null) return expiredPage();
  const person = personOf(await verifyRequest(request, env));
  // A connected app's name is its owner's choice, so the page names it; an
  // agent names itself, and the approval page shows where it returns to.
  const client =
    oauthQuery === null ? null : await clientOf(env.DB, new URLSearchParams(oauthQuery).get('client_id') ?? '');
  return signInPage({
    signedInAs: person?.name ?? null,
    oauthQuery,
    error: url.searchParams.get('error'),
    app: client?.app ? client.name : null,
  });
}

/** The sign-in page's buttons, from this origin only: Sign in with GitHub, or Sign out. */
async function signInPost(
  request: Request,
  env: AccessEnv,
  config: SignInConfig,
  form: URLSearchParams,
): Promise<Response> {
  if (!fromThisOrigin(request, config)) return json({ error: 'cross_site_request' }, 403);
  if (form.get('action') === 'sign-out') {
    const signedOut = await callLibrary(createAuth(env.DB, config), config, request, `${AUTH_BASE_PATH}/sign-out`, {});
    return redirectWithCookies(SIGN_IN_PAGE, signedOut);
  }
  const rawQuery = form.get('oauth_query');
  const oauthQuery = rawQuery === null ? null : await signedQuery(rawQuery, config);
  if (rawQuery !== null && oauthQuery === null) return expiredPage();
  return startGitHubSignIn(request, env, config, oauthQuery);
}

/**
 * The approval page: GET shows it, with the projects of each workspace the
 * person belongs to, and POST records their answer. Both need a valid signed
 * OAuth query and an enabled client; without the person's session the
 * browser is sent to sign in first.
 */
async function agentAccess(request: Request, env: AccessEnv, config: SignInConfig, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST')
    return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' });
  const form = request.method === 'POST' ? new URLSearchParams(await boundedText(request)) : null;
  const oauthQuery = await signedQuery(form ? (form.get('oauth_query') ?? '') : url.search.slice(1), config);
  if (oauthQuery === null) return expiredPage();
  const verification = await verifyRequest(request, env);
  if (!verification.ok && verification.reason === 'cross_site') return refusal(verification, env);
  const person = personOf(verification);
  if (!person)
    return new Response(null, {
      status: 303,
      headers: { location: `${SIGN_IN_PAGE}?${oauthQuery}`, 'cache-control': 'no-store' },
    });
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get('client_id') ?? '';
  const client = await clientOf(env.DB, clientId);
  if (!client) return expiredPage();
  const given = params.get('redirect_uri') ?? '';
  // The library holds a home-network address in its form on this origin; the
  // page names the address itself, which only a connected app listing it has.
  const address = appAddress(config.origin, given);
  const home = address === given ? null : await addressState(env.DB, address, clientId);
  if (home === 'unknown' || (home !== null && !client.app)) return expiredPage();
  let returnsTo: string;
  try {
    // A native app's own scheme, such as myapp://callback, has no web origin.
    const target = new URL(address);
    returnsTo = target.origin !== 'null' ? target.origin : `${target.protocol}//${target.host}`;
  } catch {
    return expiredPage();
  }
  const scopes = (params.get('scope') ?? '').split(' ');
  if (client.app) {
    const { workspaceId, workspaceName } = client.app;
    const role = person.memberships.find(({ workspace }) => workspace.id === workspaceId)?.role ?? null;
    const member = role !== null;
    const words = appAccessWords(scopes);
    // Until an owner allows a home-network address, only an owner's Allow completes a sign-in from it.
    const held = home === 'held' ? { owner: role === 'owner' } : null;
    const show = (error: string | null) =>
      appAccessPage({
        personName: person.name,
        app: { name: client.name ?? clientId, uri: client.uri },
        workspaceName: workspaceName ?? workspaceId,
        access: words,
        member,
        held,
        returnsTo,
        oauthQuery,
        error,
      });
    if (!form) return show(null);
    const decision = form.get('decision');
    if (decision !== 'allow' && decision !== 'deny') return show('Choose Allow or Deny.');
    if (decision === 'allow' && (!member || words === null || held?.owner === false)) return show(null);
    if (decision === 'allow' && held && !(await allowAddress(env.DB, workspaceId, clientId, address))) {
      return expiredPage();
    }
    return answerConsent(request, env, config, oauthQuery, decision === 'allow');
  }
  const access = scopeAccess(scopes);
  // One store read for each workspace the person belongs to.
  const workspaces: WorkspaceProjects[] = await Promise.all(
    reachesOf(person).map(async ({ workspace }) => ({
      id: workspace.id,
      name: workspace.name,
      projects: await listProjects(env, workspace.id),
    })),
  );
  const show = (error: string | null) =>
    agentAccessPage({
      personName: person.name,
      client: { name: client.name ?? clientId, uri: client.uri },
      returnsTo,
      access,
      workspaces,
      oauthQuery,
      error,
    });
  if (!form) return show(null);
  if (form.get('decision') === 'allow') {
    if (access === null) return show('This agent asks for no access to tasks.');
    const chosen = form.getAll('project');
    if (chosen.length === 0) return show('Choose at least one project.');
    const grants = chosen.map((choice): AgentGrant | null => {
      const slash = choice.indexOf('/');
      const workspace = workspaces.find((candidate) => candidate.id === choice.slice(0, slash));
      const projectId = choice.slice(slash + 1);
      return slash > 0 && workspace?.projects.some((project) => project.id === projectId)
        ? { workspaceId: workspace.id, projectId, access }
        : null;
    });
    if (!grants.every((grant): grant is AgentGrant => grant !== null))
      return show('A chosen project no longer exists. Choose again.');
    // Grants first: a consent without grants would let the agent reach nothing.
    await setAgentGrants(env.DB, person.userId, clientId, grants);
  } else if (form.get('decision') !== 'deny') {
    return show('Choose Allow or Deny.');
  }
  return answerConsent(request, env, config, oauthQuery, form.get('decision') === 'allow');
}

/** Records the person's Allow or Deny with the library, and sends the browser back to the client. */
async function answerConsent(
  request: Request,
  env: AccessEnv,
  config: SignInConfig,
  oauthQuery: string,
  accept: boolean,
): Promise<Response> {
  // Built only once it is used: building starts database reads that must
  // finish before the response does.
  const response = await callLibrary(createAuth(env.DB, config), config, request, `${AUTH_BASE_PATH}/oauth2/consent`, {
    accept,
    oauth_query: oauthQuery,
  });
  const location = await nextUrl(response);
  if (location === null) return expiredPage();
  return redirectWithCookies(location, response);
}

/** What a connected app's scopes let it do as the person, in words; null when they let it do nothing with tasks. */
function appAccessWords(scopes: readonly string[]): string | null {
  const tasks = scopeAccess(scopes);
  const parts = [
    ...(tasks === 'write' ? ['Read and change tasks'] : tasks === 'read' ? ['Read tasks'] : []),
    ...(scopes.includes(SCOPES.decide) ? ['answer decisions and approve approvals'] : []),
  ];
  if (parts.length === 0) return null;
  const words = parts.join(', ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A JSON object body, of at most BODY_BYTES, or the sentence that refuses it; `what` names it. */
async function jsonBody(request: Request, what: string): Promise<Record<string, unknown> | string> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
    return `send the ${what} as application/json`;
  }
  let body: unknown;
  try {
    body = JSON.parse(await boundedText(request));
  } catch (error) {
    if (error instanceof BodyTooLarge) throw error;
    return 'the body is not JSON';
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'the body is one JSON object';
  return body as Record<string, unknown>;
}

/** The workspace as GET /api/workspaces lists it. */
function listedWorkspace({ workspace, role }: WorkspaceReach): Record<string, unknown> {
  return { workspaceId: workspace.id, name: workspace.name, role };
}

/** The refusal of a name that `workspaceNameOf` refuses, the same for creating and renaming. */
function badWorkspaceName(): Response {
  return json({ error: 'invalid_request', detail: 'name is one line of 1 to 128 characters', field: 'name' }, 400);
}

/**
 * GET /api/workspaces lists the workspaces the sender reaches. POST creates
 * one, named in the body, with the deployment admin who sends it as its
 * owner; the body may also give its id, a lowercase UUID, such as the id of
 * the NoticeOS workspace whose tasks it takes over. PATCH renames one.
 */
async function workspacesApi(request: Request, env: AccessEnv): Promise<Response> {
  const verification = await verifyRequest(request, env);
  if (!verification.ok) return refusal(verification, env);
  const principal = verification.principal;
  if (request.method === 'GET') return json({ workspaces: reachesOf(principal).map(listedWorkspace) }, 200);
  if (request.method === 'PATCH') return await renameApi(request, env, principal);
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST, PATCH' });
  if (!ownSession(principal) || !principal.admin) {
    return json({ error: 'admin_only', detail: 'only a deployment admin may create a workspace' }, 403);
  }
  const body = await jsonBody(request, 'workspace');
  if (typeof body === 'string') return json({ error: 'invalid_request', detail: body }, 400);
  const unknown = Object.keys(body).filter((key) => key !== 'name' && key !== 'workspaceId');
  if (unknown.length > 0) {
    return json({ error: 'invalid_request', detail: `unknown ${unknown.join(', ')}; send name and workspaceId` }, 400);
  }
  const name = workspaceNameOf(body.name);
  if (name === null) return badWorkspaceName();
  const id = body.workspaceId === undefined ? crypto.randomUUID() : body.workspaceId;
  if (typeof id !== 'string' || !WORKSPACE_ID.test(id)) {
    return json({ error: 'invalid_request', detail: 'workspaceId is a lowercase UUID', field: 'workspaceId' }, 400);
  }
  if (!(await createWorkspace(env.DB, { id, name }, principal.userId))) {
    return json({ error: 'workspace_exists', detail: 'a workspace already has this id', field: 'workspaceId' }, 409);
  }
  return json({ workspace: { workspaceId: id, name, role: 'owner' } }, 201);
}

/**
 * PATCH /api/workspaces renames the workspace the body names, for its owner.
 * A workspace the sender does not reach answers as one that does not exist.
 */
async function renameApi(request: Request, env: AccessEnv, principal: Principal): Promise<Response> {
  const body = await jsonBody(request, 'workspace');
  if (typeof body === 'string') return json({ error: 'invalid_request', detail: body }, 400);
  const unknown = Object.keys(body).filter((key) => key !== 'workspaceId' && key !== 'name');
  if (unknown.length > 0) {
    return json({ error: 'invalid_request', detail: `unknown ${unknown.join(', ')}; send workspaceId and name` }, 400);
  }
  if (typeof body.workspaceId !== 'string') {
    return json(
      { error: 'invalid_request', detail: 'workspaceId names the workspace to rename', field: 'workspaceId' },
      400,
    );
  }
  const chosen = chooseWorkspace(reachesOf(principal), body.workspaceId);
  if ('refused' in chosen) return chosen.refused;
  if (!chosen.reach.scopes.includes(SCOPES.manage)) {
    return json({ error: 'insufficient_scope', detail: lacking(SCOPES.manage) }, 403);
  }
  const name = workspaceNameOf(body.name);
  if (name === null) return badWorkspaceName();
  const workspace = { id: chosen.reach.workspace.id, name };
  await renameWorkspace(env.DB, workspace);
  return json({ workspace: listedWorkspace({ ...chosen.reach, workspace }) }, 200);
}

/**
 * The workspace whose members, invitations or service credentials a request
 * manages: the one its header names, or the person's only one. Only its
 * owner manages them; `what` names them in a member's refusal.
 */
function ownedWorkspace(request: Request, principal: PersonPrincipal, what: string): WorkspaceReach | Response {
  const chosen = chooseWorkspace(reachesOf(principal), request.headers.get(WORKSPACE_HEADER));
  if ('refused' in chosen) return chosen.refused;
  if (chosen.reach.role === 'owner') return chosen.reach;
  return json({ error: 'owner_only', detail: `only an owner of this workspace may manage ${what}` }, 403);
}

/** The JSON routes under /api/access: who the sender is, a person's agents,
 * and a workspace's members, invitations, service credentials, connected
 * apps and GitHub webhook. */
async function accessApi(request: Request, env: AccessEnv, url: URL): Promise<Response> {
  const verification = await verifyRequest(request, env);
  if (!verification.ok) return refusal(verification, env);
  const principal = verification.principal;
  const path = url.pathname.slice(ACCESS_API.length);
  if (path === '/me') {
    if (request.method === 'PATCH') return await saveTimeZone(request, env, principal);
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, PATCH' });
    return json(describe(principal), 200);
  }
  // Managing access is a person's own act in their own browser, never an
  // agent's, a service's or a connected app's.
  if (!ownSession(principal)) {
    return json(
      {
        error: 'owner_only',
        detail:
          'only a person signed in in their browser may manage access, not an agent, a service or a connected app',
      },
      403,
    );
  }
  if (path === '/agents' && request.method === 'GET')
    return json({ agents: await listAgents(env.DB, principal.userId) }, 200);
  const agent = /^\/agents\/([A-Za-z0-9_-]{1,255})\/revoke$/u.exec(path);
  if (agent?.[1] && request.method === 'POST') {
    // A connected app is revoked from its workspace's list of apps.
    const client = await clientOf(env.DB, agent[1]);
    if (client?.app || !(await revokeAgent(env.DB, principal.userId, agent[1])))
      throw new AccessRefused('not_found', 'no such connected agent');
    return json({ revoked: true }, 200);
  }
  const apps = await appsApi(request, env, principal, path);
  if (apps) return apps;
  const members = await membersApi(request, env, principal, path);
  if (members) return members;
  const github = await githubApi(request, env, principal, path, url);
  if (github) return github;
  const service = /^\/services\/([0-9a-f-]{36})\/revoke$/u.exec(path);
  const services = path === '/services' && (request.method === 'GET' || request.method === 'POST');
  if (!services && !(service?.[1] && request.method === 'POST')) return json({ error: 'not_found' }, 404);
  const owned = ownedWorkspace(request, principal, 'its service credentials');
  if (owned instanceof Response) return owned;
  const workspaceId = owned.workspace.id;
  if (service?.[1]) {
    if (!(await revokeServiceCredential(env.DB, workspaceId, service[1])))
      throw new AccessRefused('not_found', 'no such unrevoked service credential');
    return json({ revoked: true }, 200);
  }
  if (request.method === 'GET') return json({ services: await listServiceCredentials(env.DB, workspaceId) }, 200);
  const body = await jsonBody(request, 'credential');
  if (typeof body === 'string') throw new AccessRefused('invalid_request', body);
  const created = await createServiceCredential(env.DB, {
    workspaceId,
    projects: await listProjects(env, workspaceId),
    name: body.name,
    grants: body.grants,
    backup: body.backup,
    restore: body.restore,
    createdBy: principal.userId,
  });
  return json({ service: created }, 201);
}

/**
 * The connected-app routes of the request's workspace: GET /apps lists its
 * apps for any member, each with whether they signed in to it, and POST
 * /apps/<client id>/revoke ends their own sign-in to one. An owner registers
 * an app with POST /apps and removes one for everyone with POST
 * /apps/<client id>/remove. Null for any other path.
 */
async function appsApi(
  request: Request,
  env: AccessEnv,
  principal: PersonPrincipal,
  path: string,
): Promise<Response | null> {
  const post = request.method === 'POST';
  const list = path === '/apps' && request.method === 'GET';
  const register = path === '/apps' && post;
  const action = post ? /^\/apps\/([A-Za-z0-9_-]{1,255})\/(revoke|remove)$/u.exec(path) : null;
  if (!list && !register && !action) return null;
  const chosen = chooseWorkspace(reachesOf(principal), request.headers.get(WORKSPACE_HEADER));
  if ('refused' in chosen) return chosen.refused;
  const workspaceId = chosen.reach.workspace.id;
  if (list) return json({ apps: await listApps(env.DB, workspaceId, principal.userId) }, 200);
  const clientId = action?.[1] ?? '';
  if (action?.[2] === 'revoke') {
    const revoked =
      (await isAppOf(env.DB, workspaceId, clientId)) && (await revokeAgent(env.DB, principal.userId, clientId));
    if (!revoked) return json({ error: 'not_found', detail: 'you are not signed in to such an app here' }, 404);
    return json({ revoked: true }, 200);
  }
  if (chosen.reach.role !== 'owner') {
    return json({ error: 'owner_only', detail: 'only an owner of this workspace may manage its apps' }, 403);
  }
  if (action) {
    if (!(await removeApp(env.DB, workspaceId, clientId))) {
      return json({ error: 'not_found', detail: 'this workspace has no such app' }, 404);
    }
    return json({ removed: true }, 200);
  }
  const body = await jsonBody(request, 'app');
  if (typeof body === 'string') return json({ error: 'invalid_request', detail: body }, 400);
  const app = appRegistrationOf(body);
  if ('detail' in app) return json({ error: 'invalid_request', ...app }, 400);
  const signIn = await loadSignIn(env);
  if (signIn.state !== 'on') return notConfigured(env);
  // The library creates the client as the owner's own, with the token
  // settings every client shares; it never takes a reference id from a
  // request, so marking it as this workspace's app is Ntasks's own write.
  const library = libraryRegistration(signIn.config.origin, app);
  if ('detail' in library) return json({ error: 'invalid_request', ...library }, 400);
  const created: unknown = await createAuth(env.DB, signIn.config).api.adminCreateOAuthClient({
    headers: request.headers,
    body: {
      client_name: app.name,
      redirect_uris: library.redirectUris,
      application_type: library.applicationType,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: [...APP_SCOPES, OFFLINE_ACCESS].join(' '),
      require_pkce: true,
      skip_consent: false,
    },
  });
  const newId = isRecord(created) && typeof created.client_id === 'string' ? created.client_id : null;
  if (newId === null) return json({ error: 'internal_error' }, 500);
  await markApp(env.DB, newId, app.redirectUris, workspaceId);
  const [listed] = (await listApps(env.DB, workspaceId, principal.userId)).filter((entry) => entry.clientId === newId);
  return json({ app: listed }, 201);
}

/**
 * GitHub for the request's workspace, for its owners. GET /github shows the
 * workspace's GitHub App, its installations and the deploy checks
 * deliveries showed, with the webhook set up by hand: where GitHub sends
 * deliveries, whether a secret is saved and the deploy checks typed, never
 * a secret. POST /github/app starts Connect GitHub; GitHub returns the
 * browser to GET /github/app/created, and POST /github/app/remove forgets
 * the app. POST /github/checks switches a detected deploy check on or off.
 * POST /github saves a webhook secret, typed deploy checks or both, and
 * POST /github/remove removes that webhook. Null for any other path.
 */
async function githubApi(
  request: Request,
  env: AccessEnv,
  principal: PersonPrincipal,
  path: string,
  url: URL,
): Promise<Response | null> {
  const post = request.method === 'POST';
  const route =
    path === '/github' && request.method === 'GET'
      ? 'show'
      : path === '/github/app/created' && request.method === 'GET'
        ? 'created'
        : post && ['/github', '/github/remove', '/github/app', '/github/app/remove', '/github/checks'].includes(path)
          ? path
          : null;
  if (route === null) return null;
  const secrets = signInSecrets(env);
  if (!secrets) return notConfigured(env);
  if (route === 'created') return githubAppCreated(request, env, principal, url, secrets.secret);
  const owned = ownedWorkspace(request, principal, 'its GitHub connection');
  if (owned instanceof Response) return owned;
  const workspaceId = owned.workspace.id;
  if (route === '/github/app') {
    const started = await startGitHubApp(secrets.secret, url.origin, workspaceId, principal.userId);
    return json({ action: started.action, manifest: started.manifest }, 200, { 'set-cookie': started.cookie });
  }
  if (route === '/github/app/remove') {
    if (!(await removeGitHubApp(env.DB, workspaceId))) {
      return json({ error: 'not_found', detail: 'this workspace has no GitHub App' }, 404);
    }
    return json({ removed: true }, 200);
  }
  if (route === '/github/remove') {
    if (!(await removeGitHubWebhook(env.DB, workspaceId))) {
      return json({ error: 'not_found', detail: 'this workspace has no GitHub webhook' }, 404);
    }
    return json({ removed: true }, 200);
  }
  if (route === '/github/checks') {
    const body = await jsonBody(request, 'deploy check');
    if (typeof body === 'string') return json({ error: 'invalid_request', detail: body }, 400);
    const unknown = Object.keys(body).filter((key) => key !== 'name' && key !== 'on');
    if (unknown.length > 0 || typeof body.name !== 'string' || typeof body.on !== 'boolean') {
      return json({ error: 'invalid_request', detail: 'send name, a deploy check Settings lists, and on' }, 400);
    }
    if (!(await setDeployCheck(env.DB, workspaceId, body.name, body.on))) {
      return json(
        { error: 'not_found', detail: 'no delivery showed a deploy check with this name', field: 'name' },
        404,
      );
    }
  }
  if (route === '/github') {
    const body = await jsonBody(request, 'webhook settings');
    if (typeof body === 'string') return json({ error: 'invalid_request', detail: body }, 400);
    const settings = githubWebhookSettingsOf(body);
    if ('detail' in settings) return json({ error: 'invalid_request', ...settings }, 400);
    if (!(await saveGitHubWebhook(env.DB, secrets.secret, workspaceId, settings, principal.userId))) {
      return json(
        {
          error: 'invalid_request',
          detail: 'save a secret first: GitHub signs every delivery with it',
          field: 'secret',
        },
        400,
      );
    }
  }
  const [byHand, app] = await Promise.all([
    githubWebhookView(env.DB, secrets.secret, workspaceId, url.origin),
    githubAppView(env.DB, workspaceId, await githubIdOf(env.DB, principal.userId)),
  ]);
  return json({ github: { ...byHand, ...app } }, 200);
}

/**
 * GET /github/app/created: where GitHub returns the browser once the person
 * pressed Create GitHub App, with a code and the state Connect GitHub
 * signed. It stores the app for the state's workspace, when the person
 * signed in is that workspace's owner who started it, in this browser, and
 * sends the browser on to install the app on their own GitHub account.
 * Anything else returns them to Settings, which says to press Connect
 * GitHub again.
 */
async function githubAppCreated(
  request: Request,
  env: AccessEnv,
  principal: PersonPrincipal,
  url: URL,
  secret: string,
): Promise<Response> {
  const redirect = (location: string) =>
    new Response(null, {
      status: 302,
      headers: { location, 'set-cookie': endGitHubAppCookie(url.origin), 'cache-control': 'no-store' },
    });
  const retry = redirect(`${url.origin}${SETTINGS_PAGE}?github=retry`);
  const state = url.searchParams.get('state') ?? '';
  const workspaceId = await gitHubAppStateOf(secret, url.origin, state, request.headers, principal.userId);
  const owner = reachesOf(principal).some((reach) => reach.workspace.id === workspaceId && reach.role === 'owner');
  if (workspaceId === null || !owner) return retry;
  const app = await convertGitHubApp(url.searchParams.get('code') ?? '');
  if (app === null) return retry;
  await saveGitHubApp(env.DB, secret, workspaceId, app, principal.userId);
  return redirect(githubAppLinks(app.slug, await githubIdOf(env.DB, principal.userId)).accountInstallUrl);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The member routes of the request's workspace, for its owners: GET /members
 * lists its members and open invitations, POST /invitations invites a GitHub
 * login, POST /invitations/<id>/revoke revokes an open invitation, and POST
 * /members/<user id>/remove removes a member. Null for any other path.
 */
async function membersApi(
  request: Request,
  env: AccessEnv,
  principal: PersonPrincipal,
  path: string,
): Promise<Response | null> {
  const list = path === '/members' && request.method === 'GET';
  const invite = path === '/invitations' && request.method === 'POST';
  const post = request.method === 'POST';
  const revoke = post ? /^\/invitations\/([0-9a-f-]{36})\/revoke$/u.exec(path)?.[1] : undefined;
  const remove = post ? /^\/members\/([A-Za-z0-9_-]{1,255})\/remove$/u.exec(path)?.[1] : undefined;
  if (!list && !invite && revoke === undefined && remove === undefined) return null;
  const owned = ownedWorkspace(request, principal, 'its members and invitations');
  if (owned instanceof Response) return owned;
  const workspaceId = owned.workspace.id;
  if (list) return json(await listMembers(env.DB, workspaceId), 200);
  if (revoke !== undefined) {
    if (!(await revokeInvitation(env.DB, workspaceId, revoke))) {
      return json({ error: 'not_found', detail: 'no such open invitation in this workspace' }, 404);
    }
    return json({ revoked: true }, 200);
  }
  if (remove !== undefined) {
    const outcome = await removeMember(env.DB, workspaceId, remove);
    if (outcome === 'not_found') return json({ error: 'not_found', detail: 'no such member of this workspace' }, 404);
    if (outcome === 'last_owner') {
      return json(
        { error: 'last_owner', detail: "this is the workspace's last owner, and a workspace keeps at least one" },
        409,
      );
    }
    return json({ removed: true }, 200);
  }
  const body = await jsonBody(request, 'invitation');
  if (typeof body === 'string') return json({ error: 'invalid_request', detail: body }, 400);
  const unknown = Object.keys(body).filter((key) => key !== 'githubLogin' && key !== 'role');
  if (unknown.length > 0) {
    return json({ error: 'invalid_request', detail: `unknown ${unknown.join(', ')}; send githubLogin and role` }, 400);
  }
  const githubLogin = githubLoginOf(body.githubLogin);
  if (githubLogin === null) {
    return json(
      {
        error: 'invalid_request',
        detail: 'githubLogin is a GitHub username: 1 to 39 letters, digits or hyphens, starting with a letter or digit',
        field: 'githubLogin',
      },
      400,
    );
  }
  const role = body.role ?? 'member';
  if (role !== 'owner' && role !== 'member') {
    return json({ error: 'invalid_request', detail: 'role is owner or member', field: 'role' }, 400);
  }
  const invitation = await createInvitation(env.DB, { workspaceId, githubLogin, role, createdBy: principal.userId });
  if (invitation === null) {
    return json(
      {
        error: 'invitation_exists',
        detail: `${githubLogin} already has an open invitation to this workspace`,
        field: 'githubLogin',
      },
      409,
    );
  }
  return json({ invitation }, 201);
}

/**
 * What GET /api/access/me answers: the sender's kind and name, whether it is
 * a deployment admin, and its projects: `all` for a person, who reaches every
 * project of their workspaces, or each project an agent or a service was
 * granted, with its workspace. Through a connected app, `app` names the app,
 * its one workspace and the scopes the person holds there through it.
 */
function describe(principal: Principal): Record<string, unknown> {
  const deploymentAdmin = principal.kind === 'person' && principal.admin;
  const projects =
    principal.kind === 'person'
      ? 'all'
      : reachesOf(principal).flatMap(({ workspace, projects: granted }) =>
          granted === 'all'
            ? []
            : [...granted].map(([projectId, access]) => ({ workspaceId: workspace.id, projectId, access })),
        );
  const through = principal.kind === 'person' ? principal.app : undefined;
  const [reach] = through === undefined ? [] : reachesOf(principal);
  const app =
    through === undefined || reach === undefined
      ? {}
      : {
          app: {
            clientId: through.clientId,
            name: through.name,
            workspaceId: reach.workspace.id,
            scopes: reach.scopes,
          },
        };
  const zone = principal.kind === 'person' ? { timeZone: principal.timeZone ?? null } : {};
  return { kind: principal.kind, name: principal.name, deploymentAdmin, projects, ...zone, ...app };
}

/**
 * PATCH /api/access/me saves the time zone a person chose in Settings, an
 * IANA name, or forgets it with null so their browser's is used again. It
 * answers as GET /api/access/me does. Only a person has one.
 */
async function saveTimeZone(request: Request, env: AccessEnv, principal: Principal): Promise<Response> {
  if (principal.kind !== 'person') {
    return json({ error: 'person_only', detail: 'only a person has a time zone, not an agent or a service' }, 403);
  }
  const body = await jsonBody(request, 'time zone');
  if (typeof body === 'string') return json({ error: 'invalid_request', detail: body }, 400);
  const unknown = Object.keys(body).filter((key) => key !== 'timeZone');
  if (unknown.length > 0) {
    return json({ error: 'invalid_request', detail: `unknown ${unknown.join(', ')}; send timeZone` }, 400);
  }
  const zone = body.timeZone;
  if (zone !== null && !isTimeZone(zone)) {
    return json(
      {
        error: 'invalid_request',
        detail: 'timeZone is an IANA time zone, such as America/Los_Angeles, or null for the browser’s',
        field: 'timeZone',
      },
      400,
    );
  }
  await env.DB.prepare('UPDATE auth_user SET time_zone = ?1, updated_at = ?2 WHERE id = ?3')
    .bind(zone, new Date().toISOString(), principal.userId)
    .run();
  const { timeZone: _, ...rest } = principal;
  return json(describe(zone === null ? rest : { ...rest, timeZone: zone }), 200);
}
