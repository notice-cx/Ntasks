/**
 * A workspace's GitHub webhook, kept in D1 (access_github_webhooks): the
 * secret GitHub signs each delivery with, and the names of the check runs
 * and deployment environments whose success means a change is live. The
 * workspace's owner saves them in Settings; the receiver (src/github.ts)
 * reads them for each delivery. The receiver needs the secret itself to
 * check a signature, so it is stored encrypted under a key derived from
 * AUTH_SECRET, and no answer, log or file ever holds it.
 */
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { hex, hmac } from './crypto.ts';

/** Where GitHub sends a workspace's deliveries. */
export const GITHUB_WEBHOOK_PATH = /^\/api\/github\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

export function githubWebhookUrl(origin: string, workspaceId: string): string {
  return `${origin}/api/github/${workspaceId}`;
}

/** The most deploy checks a workspace names, and the longest name GitHub gives a check run. */
export const DEPLOY_CHECKS = 20;
const CHECK_NAME_LENGTH = 255;

/** A webhook secret: 32 to 255 letters, digits and punctuation, as GitHub's webhook form takes it. */
const SECRET = /^[\x21-\x7e]{32,255}$/u;

/** A workspace's webhook, with its secret decrypted, as the receiver checks a delivery against it. */
export interface GitHubWebhook {
  readonly secret: string;
  readonly deployChecks: readonly string[];
}

/** The webhook as Settings shows it: where GitHub sends to, and never the secret. */
export interface GitHubWebhookView {
  readonly url: string;
  /** Whether a secret is saved that the receiver can use: false when none is, or it no longer decrypts. */
  readonly secretSaved: boolean;
  readonly deployChecks: readonly string[];
  readonly updatedAt: string | null;
}

/** What the owner saves: a new secret, new deploy checks, or both. */
export interface GitHubWebhookSettings {
  readonly secret?: string;
  readonly deployChecks?: readonly string[];
}

/** The key the secret is encrypted under: derived from AUTH_SECRET, for this use alone. */
async function secretKey(authSecret: string): Promise<string> {
  return hex(await hmac(authSecret, 'ntasks:github-webhook-secret'));
}

interface Row {
  readonly secret: string;
  readonly deploy_checks: string;
  readonly updated_at: string;
}

async function rowOf(db: D1Database, workspaceId: string): Promise<Row | null> {
  return db
    .prepare('SELECT secret, deploy_checks, updated_at FROM access_github_webhooks WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<Row>();
}

async function decrypted(authSecret: string, stored: string): Promise<string | null> {
  try {
    const secret = await symmetricDecrypt({ key: await secretKey(authSecret), data: stored });
    return SECRET.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

function checksOf(stored: string): string[] {
  const parsed: unknown = JSON.parse(stored);
  return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : [];
}

/** The workspace's webhook, or null when none is saved or its secret no longer decrypts under this AUTH_SECRET. */
export async function githubWebhookOf(
  db: D1Database,
  authSecret: string,
  workspaceId: string,
): Promise<GitHubWebhook | null> {
  const row = await rowOf(db, workspaceId);
  const secret = row === null ? null : await decrypted(authSecret, row.secret);
  if (row === null || secret === null) return null;
  return Object.freeze({ secret, deployChecks: Object.freeze(checksOf(row.deploy_checks)) });
}

/** The webhook as Settings shows it, at `origin`, this deployment's address. */
export async function githubWebhookView(
  db: D1Database,
  authSecret: string,
  workspaceId: string,
  origin: string,
): Promise<GitHubWebhookView> {
  const row = await rowOf(db, workspaceId);
  return {
    url: githubWebhookUrl(origin, workspaceId),
    secretSaved: row !== null && (await decrypted(authSecret, row.secret)) !== null,
    deployChecks: row === null ? [] : checksOf(row.deploy_checks),
    updatedAt: row?.updated_at ?? null,
  };
}

/** The settings a body names, or why it is refused, with the field it is about. */
export function githubWebhookSettingsOf(
  body: Record<string, unknown>,
): GitHubWebhookSettings | { readonly detail: string; readonly field?: string } {
  const unknown = Object.keys(body).filter((key) => key !== 'secret' && key !== 'deployChecks');
  if (unknown.length > 0) return { detail: `unknown ${unknown.join(', ')}; send secret, deployChecks or both` };
  if (body.secret === undefined && body.deployChecks === undefined) {
    return { detail: 'send secret, deployChecks or both' };
  }
  if (body.secret !== undefined && (typeof body.secret !== 'string' || !SECRET.test(body.secret))) {
    return {
      detail: 'secret is 32 to 255 letters, digits and punctuation, with no spaces, as you enter it in GitHub',
      field: 'secret',
    };
  }
  let deployChecks: string[] | undefined;
  if (body.deployChecks !== undefined) {
    const names = Array.isArray(body.deployChecks) ? body.deployChecks : null;
    const valid =
      names !== null &&
      names.length <= DEPLOY_CHECKS &&
      names.every(
        (name): name is string =>
          typeof name === 'string' && name.trim().length > 0 && name.trim().length <= CHECK_NAME_LENGTH,
      );
    if (!valid) {
      return {
        detail: `deployChecks is a list of at most ${DEPLOY_CHECKS} names, each 1 to ${CHECK_NAME_LENGTH} characters`,
        field: 'deployChecks',
      };
    }
    deployChecks = [...new Set(names.map((name) => name.trim()))];
  }
  return {
    ...(body.secret === undefined ? {} : { secret: body.secret as string }),
    ...(deployChecks === undefined ? {} : { deployChecks }),
  };
}

/**
 * Saves the workspace's webhook settings, for its owner `userId`. A secret
 * replaces the saved one; settings without one change only the deploy
 * checks, and are refused (false) while no secret is saved.
 */
export async function saveGitHubWebhook(
  db: D1Database,
  authSecret: string,
  workspaceId: string,
  settings: GitHubWebhookSettings,
  userId: string,
): Promise<boolean> {
  const at = new Date().toISOString();
  const checks = settings.deployChecks === undefined ? null : JSON.stringify(settings.deployChecks);
  if (settings.secret === undefined) {
    const updated = await db
      .prepare(
        `UPDATE access_github_webhooks SET deploy_checks = coalesce(?2, deploy_checks), updated_by = ?3, updated_at = ?4
         WHERE workspace_id = ?1`,
      )
      .bind(workspaceId, checks, userId, at)
      .run();
    return updated.meta.changes === 1;
  }
  const secret = await symmetricEncrypt({ key: await secretKey(authSecret), data: settings.secret });
  await db
    .prepare(
      `INSERT INTO access_github_webhooks (workspace_id, secret, deploy_checks, updated_by, updated_at)
       VALUES (?1, ?2, coalesce(?3, '[]'), ?4, ?5)
       ON CONFLICT (workspace_id) DO UPDATE SET secret = excluded.secret,
         deploy_checks = coalesce(?3, access_github_webhooks.deploy_checks),
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(workspaceId, secret, checks, userId, at)
    .run();
  return true;
}

/** Removes the workspace's webhook, after which every delivery is refused. False when none was saved. */
export async function removeGitHubWebhook(db: D1Database, workspaceId: string): Promise<boolean> {
  const removed = await db.prepare('DELETE FROM access_github_webhooks WHERE workspace_id = ?').bind(workspaceId).run();
  return removed.meta.changes === 1;
}
