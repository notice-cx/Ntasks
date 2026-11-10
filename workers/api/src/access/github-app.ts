/**
 * A workspace's GitHub App, which its owner creates with Connect GitHub in
 * Settings through GitHub's manifest flow
 * (docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
 * and installs on their account and organizations. Its webhook sends every
 * installed repository's events to the receiver (src/github.ts), signed with
 * the secret GitHub hands back when the app is made. D1 keeps the app, the
 * installations an owner made, and what deliveries showed: the deploy checks
 * that count as a deploy and the projects a deploy turned on
 * (migrations/0003_github_apps.sql).
 */
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { isSecure } from './config.ts';
import { base64url, hex, hmac, randomSecret, sameBytes, sha256 } from './crypto.ts';
import { githubWebhookUrl } from './github-webhook.ts';
import { cookieValue, manifestConversion } from './setup.ts';

/** Where GitHub sends the browser back with the code for the new app. */
export const GITHUB_APP_RETURN_PATH = '/api/access/github/app/created';
/** The web app's Settings page, where GitHub sends the browser after an installation. */
export const SETTINGS_PAGE = '/tasks/settings';
/** Where the browser posts the manifest: an app owned by the GitHub account signed in there. */
const GITHUB_NEW_APP = 'https://github.com/settings/apps/new';
/** How long the browser has from Connect GitHub to GitHub's code coming back. */
const STATE_SECONDS = 600;
/** GitHub's longest app name. */
const APP_NAME_LENGTH = 34;

/**
 * Check runs whose name starts with one of these are deploys: the checks a
 * hosting provider's GitHub App reports for a build it deployed.
 */
const DEPLOY_CHECK_PREFIXES = ['Workers Builds:', 'Cloudflare Pages'];

/**
 * The manifest of a workspace's app: it reads pull requests, checks and
 * deployments, and receives their events at the workspace's receiver. It is
 * public, because only a public app can be installed on an account other
 * than its owner's, such as an organization; the receiver refuses every
 * installation that an owner of the workspace did not make. Its name ends
 * in random characters, since GitHub app names are unique across GitHub.
 */
export function githubAppManifest(origin: string, workspaceId: string): string {
  const suffix = hex(crypto.getRandomValues(new Uint8Array(3)));
  return JSON.stringify({
    name: `${`Ntasks ${new URL(origin).host}`.slice(0, APP_NAME_LENGTH - suffix.length - 1)} ${suffix}`,
    description: `Tells the Ntasks at ${origin} when pull requests merge and deploys pass.`,
    url: origin,
    hook_attributes: { url: githubWebhookUrl(origin, workspaceId), active: true },
    redirect_url: origin + GITHUB_APP_RETURN_PATH,
    setup_url: origin + SETTINGS_PAGE,
    setup_on_update: true,
    public: true,
    default_permissions: { metadata: 'read', pull_requests: 'read', checks: 'read', deployments: 'read' },
    default_events: ['pull_request', 'check_run', 'deployment_status'],
  });
}

/** The cookie that binds Connect GitHub to the browser that pressed it: `__Host-` over https. */
function stateCookieName(origin: string): string {
  return isSecure(origin) ? '__Host-ntasks.github-app' : 'ntasks.github-app';
}

function stateCookie(origin: string, value: string, maxAge: number): string {
  const secure = isSecure(origin) ? '; Secure' : '';
  return `${stateCookieName(origin)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** The Set-Cookie that ends this browser's Connect GitHub, sent with every answer to GitHub's return. */
export function endGitHubAppCookie(origin: string): string {
  return stateCookie(origin, '', 0);
}

/** The state's signature: HMAC under AUTH_SECRET of the origin, the browser's cookie value, the workspace, the person and the expiry. */
async function stateSignature(
  secret: string,
  origin: string,
  binding: string,
  workspaceId: string,
  userId: string,
  expires: string,
): Promise<string> {
  return base64url(
    await hmac(secret, `ntasks:github-app-state:${origin}:${binding}:${workspaceId}:${userId}:${expires}`),
  );
}

/**
 * Connect GitHub for this browser: where it posts the manifest, with the
 * state GitHub carries back, and the cookie that binds that state to this
 * browser. The state names the workspace and its expiry and is signed with
 * the person, so only the owner who pressed Connect GitHub, in the same
 * browser, finishes it.
 */
export async function startGitHubApp(
  secret: string,
  origin: string,
  workspaceId: string,
  userId: string,
  now = Date.now(),
): Promise<{ readonly action: string; readonly manifest: string; readonly cookie: string }> {
  const binding = randomSecret(32);
  const expires = String(Math.floor(now / 1000) + STATE_SECONDS);
  const signature = await stateSignature(secret, origin, binding, workspaceId, userId, expires);
  const state = `${expires}.${workspaceId}.${signature}`;
  return {
    action: `${GITHUB_NEW_APP}?state=${encodeURIComponent(state)}`,
    manifest: githubAppManifest(origin, workspaceId),
    cookie: stateCookie(origin, binding, STATE_SECONDS),
  };
}

/**
 * The workspace GitHub's return finishes Connect GitHub for, when its state
 * is unexpired, signed for this origin, this browser's cookie and `userId`;
 * null otherwise.
 */
export async function gitHubAppStateOf(
  secret: string,
  origin: string,
  state: string,
  headers: Headers,
  userId: string,
  now = Date.now(),
): Promise<string | null> {
  const [expires, workspaceId, signature, extra] = state.split('.');
  if (!expires || !workspaceId || !signature || extra !== undefined || !/^[0-9]{1,12}$/u.test(expires)) return null;
  const binding = cookieValue(headers, stateCookieName(origin));
  if (!binding || Number(expires) * 1000 <= now) return null;
  // Hashed first, so the comparison is between two values of one length.
  const expected = await sha256(await stateSignature(secret, origin, binding, workspaceId, userId, expires));
  return sameBytes(await sha256(signature), expected) ? workspaceId : null;
}

/** The app GitHub made from the manifest: what the receiver and Settings use. */
export interface NewGitHubApp {
  readonly appId: number;
  readonly slug: string;
  readonly webhookSecret: string;
  readonly privateKey: string;
}

/** Exchanges GitHub's code for the new app's id, name, webhook secret and private key; null when GitHub gives no app. */
export async function convertGitHubApp(code: string): Promise<NewGitHubApp | null> {
  const body = await manifestConversion(code);
  if (body === null) return null;
  const { id, slug, webhook_secret: webhookSecret, pem } = body;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return null;
  if (typeof slug !== 'string' || !/^[a-z0-9-]{1,100}$/u.test(slug)) return null;
  if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) return null;
  if (typeof pem !== 'string' || pem.length === 0) return null;
  return { appId: id, slug, webhookSecret, privateKey: pem };
}

/** The key the app's credentials are encrypted under: derived from AUTH_SECRET, for this use alone. */
async function credentialsKey(authSecret: string): Promise<string> {
  return hex(await hmac(authSecret, 'ntasks:github-delivery-app'));
}

/**
 * Stores the workspace's app, made by the owner `userId`. A new app
 * replaces the one before, whose installations, made for the old app, go
 * with it.
 */
export async function saveGitHubApp(
  db: D1Database,
  authSecret: string,
  workspaceId: string,
  app: NewGitHubApp,
  userId: string,
): Promise<void> {
  const credentials = await symmetricEncrypt({
    key: await credentialsKey(authSecret),
    data: JSON.stringify({ webhookSecret: app.webhookSecret, privateKey: app.privateKey }),
  });
  await db.batch([
    db.prepare('DELETE FROM access_github_installations WHERE workspace_id = ?').bind(workspaceId),
    db
      .prepare(
        `INSERT INTO access_github_apps (workspace_id, app_id, slug, credentials, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (workspace_id) DO UPDATE SET app_id = excluded.app_id, slug = excluded.slug,
           credentials = excluded.credentials, created_by = excluded.created_by, created_at = excluded.created_at`,
      )
      .bind(workspaceId, app.appId, app.slug, credentials, userId, new Date().toISOString()),
  ]);
}

/** Forgets the workspace's app and its installations; false when it has none. */
export async function removeGitHubApp(db: D1Database, workspaceId: string): Promise<boolean> {
  const [, removed] = await db.batch([
    db.prepare('DELETE FROM access_github_installations WHERE workspace_id = ?').bind(workspaceId),
    db.prepare('DELETE FROM access_github_apps WHERE workspace_id = ?').bind(workspaceId),
  ]);
  return removed?.meta.changes === 1;
}

/** The workspace's app as the receiver checks a delivery: its slug and webhook secret. */
/** The workspace's app as the receiver checks a delivery and Ntasks calls GitHub: its id, slug, webhook secret and private key. */
export interface GitHubApp {
  readonly appId: number;
  readonly slug: string;
  readonly webhookSecret: string;
  readonly privateKey: string;
}

/** The workspace's app, or null when it has none or its credentials no longer decrypt under this AUTH_SECRET. */
export async function githubAppOf(db: D1Database, authSecret: string, workspaceId: string): Promise<GitHubApp | null> {
  const row = await db
    .prepare('SELECT app_id, slug, credentials FROM access_github_apps WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<{ app_id: number; slug: string; credentials: string }>();
  if (row === null) return null;
  try {
    const parsed = JSON.parse(
      await symmetricDecrypt({ key: await credentialsKey(authSecret), data: row.credentials }),
    ) as Record<string, unknown> | null;
    const webhookSecret = parsed?.webhookSecret;
    const privateKey = parsed?.privateKey;
    if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) return null;
    if (typeof privateKey !== 'string' || privateKey.length === 0) return null;
    return { appId: row.app_id, slug: row.slug, webhookSecret, privateKey };
  } catch {
    return null;
  }
}

/** The workspace's installations by the lowercase login of the account each is on. */
export async function installationsByAccount(
  db: D1Database,
  workspaceId: string,
): Promise<ReadonlyMap<string, number>> {
  const { results } = await db
    .prepare('SELECT installation_id, account FROM access_github_installations WHERE workspace_id = ?')
    .bind(workspaceId)
    .all<{ installation_id: number; account: string }>();
  return new Map(results.map((row) => [row.account.toLowerCase(), row.installation_id]));
}

/** Whether the GitHub account `githubId` (a numeric id) belongs to an owner of the workspace. */
export async function isOwnerOnGitHub(db: D1Database, workspaceId: string, githubId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS owner FROM auth_account a
       JOIN workspace_members m ON m.user_id = a.user_id AND m.workspace_id = ?1 AND m.role = 'owner'
       WHERE a.provider_id = 'github' AND a.account_id = ?2`,
    )
    .bind(workspaceId, githubId)
    .first<{ owner: number }>();
  return row !== null;
}

/** The numeric GitHub id of the person `userId` signed in with, or null. */
export async function githubIdOf(db: D1Database, userId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT account_id FROM auth_account WHERE provider_id = 'github' AND user_id = ?")
    .bind(userId)
    .first<{ account_id: string }>();
  return row?.account_id ?? null;
}

/** An installation of the workspace's app, as GitHub's installation event names it. */
export interface GitHubInstallation {
  readonly installationId: number;
  readonly account: string;
  readonly accountType: string;
  readonly installedBy: string;
}

/** Records an installation an owner of the workspace made. */
export async function addInstallation(
  db: D1Database,
  workspaceId: string,
  installation: GitHubInstallation,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO access_github_installations (workspace_id, installation_id, account, account_type, installed_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (workspace_id, installation_id) DO UPDATE SET account = excluded.account,
         account_type = excluded.account_type`,
    )
    .bind(
      workspaceId,
      installation.installationId,
      installation.account,
      installation.accountType,
      installation.installedBy,
      new Date().toISOString(),
    )
    .run();
}

/** Forgets an installation, once GitHub says it was removed or suspended. */
export async function removeInstallation(db: D1Database, workspaceId: string, installationId: number): Promise<void> {
  await db
    .prepare('DELETE FROM access_github_installations WHERE workspace_id = ? AND installation_id = ?')
    .bind(workspaceId, installationId)
    .run();
}

/** Whether an owner of the workspace made this installation of its app. */
export async function hasInstallation(db: D1Database, workspaceId: string, installationId: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS known FROM access_github_installations WHERE workspace_id = ? AND installation_id = ?')
    .bind(workspaceId, installationId)
    .first<{ known: number }>();
  return row !== null;
}

/** Whether a check run's name is one a hosting provider gives a deploy. */
export function isDeployCheck(name: string): boolean {
  return DEPLOY_CHECK_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** What deliveries showed the workspace: each deploy check with whether it counts, and the projects a deploy turned on. */
export interface Detected {
  readonly checks: ReadonlyMap<string, { readonly on: boolean; readonly seenAt: string }>;
  readonly projects: readonly string[];
}

export async function detectedOf(db: D1Database, workspaceId: string): Promise<Detected> {
  const { results } = await db
    .prepare('SELECT kind, name, off, seen_at FROM access_github_detected WHERE workspace_id = ? ORDER BY name')
    .bind(workspaceId)
    .all<{ kind: string; name: string; off: number; seen_at: string }>();
  return {
    checks: new Map(
      results
        .filter((row) => row.kind === 'check')
        .map((row) => [row.name, { on: row.off === 0, seenAt: row.seen_at }]),
    ),
    projects: results.filter((row) => row.kind === 'project').map((row) => row.name),
  };
}

/** The names that count as deploys: the ones typed by hand, and the ones deliveries showed, each on or off. */
export interface DeployNames {
  readonly typed: readonly string[];
  readonly detected: Detected['checks'];
}

/**
 * Whether a check run or deployment named `name` is a deploy: typed by hand,
 * or detected and not switched off. `looksLikeOne` says whether a name not
 * seen before is a deploy, which is then recorded.
 */
export function deployOf(name: string, names: DeployNames, looksLikeOne: boolean): 'yes' | 'new' | 'off' | 'no' {
  if (names.typed.includes(name)) return 'yes';
  const seen = names.detected.get(name);
  if (seen !== undefined) return seen.on ? 'yes' : 'off';
  return looksLikeOne ? 'new' : 'no';
}

/**
 * Whether a passing deploy check, by the branch GitHub ran its check suite
 * for, can be the deploy of its commit: one on the default branch is; one on
 * the merge queue's branch is only when it started after the merge, since
 * one that started before was a preview; one on any other branch is not.
 * GitHub keeps one check suite per app and commit, named for the branch first
 * pushed with it: for a commit the merge queue landed, the queue's branch,
 * which holds exactly that commit.
 */
export function deployBranchOf(branch: string | null | undefined, defaultBranch: string): 'default' | 'queue' | null {
  if (branch === defaultBranch) return 'default';
  return branch?.startsWith(`gh-readonly-queue/${defaultBranch}/`) === true ? 'queue' : null;
}

/** Records what a delivery showed: a deploy check seen for the first time, and projects a deploy turned on. */
export async function recordDetected(
  db: D1Database,
  workspaceId: string,
  found: { readonly checks?: readonly string[]; readonly projects?: readonly string[] },
): Promise<void> {
  const at = new Date().toISOString();
  const statement = (kind: string, name: string) =>
    db
      .prepare(
        `INSERT INTO access_github_detected (workspace_id, kind, name, off, seen_at) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT (workspace_id, kind, name) DO NOTHING`,
      )
      .bind(workspaceId, kind, name, at);
  // The table holds names of 1 to 255 characters; GitHub's run and environment names fit, and any other is left out.
  const fits = (name: string) => name.length >= 1 && name.length <= 255;
  const statements = [
    ...(found.checks ?? []).filter(fits).map((name) => statement('check', name)),
    ...(found.projects ?? []).filter(fits).map((id) => statement('project', id)),
  ];
  if (statements.length > 0) await db.batch(statements);
}

/** Switches a detected deploy check on or off; false when no delivery showed it. */
export async function setDeployCheck(db: D1Database, workspaceId: string, name: string, on: boolean): Promise<boolean> {
  const changed = await db
    .prepare("UPDATE access_github_detected SET off = ? WHERE workspace_id = ? AND kind = 'check' AND name = ?")
    .bind(on ? 0 : 1, workspaceId, name)
    .run();
  return changed.meta.changes === 1;
}

/** The app's page on GitHub, and its install pages: one for an account the person picks, one for their own. */
export function githubAppLinks(slug: string, githubId: string | null) {
  const url = `https://github.com/apps/${slug}`;
  return {
    url,
    installUrl: `${url}/installations/new`,
    accountInstallUrl:
      githubId === null ? `${url}/installations/new` : `${url}/installations/new/permissions?target_id=${githubId}`,
  };
}

/** The app as Settings shows it, for the person whose GitHub id is `githubId`: null before Connect GitHub. */
export async function githubAppView(db: D1Database, workspaceId: string, githubId: string | null) {
  const [apps, installations, detected] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT slug, created_at FROM access_github_apps WHERE workspace_id = ?').bind(workspaceId),
    db
      .prepare(
        `SELECT installation_id, account, account_type, created_at FROM access_github_installations
         WHERE workspace_id = ? ORDER BY account`,
      )
      .bind(workspaceId),
    db
      .prepare(
        "SELECT name, off, seen_at FROM access_github_detected WHERE workspace_id = ? AND kind = 'check' ORDER BY name",
      )
      .bind(workspaceId),
  ]);
  const app = apps?.results[0] as { slug: string; created_at: string } | undefined;
  return {
    app:
      app === undefined ? null : { slug: app.slug, createdAt: app.created_at, ...githubAppLinks(app.slug, githubId) },
    installations: (
      (installations?.results ?? []) as {
        installation_id: number;
        account: string;
        account_type: string;
        created_at: string;
      }[]
    ).map((row) => ({
      installationId: row.installation_id,
      account: row.account,
      accountType: row.account_type,
      createdAt: row.created_at,
    })),
    detected: ((detected?.results ?? []) as { name: string; off: number; seen_at: string }[]).map((row) => ({
      name: row.name,
      on: row.off === 0,
      seenAt: row.seen_at,
    })),
  };
}
