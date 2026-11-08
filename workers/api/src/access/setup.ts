/**
 * The parts of the setup page that are not pages or routes: the GitHub App
 * manifest it sends, the state that binds the manifest flow to the browser
 * that started it, and the exchange of GitHub's code for the app's
 * credentials. GitHub's manifest flow is documented at
 * docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest.
 * routes.ts runs the steps, config.ts stores the app.
 */
import { isSecure, type GitHubClient } from './config.ts';
import { base64url, hmac, randomSecret, sameBytes, sha256 } from './crypto.ts';
import { AUTH_BASE_PATH, SIGN_IN_PAGE } from './protocol.ts';

/** Where the browser posts the manifest: an app owned by the GitHub account signed in there. */
export const GITHUB_NEW_APP = 'https://github.com/settings/apps/new';
/** How long the browser has from the setup page to GitHub's code coming back. */
const STATE_SECONDS = 600;
/** GitHub's longest app name. */
const APP_NAME_LENGTH = 34;

/**
 * The manifest of the app: this origin as its homepage, its OAuth callback
 * and the address GitHub returns the code to. It is public, because only a
 * public app can be authorized by GitHub accounts other than its owner's,
 * such as invited members. It asks for one permission, reading the account's
 * email addresses, which sign-in reads with the profile; no repository or
 * organization permission. Its webhook is off; GitHub requires an address
 * for one, so it names the origin.
 */
export function manifestFor(origin: string): string {
  return JSON.stringify({
    name: `Ntasks ${new URL(origin).host}`.slice(0, APP_NAME_LENGTH),
    description: `Sign-in for the Ntasks deployment at ${origin}`,
    url: origin,
    redirect_url: origin + SIGN_IN_PAGE,
    callback_urls: [`${origin}${AUTH_BASE_PATH}/callback/github`],
    public: true,
    request_oauth_on_install: false,
    hook_attributes: { url: origin, active: false },
    default_permissions: { email_addresses: 'read' },
  });
}

/** The cookie that holds the random value binding a setup to the browser that started it: `__Host-` over https. */
function setupCookieName(origin: string): string {
  return isSecure(origin) ? '__Host-ntasks.setup' : 'ntasks.setup';
}

function setupCookie(origin: string, value: string, maxAge: number): string {
  const secure = isSecure(origin) ? '; Secure' : '';
  return `${setupCookieName(origin)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** The Set-Cookie that ends this browser's setup: every answer to GitHub's return sends it, so a state works once. */
export function endSetupCookie(origin: string): string {
  return setupCookie(origin, '', 0);
}

/** The state's signature: HMAC under AUTH_SECRET of the origin, the browser's cookie value and the expiry. */
async function stateSignature(secret: string, origin: string, binding: string, expires: string): Promise<string> {
  return base64url(await hmac(secret, `ntasks:setup-state:${origin}:${binding}:${expires}`));
}

/**
 * A new setup for this browser: a random value for its setup cookie, and
 * the state GitHub carries to its return, which holds the expiry and a
 * signature over the origin, that value and the expiry. The value itself is
 * never in the state or a URL, so whoever sees the state cannot finish the
 * setup in another browser. The cookie is Lax, so it comes back on GitHub's
 * redirect, a top-level GET.
 */
export async function startSetupState(
  secret: string,
  origin: string,
  now = Date.now(),
): Promise<{ readonly state: string; readonly cookie: string }> {
  const binding = randomSecret(32);
  const expires = String(Math.floor(now / 1000) + STATE_SECONDS);
  const state = `${expires}.${await stateSignature(secret, origin, binding, expires)}`;
  return { state, cookie: setupCookie(origin, binding, STATE_SECONDS) };
}

/**
 * Whether GitHub's return carries an unexpired state this deployment signed
 * for this origin and for the value this browser's setup cookie holds. A
 * state from another browser, a changed one, or one used before, whose
 * cookie is gone, is refused.
 */
export async function setupStateHolds(
  secret: string,
  origin: string,
  state: string,
  headers: Headers,
  now = Date.now(),
): Promise<boolean> {
  const [expires, signature, extra] = state.split('.');
  if (!expires || !signature || extra !== undefined || !/^[0-9]{1,12}$/u.test(expires)) return false;
  const binding = cookieValue(headers, setupCookieName(origin));
  if (!binding || Number(expires) * 1000 <= now) return false;
  // Hashed first, so the comparison is between two values of one length.
  const expected = await sha256(await stateSignature(secret, origin, binding, expires));
  return sameBytes(await sha256(signature), expected);
}

function cookieValue(headers: Headers, name: string): string | null {
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

/** The new app: its credentials, and the numeric id of the GitHub account that owns it. */
export interface ConvertedApp {
  readonly github: GitHubClient;
  readonly ownerId: string;
}

/**
 * Exchanges the code GitHub returned for the app's client id and client
 * secret (`POST /app-manifests/{code}/conversions`, which needs no token).
 * The answer also holds the app's private key and webhook secret, which
 * Ntasks does not use or keep. Null when the code is malformed or GitHub
 * does not answer with an app.
 */
export async function convertManifest(code: string): Promise<ConvertedApp | null> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(code)) return null;
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'Ntasks',
        'x-github-api-version': '2022-11-28',
      },
    });
  } catch {
    return null;
  }
  if (response.status !== 201) {
    await response.body?.cancel();
    return null;
  }
  const body: unknown = await response.json().catch(() => null);
  if (body === null || typeof body !== 'object') return null;
  const { client_id: clientId, client_secret: clientSecret, owner } = body as Record<string, unknown>;
  const ownerId = owner !== null && typeof owner === 'object' ? (owner as Record<string, unknown>).id : undefined;
  if (typeof clientId !== 'string' || clientId.length === 0) return null;
  if (typeof clientSecret !== 'string' || clientSecret.length === 0) return null;
  if (typeof ownerId !== 'number' || !Number.isSafeInteger(ownerId) || ownerId < 1) return null;
  return { github: { clientId, clientSecret }, ownerId: String(ownerId) };
}
