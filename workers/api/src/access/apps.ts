/**
 * Connected apps: OAuth clients that an owner of a workspace registers, such
 * as another product's web page that shows the workspace's tasks. A person
 * who signs in to one through Ntasks lets it act as them in that workspace
 * (verify.ts). The OAuth provider stores the client; this module marks it as
 * the workspace's app, lists a workspace's apps, removes one, and answers
 * which origins may call the API from a browser.
 */
import { appReference, appWorkspaceOf } from './protocol.ts';

/** An app's name: 1 to 64 letters, digits, spaces, dots, dashes or underscores, as a service credential's. */
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;
const MOST_REDIRECTS = 10;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A connected app to register, checked: the OAuth client the provider creates from it. */
export interface AppRegistration {
  readonly name: string;
  readonly redirectUris: readonly string[];
  /** `native` when an address is on this machine, which the provider allows only for a native app. */
  readonly applicationType: 'web' | 'native';
}

/** Why a registration is refused: a sentence, and the body field it is about. */
export interface RegistrationRefused {
  readonly detail: string;
  readonly field?: 'name' | 'redirectUris';
}

/**
 * A registration from untrusted input, or why it is refused. Each redirect
 * address is an https address on a public host, or an http one on
 * localhost, 127.0.0.1 or [::1] for an app running on the same machine, with
 * no fragment or credentials.
 */
export function appRegistrationOf(body: Readonly<Record<string, unknown>>): AppRegistration | RegistrationRefused {
  const unknown = Object.keys(body).filter((key) => key !== 'name' && key !== 'redirectUris');
  if (unknown.length > 0) return { detail: `unknown ${unknown.join(', ')}; send name and redirectUris` };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!NAME.test(name)) {
    return { detail: 'name is 1 to 64 letters, digits, spaces, dots, dashes or underscores', field: 'name' };
  }
  const given = body.redirectUris;
  if (!Array.isArray(given) || given.length === 0 || given.length > MOST_REDIRECTS) {
    return { detail: `redirectUris lists 1 to ${MOST_REDIRECTS} addresses`, field: 'redirectUris' };
  }
  let local = false;
  const redirectUris: string[] = [];
  for (const value of given as unknown[]) {
    const url = typeof value === 'string' && value.length <= 2048 ? urlOf(value) : null;
    const loopback = url !== null && LOOPBACK.has(url.hostname);
    // Written as its origin and then a path, so the address names the
    // origin the app runs at exactly as a browser sends it (isAppOrigin).
    const allowed =
      url !== null &&
      url.username === '' &&
      url.password === '' &&
      !String(value).includes('#') &&
      String(value).startsWith(`${url.origin}/`) &&
      ((url.protocol === 'https:' && !loopback) || (url.protocol === 'http:' && loopback));
    if (!allowed) {
      return {
        detail:
          'each redirect address is an https address, or an http one on localhost, 127.0.0.1 or [::1], written in lowercase with a path, such as https://app.example.com/callback, without a fragment',
        field: 'redirectUris',
      };
    }
    local ||= loopback;
    redirectUris.push(String(value));
  }
  if (new Set(redirectUris).size !== redirectUris.length) {
    return { detail: 'redirectUris lists each address once', field: 'redirectUris' };
  }
  return { name, redirectUris, applicationType: local ? 'native' : 'web' };
}

/** Marks a client the provider just created as a connected app of the workspace. */
export async function markApp(db: D1Database, clientId: string, workspaceId: string): Promise<void> {
  await db
    .prepare('UPDATE auth_oauth_client SET reference_id = ? WHERE client_id = ?')
    .bind(appReference(workspaceId), clientId)
    .run();
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
 * of a redirect address of an enabled connected app. A redirect address is
 * the app's own page, so its origin is where the app runs.
 */
export async function isAppOrigin(db: D1Database, origin: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM auth_oauth_client c
       WHERE substr(c.reference_id, 1, length(?1)) = ?1 AND coalesce(c.disabled, 0) = 0
         AND EXISTS (SELECT 1 FROM json_each(c.redirect_uris) r
           WHERE r.value = ?2 OR substr(r.value, 1, length(?2) + 1) = ?2 || '/')
       LIMIT 1`,
    )
    .bind(appReference(''), origin)
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

/** The strings of a JSON array column, or none. */
function stringsOf(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
