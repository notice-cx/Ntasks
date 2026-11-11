/**
 * Connected apps: OAuth clients that an owner of a workspace, or the
 * workspace's own service with its credential, registers, such as another
 * product's web page that shows the workspace's tasks. A person
 * who signs in to one through Ntasks lets it act as them in that workspace
 * (verify.ts). The OAuth provider stores the client; this module marks it as
 * the workspace's app, lists a workspace's apps, removes one, and answers
 * which origins may call the API from a browser.
 */
import { APP_SCOPES, appReference, appWorkspaceOf, OFFLINE_ACCESS } from './protocol.ts';

/** An app's name: 1 to 64 letters, digits, spaces, dots, dashes or underscores, as a service credential's. */
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;
const MOST_REDIRECTS = 10;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** The client metadata key that lists the home-network addresses an owner allowed (allowAddress). */
const ALLOWED_KEY = 'allowed_http_redirect_uris';
/**
 * Where the sign-in library sends a code meant for a home-network address:
 * the library takes http only on this machine, so it is given this https
 * page of Ntasks's own, with the address in `to`, and the page passes the
 * answer on (appReturn in routes.ts).
 */
export const APP_RETURN_PATH = '/api/access/return';

/**
 * Whether a host is on a home network: a name under .local, which mDNS
 * answers on the local network, a private IPv4 address (RFC 1918), or an
 * IPv6 unique-local address (fc00::/7). `hostname` is as URL writes it.
 */
export function isHomeNetworkHost(hostname: string): boolean {
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/u.test(hostname)) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const ipv6 = /^\[([0-9a-f]{1,4}):[0-9a-f:.]*\]$/u.exec(hostname);
  return ipv6 !== null && (Number.parseInt(ipv6[1] ?? '', 16) & 0xfe00) === 0xfc00;
}

/** Whether an address is an http one on a home network, which an owner of the app's workspace allows before anyone signs in from it. */
export function isHomeNetworkHttp(address: string): boolean {
  const url = urlOf(address);
  return url !== null && url.protocol === 'http:' && isHomeNetworkHost(url.hostname);
}

/** The address the sign-in library is given for a redirect address: APP_RETURN_PATH for a home-network one, else the address itself. */
export function libraryAddress(origin: string, address: string): string {
  if (!isHomeNetworkHttp(address)) return address;
  const relay = new URL(APP_RETURN_PATH, origin);
  relay.searchParams.set('to', address);
  return relay.toString();
}

/** The redirect address a library address stands for: the reverse of libraryAddress. */
export function appAddress(origin: string, address: string): string {
  const url = urlOf(address);
  const to = url?.searchParams.get('to');
  return url !== null && url.origin === origin && url.pathname === APP_RETURN_PATH && to && isHomeNetworkHttp(to)
    ? to
    : address;
}

/**
 * The library's form of a registration: its addresses, and the application
 * type they need (RFC 8252 for this machine), or why it is refused. Only
 * Ntasks gives the library APP_RETURN_PATH, so no registration names it.
 */
export function libraryRegistration(
  origin: string,
  registration: AppRegistration,
): { readonly redirectUris: string[]; readonly applicationType: 'web' | 'native' } | RegistrationRefused {
  if (namesReturnPage(origin, registration.redirectUris)) {
    return { detail: `${APP_RETURN_PATH} is not a redirect address`, field: 'redirectUris' };
  }
  const redirectUris = registration.redirectUris.map((address) => libraryAddress(origin, address));
  const local = redirectUris.some((address) => LOOPBACK.has(urlOf(address)?.hostname ?? ''));
  return { redirectUris, applicationType: local ? 'native' : 'web' };
}

/** Whether any of these addresses is APP_RETURN_PATH on this origin. */
export function namesReturnPage(origin: string, addresses: readonly unknown[]): boolean {
  return addresses.some((value) => {
    const url = typeof value === 'string' ? urlOf(value) : null;
    return url !== null && url.origin === origin && url.pathname === APP_RETURN_PATH;
  });
}

/** A connected app to register, checked: the OAuth client the provider creates from it (libraryRegistration). */
export interface AppRegistration {
  readonly name: string;
  readonly redirectUris: readonly string[];
}

/** Why a registration is refused: a sentence, and the body field it is about. */
export interface RegistrationRefused {
  readonly detail: string;
  readonly field?: 'name' | 'redirectUris';
}

/**
 * A registration from untrusted input, or why it is refused. Each redirect
 * address is an https address on a public host, an http one on localhost,
 * 127.0.0.1 or [::1] for an app running on the same machine, or an http one
 * on a home network (isHomeNetworkHost), which no one signs in from until an
 * owner allows it; none has a fragment or credentials.
 */
export function appRegistrationOf(body: Readonly<Record<string, unknown>>): AppRegistration | RegistrationRefused {
  const unknown = Object.keys(body).filter((key) => key !== 'name' && key !== 'redirectUris');
  if (unknown.length > 0) return { detail: `unknown ${unknown.join(', ')}; send name and redirectUris` };
  return checkedRegistration(body.name, body.redirectUris, { name: 'name', redirectUris: 'redirectUris' });
}

/** The client metadata fields a service may send when it registers its app (RFC 7591 section 2). */
const CLIENT_METADATA = new Set([
  'client_name',
  'redirect_uris',
  'token_endpoint_auth_method',
  'grant_types',
  'response_types',
  'scope',
]);
const APP_GRANTS: readonly string[] = ['authorization_code', 'refresh_token'];
const APP_SCOPE_CHOICES: readonly string[] = [...APP_SCOPES, OFFLINE_ACCESS];

/** A connected app a service registers: an owner's registration, with the scopes its client may ask for. */
export interface ServiceAppRegistration extends AppRegistration {
  readonly scope: readonly string[];
}

/**
 * The RFC 7591 client metadata a service registers its connected app with,
 * checked as an owner's registration is, or why it is refused. The app is a
 * public client using the authorization code grant; scope, when sent, lists
 * some of a connected app's scopes, and every one of them otherwise.
 */
export function serviceAppRegistrationOf(
  body: Readonly<Record<string, unknown>>,
): ServiceAppRegistration | RegistrationRefused {
  const unknown = Object.keys(body).filter((key) => !CLIENT_METADATA.has(key));
  if (unknown.length > 0) return { detail: `unknown ${unknown.join(', ')}; send client_name and redirect_uris` };
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
    return { detail: 'a connected app is a public client: token_endpoint_auth_method is none' };
  }
  if (body.grant_types !== undefined && !someOf(body.grant_types, APP_GRANTS)) {
    return { detail: 'grant_types lists authorization_code and, for a refresh token, refresh_token' };
  }
  if (body.response_types !== undefined && !someOf(body.response_types, ['code'])) {
    return { detail: 'response_types is ["code"]' };
  }
  const scope =
    body.scope === undefined ? APP_SCOPE_CHOICES : typeof body.scope === 'string' ? body.scope.split(' ') : [];
  if (!someOf(scope, APP_SCOPE_CHOICES)) return { detail: `scope lists some of ${APP_SCOPE_CHOICES.join(' ')}` };
  const registration = checkedRegistration(body.client_name, body.redirect_uris, {
    name: 'client_name',
    redirectUris: 'redirect_uris',
  });
  return 'detail' in registration ? registration : { ...registration, scope: [...new Set(scope)] };
}

/** Whether a value is a non-empty array of distinct strings, each one of `allowed`. */
function someOf(value: unknown, allowed: readonly string[]): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every((item) => typeof item === 'string' && allowed.includes(item))
  );
}

/** The checks every registration shares, its fields named as the request names them. */
function checkedRegistration(
  givenName: unknown,
  given: unknown,
  words: { readonly name: string; readonly redirectUris: string },
): AppRegistration | RegistrationRefused {
  const name = typeof givenName === 'string' ? givenName.trim() : '';
  if (!NAME.test(name)) {
    return { detail: `${words.name} is 1 to 64 letters, digits, spaces, dots, dashes or underscores`, field: 'name' };
  }
  if (!Array.isArray(given) || given.length === 0 || given.length > MOST_REDIRECTS) {
    return { detail: `${words.redirectUris} lists 1 to ${MOST_REDIRECTS} addresses`, field: 'redirectUris' };
  }
  const redirectUris: string[] = [];
  for (const value of given as unknown[]) {
    const url = typeof value === 'string' && value.length <= 2048 ? urlOf(value) : null;
    const loopback = url !== null && LOOPBACK.has(url.hostname);
    const home = url !== null && isHomeNetworkHost(url.hostname);
    // Written as its origin and then a path, so the address names the
    // origin the app runs at exactly as a browser sends it (isAppOrigin).
    const allowed =
      url !== null &&
      url.username === '' &&
      url.password === '' &&
      !String(value).includes('#') &&
      String(value).startsWith(`${url.origin}/`) &&
      ((url.protocol === 'https:' && !loopback) || (url.protocol === 'http:' && (loopback || home)));
    if (!allowed) {
      return {
        detail:
          'each redirect address is an https address, or an http one on localhost, 127.0.0.1, [::1] or a home network (a .local name, 10.x, 172.16-31.x, 192.168.x or fc00::/7), written in lowercase with a path, such as https://app.example.com/callback, without a fragment',
        field: 'redirectUris',
      };
    }
    redirectUris.push(String(value));
  }
  if (new Set(redirectUris).size !== redirectUris.length) {
    return { detail: `${words.redirectUris} lists each address once`, field: 'redirectUris' };
  }
  return { name, redirectUris };
}

/** A connected app as a registration answers it (RFC 7591 section 3.2.1). */
export interface RegisteredClient {
  readonly client_id: string;
  readonly client_name: string;
  readonly redirect_uris: readonly string[];
  readonly token_endpoint_auth_method: 'none';
  readonly grant_types: readonly string[];
  readonly response_types: readonly string[];
  readonly scope: string;
  /** The home-network addresses no owner has allowed yet, which no one signs in from. */
  readonly held_redirect_uris: readonly string[];
}

/**
 * The workspace's enabled app with this name and these redirect addresses,
 * in any order, as a registration answers it, or null: a service that
 * registers its app again, such as after it lost the answer, gets the same one.
 */
export async function registeredApp(
  db: D1Database,
  workspaceId: string,
  registration: AppRegistration,
): Promise<RegisteredClient | null> {
  const { results } = await db
    .prepare(
      `SELECT client_id, redirect_uris, scopes, grant_types, response_types, metadata FROM auth_oauth_client
       WHERE reference_id = ? AND name = ? AND coalesce(disabled, 0) = 0
       ORDER BY created_at DESC LIMIT 50`,
    )
    .bind(appReference(workspaceId), registration.name)
    .all<{
      client_id: string;
      redirect_uris: string;
      scopes: string | null;
      grant_types: string | null;
      response_types: string | null;
      metadata: string | null;
    }>();
  const wanted = [...registration.redirectUris].sort().join('\n');
  const row = results.find((found) => stringsOf(found.redirect_uris).sort().join('\n') === wanted);
  if (!row) return null;
  const redirectUris = stringsOf(row.redirect_uris);
  const allowed = allowedOf(row.metadata);
  return {
    client_id: row.client_id,
    client_name: registration.name,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: stringsOf(row.grant_types ?? '[]'),
    response_types: stringsOf(row.response_types ?? '[]'),
    scope: stringsOf(row.scopes ?? '[]').join(' '),
    held_redirect_uris: redirectUris.filter((address) => isHomeNetworkHttp(address) && !allowed.includes(address)),
  };
}

/**
 * Gives a client the provider just created its redirect addresses as
 * registered, in place of their library forms (libraryAddress), and, with
 * `workspaceId`, marks it as a connected app of that workspace.
 */
export async function markApp(
  db: D1Database,
  clientId: string,
  redirectUris: readonly string[],
  workspaceId?: string,
): Promise<void> {
  await db
    .prepare(
      'UPDATE auth_oauth_client SET redirect_uris = ?, reference_id = coalesce(?, reference_id) WHERE client_id = ?',
    )
    .bind(JSON.stringify(redirectUris), workspaceId === undefined ? null : appReference(workspaceId), clientId)
    .run();
}

/** Where a home-network address stands for an app: no app of that workspace lists it, held, or allowed by an owner. */
export type AddressState = 'unknown' | 'held' | 'allowed';

/**
 * The state of a home-network redirect address of an enabled connected app,
 * `clientId`'s or, without one, any app's: allowed when an owner allowed it
 * for an app that lists it.
 */
export async function addressState(db: D1Database, address: string, clientId?: string): Promise<AddressState> {
  const { results } = await db
    .prepare(
      `SELECT c.metadata FROM auth_oauth_client c
       WHERE substr(c.reference_id, 1, length(?1)) = ?1 AND coalesce(c.disabled, 0) = 0
         AND (?3 IS NULL OR c.client_id = ?3)
         AND EXISTS (SELECT 1 FROM json_each(c.redirect_uris) r WHERE r.value = ?2)
       LIMIT 50`,
    )
    .bind(appReference(''), address, clientId ?? null)
    .all<{ metadata: string | null }>();
  if (results.length === 0) return 'unknown';
  return results.some((row) => allowedOf(row.metadata).includes(address)) ? 'allowed' : 'held';
}

/**
 * Records that an owner of the app's workspace allowed one of its
 * home-network addresses, so its sign-ins complete and its page may call the
 * API (isAppOrigin). False when the workspace has no such enabled app
 * listing the address.
 */
export async function allowAddress(
  db: D1Database,
  workspaceId: string,
  clientId: string,
  address: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT metadata FROM auth_oauth_client c
       WHERE c.client_id = ? AND c.reference_id = ? AND coalesce(c.disabled, 0) = 0
         AND EXISTS (SELECT 1 FROM json_each(c.redirect_uris) r WHERE r.value = ?)`,
    )
    .bind(clientId, appReference(workspaceId), address)
    .first<{ metadata: string | null }>();
  if (!row) return false;
  let seen = row.metadata;
  // Written only over the metadata just read, so two owners allowing two
  // addresses at once both keep theirs.
  for (let attempt = 0; attempt < 3; attempt++) {
    const allowed = allowedOf(seen);
    if (allowed.includes(address)) return true;
    const written = await db
      .prepare(
        `UPDATE auth_oauth_client SET metadata = ?1, updated_at = ?2
         WHERE client_id = ?3 AND reference_id = ?4 AND metadata IS ?5`,
      )
      .bind(
        JSON.stringify({ ...objectOf(seen), [ALLOWED_KEY]: [...allowed, address] }),
        new Date().toISOString(),
        clientId,
        appReference(workspaceId),
        seen,
      )
      .run();
    if (written.meta.changes === 1) return true;
    const again = await db
      .prepare('SELECT metadata FROM auth_oauth_client WHERE client_id = ? AND reference_id = ?')
      .bind(clientId, appReference(workspaceId))
      .first<{ metadata: string | null }>();
    if (!again) return false;
    seen = again.metadata;
  }
  return false;
}

/** A workspace's connected app, as GET /api/access/apps lists it. */
export interface ConnectedAppEntry {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly createdAt: string | null;
  /** When the person asking last allowed it, or null when they have not signed in to it. */
  readonly connectedAt: string | null;
}

/** The workspace's apps, newest first, each with whether this person signed in to it. */
export async function listApps(db: D1Database, workspaceId: string, userId: string): Promise<ConnectedAppEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT c.client_id, c.name, c.redirect_uris, c.created_at,
         (SELECT max(k.updated_at) FROM auth_oauth_consent k
           WHERE k.client_id = c.client_id AND k.user_id = ?) AS connected_at
       FROM auth_oauth_client c
       WHERE c.reference_id = ? AND coalesce(c.disabled, 0) = 0
       ORDER BY c.created_at DESC LIMIT 200`,
    )
    .bind(userId, appReference(workspaceId))
    .all<{
      client_id: string;
      name: string | null;
      redirect_uris: string;
      created_at: string | null;
      connected_at: string | null;
    }>();
  return results.map((row) => ({
    clientId: row.client_id,
    name: row.name ?? row.client_id,
    redirectUris: stringsOf(row.redirect_uris),
    createdAt: row.created_at,
    connectedAt: row.connected_at,
  }));
}

/** An enabled client, with the workspace it is a connected app of, if it is one. */
export interface ClientSummary {
  readonly name: string | null;
  readonly uri: string | null;
  /** The app's workspace, or null for an agent. */
  readonly app: { readonly workspaceId: string; readonly workspaceName: string | null } | null;
}

/** The enabled client with this id, or null. */
export async function clientOf(db: D1Database, clientId: string): Promise<ClientSummary | null> {
  const row = await db
    .prepare(
      `SELECT c.name, c.uri, c.reference_id,
         (SELECT w.name FROM workspaces w WHERE c.reference_id = ? || w.id) AS workspace_name
       FROM auth_oauth_client c WHERE c.client_id = ? AND coalesce(c.disabled, 0) = 0`,
    )
    .bind(appReference(''), clientId)
    .first<{ name: string | null; uri: string | null; reference_id: string | null; workspace_name: string | null }>();
  if (!row) return null;
  const workspaceId = appWorkspaceOf(row.reference_id);
  return {
    name: row.name,
    uri: row.uri,
    app: workspaceId === null ? null : { workspaceId, workspaceName: row.workspace_name },
  };
}

/** Whether the client is a connected app of this workspace and enabled. */
export async function isAppOf(db: D1Database, workspaceId: string, clientId: string): Promise<boolean> {
  const row = await db
    .prepare(
      'SELECT 1 AS found FROM auth_oauth_client WHERE client_id = ? AND reference_id = ? AND coalesce(disabled, 0) = 0',
    )
    .bind(clientId, appReference(workspaceId))
    .first<{ found: number }>();
  return row !== null;
}

/**
 * Removes a workspace's app for everyone, in one batch: the client is
 * disabled, so no new sign-in starts, and every person's consent and token
 * for it go. False when the workspace has no such enabled app.
 */
export async function removeApp(db: D1Database, workspaceId: string, clientId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const reference = appReference(workspaceId);
  // Each statement acts only on this workspace's app, never on an agent or another workspace's app.
  const ours = 'EXISTS (SELECT 1 FROM auth_oauth_client c WHERE c.client_id = ?2 AND c.reference_id = ?3)';
  const [disabled] = await db.batch([
    db
      .prepare(
        'UPDATE auth_oauth_client SET disabled = 1, updated_at = ?1 WHERE client_id = ?2 AND reference_id = ?3 AND coalesce(disabled, 0) = 0',
      )
      .bind(now, clientId, reference),
    db
      .prepare(`UPDATE auth_oauth_access_token SET revoked = ?1 WHERE client_id = ?2 AND revoked IS NULL AND ${ours}`)
      .bind(now, clientId, reference),
    db
      .prepare(`UPDATE auth_oauth_refresh_token SET revoked = ?1 WHERE client_id = ?2 AND revoked IS NULL AND ${ours}`)
      .bind(now, clientId, reference),
    db
      .prepare(
        'DELETE FROM auth_oauth_consent WHERE client_id = ?1 AND EXISTS (SELECT 1 FROM auth_oauth_client c WHERE c.client_id = ?1 AND c.reference_id = ?2)',
      )
      .bind(clientId, reference),
  ]);
  return (disabled?.meta.changes ?? 0) === 1;
}

/**
 * Whether a page at this origin may read the API's answers: it is the origin
 * of a redirect address of an enabled connected app, and, for an http
 * address on a home network, one an owner allowed. A redirect address is
 * the app's own page, so its origin is where the app runs.
 */
export async function isAppOrigin(db: D1Database, origin: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM auth_oauth_client c
       WHERE substr(c.reference_id, 1, length(?1)) = ?1 AND coalesce(c.disabled, 0) = 0
         AND EXISTS (SELECT 1 FROM json_each(c.redirect_uris) r
           WHERE (r.value = ?2 OR substr(r.value, 1, length(?2) + 1) = ?2 || '/')
             AND (?3 = 0 OR EXISTS (SELECT 1 FROM json_each(
               CASE WHEN json_valid(c.metadata) THEN
                 CASE WHEN json_type(c.metadata, '$.${ALLOWED_KEY}') = 'array'
                   THEN json_extract(c.metadata, '$.${ALLOWED_KEY}') ELSE '[]' END
               ELSE '[]' END) a
               WHERE a.value = r.value)))
       LIMIT 1`,
    )
    .bind(appReference(''), origin, isHomeNetworkHttp(`${origin}/`) ? 1 : 0)
    .first<{ found: number }>();
  return row !== null;
}

function urlOf(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** A client's metadata column as an object, or an empty one. */
function objectOf(text: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text ?? '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The home-network addresses an owner allowed, from a client's metadata column. */
function allowedOf(text: string | null): string[] {
  const value = objectOf(text)[ALLOWED_KEY];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** The strings of a JSON array column, or none. */
function stringsOf(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
