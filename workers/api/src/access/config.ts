/**
 * The deployment's sign-in settings. AUTH_SECRET is always a secret. The
 * GitHub app people sign in through, and the origin it is registered for,
 * come from the secrets NTASKS_ORIGIN, GITHUB_CLIENT_ID and
 * GITHUB_CLIENT_SECRET when they are set; otherwise from the GitHub App the
 * setup page registered (setup.ts), stored in D1 encrypted under a key
 * derived from AUTH_SECRET. Every value is checked; a missing or malformed
 * one turns sign-in off, and with it every call that needs a signed-in
 * sender. Ntasks never falls back to no checks.
 */
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { hex, hmac } from './crypto.ts';

export interface SignInConfig {
  /** Where the deployment is reached, such as https://ntasks.example.com. The OAuth issuer and cookies are bound to it. */
  readonly origin: string;
  /** Whether cookies carry the Secure flag and the __Secure- prefix: true unless the origin is a local http one. */
  readonly secure: boolean;
  /** Better Auth's secret: signs session cookies and sign-in state. */
  readonly secret: string;
  /** The GitHub app people sign in through. */
  readonly github: GitHubClient;
  /** The GitHub user ids in OWNER_GITHUB_IDS, the numbers. They and the admins the setup page recorded always sign in and create workspaces. Logins can be renamed and reused, ids cannot. */
  readonly owners: ReadonlySet<string>;
}

export interface GitHubClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The secrets sign-in reads. wrangler.jsonc requires AUTH_SECRET; the others are optional. */
export interface SignInSecrets {
  readonly NTASKS_ORIGIN?: string;
  readonly AUTH_SECRET?: string;
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  readonly OWNER_GITHUB_IDS?: string;
}

/** What the secrets set. */
export interface Secrets {
  readonly secret: string;
  /** OWNER_GITHUB_IDS; empty when it is unset. */
  readonly owners: ReadonlySet<string>;
  /** The GitHub OAuth app the secrets name, with its origin; null when they name none and the setup page registers one. */
  readonly app: { readonly origin: string; readonly github: GitHubClient } | null;
}

/** Where sign-in stands: on, waiting for the setup page, or off because a secret is missing or malformed. */
export type SignIn =
  | { readonly state: 'on'; readonly config: SignInConfig }
  | {
      readonly state: 'setup';
      readonly secrets: Secrets;
      /** The stored credentials that no longer decrypt, which a new setup replaces; null when none are stored. */
      readonly stale: string | null;
    }
  | { readonly state: 'off' };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The value as an origin, or null unless it is exactly an https origin or a local http one. */
export function originOf(value: string | undefined | null): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // The value must be an origin exactly: no path, query, credentials or trailing slash.
  if (url.origin !== value || url.username || url.password) return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url.origin;
  return null;
}

/** Whether cookies at this origin carry the Secure flag: every origin but a local http one. */
export function isSecure(origin: string): boolean {
  return origin.startsWith('https:');
}

/** GitHub user ids from a list split by commas or spaces, or null when it holds anything but ids. */
function ownersOf(value: string | undefined): ReadonlySet<string> | null {
  const ids = (value ?? '').split(/[\s,]+/u).filter((id) => id.length > 0);
  if (!ids.every((id) => /^[1-9][0-9]{0,19}$/u.test(id))) return null;
  return new Set(ids);
}

/**
 * The secrets, or null when sign-in is off: AUTH_SECRET is missing or
 * shorter than 32 characters, OWNER_GITHUB_IDS holds anything but ids, or
 * NTASKS_ORIGIN, GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not either
 * all unset or all set and valid.
 */
export function signInSecrets(env: SignInSecrets): Secrets | null {
  const secret = env.AUTH_SECRET ?? '';
  const owners = ownersOf(env.OWNER_GITHUB_IDS);
  if (secret.length < 32 || !owners) return null;
  const named = [env.NTASKS_ORIGIN, env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET].filter(Boolean).length;
  if (named === 0) return Object.freeze({ secret, owners, app: null });
  const origin = originOf(env.NTASKS_ORIGIN);
  const clientId = env.GITHUB_CLIENT_ID ?? '';
  const clientSecret = env.GITHUB_CLIENT_SECRET ?? '';
  if (!origin || clientId.length === 0 || clientSecret.length === 0) return null;
  return Object.freeze({
    secret,
    owners,
    app: Object.freeze({ origin, github: Object.freeze({ clientId, clientSecret }) }),
  });
}

function configOf(secrets: Secrets, origin: string, github: GitHubClient): SignInConfig {
  return Object.freeze({ origin, secure: isSecure(origin), secret: secrets.secret, github, owners: secrets.owners });
}

/** The key the stored app's credentials are encrypted under: derived from AUTH_SECRET, for this use alone. */
async function credentialsKey(secret: string): Promise<string> {
  return hex(await hmac(secret, 'ntasks:github-app-credentials'));
}

/** The stored credentials, or null when they do not decrypt under this AUTH_SECRET. */
async function decryptCredentials(secret: string, credentials: string): Promise<GitHubClient | null> {
  try {
    const parsed: unknown = JSON.parse(
      await symmetricDecrypt({ key: await credentialsKey(secret), data: credentials }),
    );
    if (parsed === null || typeof parsed !== 'object') return null;
    const { clientId, clientSecret } = parsed as Record<string, unknown>;
    if (typeof clientId !== 'string' || typeof clientSecret !== 'string') return null;
    return Object.freeze({ clientId, clientSecret });
  } catch {
    return null;
  }
}

/**
 * Where sign-in stands, with its settings when it is on. The secrets win
 * when they name a GitHub app; otherwise the stored app is read, which costs
 * one D1 query.
 */
export async function loadSignIn(env: SignInSecrets & { readonly DB: D1Database }): Promise<SignIn> {
  const secrets = signInSecrets(env);
  if (!secrets) return { state: 'off' };
  if (secrets.app) return { state: 'on', config: configOf(secrets, secrets.app.origin, secrets.app.github) };
  const row = await env.DB.prepare('SELECT origin, credentials FROM access_github_app').first<{
    origin: string;
    credentials: string;
  }>();
  const origin = originOf(row?.origin);
  const github = row && origin ? await decryptCredentials(secrets.secret, row.credentials) : null;
  if (origin && github) return { state: 'on', config: configOf(secrets, origin, github) };
  return { state: 'setup', secrets, stale: row?.credentials ?? null };
}

/** The origin of the stored app, which the token verifier uses when the secrets name none; null when none is stored. */
export async function storedOrigin(db: D1Database): Promise<string | null> {
  const row = await db.prepare('SELECT origin FROM access_github_app').first<{ origin: string }>();
  return originOf(row?.origin);
}

/**
 * Stores the app the setup registered, with the GitHub account that
 * registered it as the deployment admin the setup records, in one
 * statement. Replacing an app replaces that admin too, so an account that
 * ran an earlier setup, perhaps with a leaked AUTH_SECRET, is no admin after
 * the next one. It writes only while the stored app is still `stale`, the
 * one this setup found (null for none), so of two setups that finish at once
 * one stores its app and the other writes nothing. False when this one wrote
 * nothing.
 */
export async function storeGitHubApp(
  db: D1Database,
  secrets: Secrets,
  app: { readonly origin: string; readonly github: GitHubClient; readonly adminGithubId: string },
  stale: string | null,
): Promise<boolean> {
  const credentials = await symmetricEncrypt({
    key: await credentialsKey(secrets.secret),
    data: JSON.stringify({ clientId: app.github.clientId, clientSecret: app.github.clientSecret }),
  });
  const stored = await db
    .prepare(
      `INSERT INTO access_github_app (id, origin, credentials, admin_github_id, created_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET origin = excluded.origin, credentials = excluded.credentials,
         admin_github_id = excluded.admin_github_id, created_at = excluded.created_at
       WHERE access_github_app.credentials IS ?`,
    )
    .bind(app.origin, credentials, app.adminGithubId, new Date().toISOString(), stale)
    .run();
  return stored.meta.changes === 1;
}
