/**
 * The deployment's sign-in settings, read from its secrets. Every value is
 * checked; a missing or malformed one turns sign-in off, and with it every
 * call that needs a signed-in sender. Ntasks never falls back to no checks.
 */

export interface SignInConfig {
  /** Where the deployment is reached, such as https://ntasks.example.com. The OAuth issuer and cookies are bound to it. */
  readonly origin: string;
  /** Whether cookies carry the Secure flag and the __Secure- prefix: true unless the origin is a local http one. */
  readonly secure: boolean;
  /** Better Auth's secret: signs session cookies and sign-in state. */
  readonly secret: string;
  /** The GitHub OAuth app the owner signs in through. */
  readonly github: { readonly clientId: string; readonly clientSecret: string };
  /** GitHub user ids, the numbers, allowed to sign in. Logins can be renamed and reused, ids cannot. */
  readonly owners: ReadonlySet<string>;
}

/** The secrets sign-in reads, as wrangler.jsonc's `secrets.required` lists them. */
export interface SignInSecrets {
  readonly NTASKS_ORIGIN?: string;
  readonly AUTH_SECRET?: string;
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  readonly OWNER_GITHUB_IDS?: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function originOf(value: string | undefined): { origin: string; secure: boolean } | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // The value must be an origin exactly: no path, query, credentials or trailing slash.
  if (url.origin !== value || url.username || url.password) return null;
  if (url.protocol === 'https:') return { origin: url.origin, secure: true };
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return { origin: url.origin, secure: false };
  return null;
}

function ownersOf(value: string | undefined): ReadonlySet<string> | null {
  if (!value) return null;
  const ids = value.split(/[\s,]+/u).filter((id) => id.length > 0);
  if (ids.length === 0 || !ids.every((id) => /^[1-9][0-9]{0,19}$/u.test(id))) return null;
  return new Set(ids);
}

/** The settings, or null when sign-in is not configured. */
export function signInConfig(env: SignInSecrets): SignInConfig | null {
  const origin = originOf(env.NTASKS_ORIGIN);
  const owners = ownersOf(env.OWNER_GITHUB_IDS);
  const secret = env.AUTH_SECRET ?? '';
  const clientId = env.GITHUB_CLIENT_ID ?? '';
  const clientSecret = env.GITHUB_CLIENT_SECRET ?? '';
  if (!origin || !owners || secret.length < 32 || clientId.length === 0 || clientSecret.length === 0) return null;
  return Object.freeze({
    origin: origin.origin,
    secure: origin.secure,
    secret,
    github: Object.freeze({ clientId, clientSecret }),
    owners,
  });
}
